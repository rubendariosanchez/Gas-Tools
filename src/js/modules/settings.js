/**
 * @fileoverview Módulo "Settings" del popup: persistencia y reset.
 *
 * El pintado lo hace `settings-renderer.js` a partir de `SETTINGS_SCHEMA`.
 * Aquí se escuchan los eventos de los componentes marcados con
 * `data-setting-key`, se guarda en IndexedDB (singleton `DB`, cola
 * serializada) o en chrome.storage.sync (`storage: 'sync'`) y se notifica
 * a los editores activos vía `notifyEditors()` sin recargar.
 *
 * También aloja el sub-módulo "Contexto global" de IA (guardado automático).
 */

import {
    G_PROPERTY_NAME, SETTINGS_SCHEMA, normalizeSettings, settingsDiffer, isStoredSetting, getSchemaDefaults,
} from '../utils/Variables.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { updateAboutStats_ } from './ui.js';
import { renderSettings, applySettingValues } from './settings-renderer.js';
import { DB } from '../utils/Storage.js';
import { notifyEditors } from '../utils/Notify.js';
import { createWriteQueue } from '../utils/WriteQueue.js';
import { tr } from '../utils/I18n.js';

// Serializa los read-modify-write de settings: dos toggles rápidos no se pisan.
const G_SETTINGS_WRITE_QUEUE = createWriteQueue();

// Pestañas que restablece "Restablecer ajustes" (el resto se conserva).
const RESET_TABS_ = ['editor', 'tools'];

// Eventos de los componentes → forma de leer su valor.
const CONTROL_EVENTS_ = {
    toggle: (e) => e.detail.checked,
    select: (e) => e.detail.value,
    'color-change': (e) => e.detail.value,
};

// Mensaje de error por tipo de control.
const SAVE_ERROR_KEYS_ = {
    toggle: ['toastErrorSavingSetting', 'Error saving setting'],
    select: ['toastErrorSavingSetting', 'Error saving setting'],
    color: ['toastErrorSavingColor', 'Error saving color'],
};

/**
 * Inicializa el módulo de configuración: pinta, carga datos, bindea reset y auto-guardado.
 * @returns {void}
 */
export function initSettingsModule() {
    renderSettings(document);
    loadQualityCodeSettings_();
    initActionButtons_();
    initAutoSave_();
}

/**
 * Auto-guardado: cada cambio de un control del esquema se persiste al instante (sin toast de éxito).
 * @returns {void}
 * @private
 */
function initAutoSave_() {
    Object.entries(CONTROL_EVENTS_).forEach(([eventName, readValue]) => {
        document.addEventListener(eventName, async (e) => {
            const key = e.target?.dataset?.settingKey;
            const entry = key && SETTINGS_SCHEMA.find((item) => item.key === key);
            if (!entry) return;

            try {
                await saveSchemaValue_(entry, readValue(e));
            } catch (error) {
                console.error('[Settings] Auto-save error:', error);
                const [msgKey, fallback] = SAVE_ERROR_KEYS_[entry.type];
                Toast.show(tr(msgKey, fallback), 'error');
            }
        });
    });
}

/**
 * Guarda el valor de una entrada del esquema en su almacenamiento.
 * @param {Object} entry Entrada de SETTINGS_SCHEMA.
 * @param {*} value Nuevo valor.
 * @returns {Promise<void>}
 * @throws {Error} Si el almacenamiento falla.
 * @private
 */
async function saveSchemaValue_(entry, value) {
    if (isStoredSetting(entry)) return saveSingleOption_(entry.key, value);
    // chrome.storage.sync: el background lo lee en cada uso, sin notificar.
    await chrome.storage.sync.set({ [entry.storageKey]: value || entry.default });
}

/**
 * Guarda una única opción en IndexedDB (serializado) y notifica solo el delta.
 * @param {string} optionId Clave de la opción.
 * @param {*} value Nuevo valor.
 * @returns {Promise<void>}
 * @throws {Error} Si IndexedDB falla al leer o escribir.
 */
export function saveSingleOption_(optionId, value) {
    return G_SETTINGS_WRITE_QUEUE(async () => {
        const currentData = await DB.get('settings', G_PROPERTY_NAME) || {};
        const currentOptions = currentData?.options || {};

        // Se actualiza la opción seleccionada
        const updatedOptions = {
            ...currentOptions,
            [optionId]: value
        };

        // Se construye el payload; `lastUpdated` lo lee la pestaña About.
        const payload = {
            id: G_PROPERTY_NAME,
            ...currentData,
            options: updatedOptions,
            lastUpdated: new Date().toISOString()
        };

        // Guardamos en IndexedDB y esperamos a que la notificación llegue al background
        await DB.set('settings', payload);
        await notifyEditors('settings', { [optionId]: value }, updatedOptions);
    });
}

/**
 * Carga las opciones (IndexedDB + sync), las aplica a los controles y emite `gt-settings-loaded`.
 * @returns {Promise<void>}
 * @private
 */
async function loadQualityCodeSettings_() {
    try {
        const settings = await G_SETTINGS_WRITE_QUEUE(loadNormalizedOptions_);
        const syncValues = await loadSyncValues_();
        applySettingValues({ ...settings, ...syncValues });
        document.dispatchEvent(new CustomEvent('gt-settings-loaded', { detail: settings }));
    } catch (error) {
        console.error('Error loading settings:', error);
        Toast.show(tr('toastErrorLoadingSettings', 'Error loading settings'), 'error');
    }
}

/**
 * Lee de chrome.storage.sync las entradas del esquema con `storage: 'sync'`.
 * @returns {Promise<Object>} Mapa clave del esquema → valor (o default).
 * @private
 */
async function loadSyncValues_() {
    const entries = SETTINGS_SCHEMA.filter((e) => !isStoredSetting(e));
    if (!entries.length) return {};
    try {
        const result = await chrome.storage.sync.get(entries.map((e) => e.storageKey));
        return Object.fromEntries(entries.map((e) => [e.key, result?.[e.storageKey] || e.default]));
    } catch (err) {
        console.error('[Settings] Error loading sync values:', err);
        return Object.fromEntries(entries.map((e) => [e.key, e.default]));
    }
}

/**
 * Lee las opciones, las normaliza y persiste solo si la normalización cambió algo.
 * @returns {Promise<Object>} Opciones normalizadas.
 * @throws {Error} Si IndexedDB falla.
 * @private
 */
async function loadNormalizedOptions_() {
    const settingsData = await DB.get('settings', G_PROPERTY_NAME);
    const options = normalizeSettings(settingsData?.options);
    if (settingsData && !settingsDiffer(settingsData.options, options)) return options;

    const payload = {
        ...(settingsData || {}),
        id: G_PROPERTY_NAME,
        options,
        lastUpdated: settingsData?.lastUpdated || new Date().toISOString()
    };
    await DB.set('settings', payload);
    await notifyEditors('settings', null, options);
    return options;
}

/**
 * Configura los listeners para el botón de Restablecer.
 * @returns {void}
 * @private
 */
function initActionButtons_() {
    document.getElementById('resetBtn')?.addEventListener('click', () => resetSettings_());
}

/**
 * Restablece a sus defaults solo los ajustes de Editor y Herramientas.
 * Idioma, interruptor general, IA, modo oscuro, snippets y temas se conservan.
 * @returns {Promise<void>}
 * @private
 */
async function resetSettings_() {
    if (!await ConfirmDialog(tr('confirmResetEditorTools', 'Reset the Editor and Tools settings to their defaults?'))) return;
    try {
        const options = await G_SETTINGS_WRITE_QUEUE(async () => {
            const currentData = await DB.get('settings', G_PROPERTY_NAME) || {};
            const payload = {
                id: G_PROPERTY_NAME,
                ...currentData,
                options: normalizeSettings({ ...currentData?.options, ...getSchemaDefaults(RESET_TABS_) }),
                lastUpdated: new Date().toISOString()
            };
            await DB.set('settings', payload);
            return payload.options;
        });

        // Sin `changed`: el editor calcula el delta contra su copia.
        notifyEditors('settings', null, options);

        // Refrescar UI sin recargar toda la página
        loadQualityCodeSettings_();
        updateAboutStats_();

        Toast.show(tr('toastSettingsRestored', 'Settings restored to default'), 'success');
    } catch (error) {
        console.error('Error resetting settings:', error);
        Toast.show(tr('toastErrorResettingSettings', 'Error resetting settings'), 'error');
    }
}

// ─────────────────────────────────────────────────────────────────────────
// CONTEXTO GLOBAL DE IA — chrome.storage.sync (global), guardado automático
// ─────────────────────────────────────────────────────────────────────────

// Espera tras la última pulsación antes de guardar (también limita las escrituras a sync).
const AI_CONTEXT_DEBOUNCE_MS_ = 800;

/**
 * Inicializa el contexto global de IA: carga y guardado automático con debounce.
 * @returns {void}
 */
export function initAiContextModule() {
  loadAiContext_();
  initAiContextAutoSave_();
}

/**
 * Carga el contexto guardado en el textarea.
 * @returns {Promise<void>}
 * @private
 */
async function loadAiContext_() {
  try {
    const result   = await chrome.storage.sync.get(['gasToolsAiContext']);
    const textarea = document.getElementById('aiContextInput');
    if (textarea) textarea.value = result['gasToolsAiContext'] || '';
  } catch (err) {
    console.error('Error loading AI context:', err);
  }
}

/**
 * Guarda el textarea tras una pausa al escribir, al salir del campo o al cerrar el popup.
 * @returns {void}
 * @private
 */
function initAiContextAutoSave_() {
  const textarea = document.getElementById('aiContextInput');
  const status   = document.getElementById('aiContextStatus');
  if (!textarea) return;

  let timer = null;
  let dirty = false;

  const setStatus_ = (key, fallback, saved = false) => {
    if (!status) return;
    status.textContent = key ? tr(key, fallback) : '';
    status.classList.toggle('qc__save-status--saved', saved);
  };

  const flush_ = async () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    setStatus_('aiContextSaving', 'Saving…');
    try {
      await chrome.storage.sync.set({ gasToolsAiContext: textarea.value });
      if (!dirty) setStatus_('aiContextSaved', 'Saved ✓', true);
    } catch (err) {
      console.error('Error saving AI context:', err);
      setStatus_('');
      Toast.show(tr('toastErrorSavingContext', 'Error saving context'), 'error');
    }
  };

  textarea.addEventListener('input', () => {
    dirty = true;
    setStatus_('');
    clearTimeout(timer);
    timer = setTimeout(flush_, AI_CONTEXT_DEBOUNCE_MS_);
  });
  textarea.addEventListener('blur', flush_);
  window.addEventListener('pagehide', flush_);
}
