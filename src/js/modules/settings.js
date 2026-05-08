import { G_PROPERTY_NAME, DEFAULT_SETTINGS_OPTIONS } from '../utils/Variables.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { updateAboutStats_ } from './ui.js';
import { DB } from '../utils/Storage.js';
import { notifyEditors } from '../utils/Notify.js';
import { syncLastUpdated } from '../utils/Functions.js';

/**
 * Inicializa el módulo de configuración: carga datos, bindea botones y auto-guardado.
 */
export function initSettingsModule() {
    loadQualityCodeSettings_();
    initActionButtons_();
    initAutoSave_();
}

/**
 * Configura el auto-guardado: cada cambio en un toggle, select o range se guarda automáticamente.
 * @private
 */
function initAutoSave_() {
    const optionsContainer = document.getElementById('options');
    if (!optionsContainer) return;

    // Listener para toggles (checkbox switches)
    optionsContainer.addEventListener('toggle', async (e) => {
        const toggleEl = e.target;
        const optionId = toggleEl.id;
        const isChecked = e.detail.checked;

        console.log(`[Settings] Auto-saving toggle: ${optionId} = ${isChecked}`);

        try {
            await saveSingleOption_(optionId, isChecked);
            Toast.show('Setting saved', 'success', 800);
        } catch (error) {
            console.error('[Settings] Auto-save error:', error);
            Toast.show('Error saving setting', 'error');
        }
    });

    // Listener para option-select
    optionsContainer.addEventListener('select', async (e) => {
        const selectEl = e.target;
        const optionId = selectEl.id;
        const value = e.detail.value;

        console.log(`[Settings] Auto-saving select: ${optionId} = ${value}`);

        try {
            await saveSingleOption_(optionId, value);
            Toast.show('Setting saved', 'success', 800);
        } catch (error) {
            console.error('[Settings] Auto-save error:', error);
            Toast.show('Error saving setting', 'error');
        }
    });
}

/**
 * Guarda una única opción en IndexedDB.
 * @private
 */
async function saveSingleOption_(optionId, value) {
    const currentData = await DB.get('settings', G_PROPERTY_NAME) || {};
    const currentOptions = currentData?.options || {};

    // Se actualiza la opción seleccionada
    const updatedOptions = {
        ...currentOptions,
        [optionId]: value
    };

    // Se construye el payload
    const payload = {
        id: G_PROPERTY_NAME,
        ...currentData,
        options: updatedOptions,
        lastUpdated: new Date().toISOString()
    };

    // Guardamos en IndexedDB
    await DB.set('settings', payload);
    notifyEditors('settings');

    // Actualizamos la fecha de última actualización
    await syncLastUpdated();
}

/**
 * Carga las opciones desde el storage y aplica el estado a los componentes.
 */
async function loadQualityCodeSettings_() {
    try {
        let settingsData = await DB.get('settings', G_PROPERTY_NAME);

        if (!settingsData) {
            const defaultPayload = {
                id: G_PROPERTY_NAME,
                options: DEFAULT_SETTINGS_OPTIONS,
                lastUpdated: new Date().toISOString()
            };
            await DB.set('settings', defaultPayload);
            settingsData = defaultPayload;
        }

        const settings = settingsData?.options || {};

const optionIds = [
            'global-enable', 'load-snippets', 'ai-autocomplete',
            // Visuals & Layout
            'showMinimap', 'lineNumbers', 'wordWrap', 'renderLineHighlight',
            'rulers', 'occurrencesHighlight', 'renderWhitespace',
            // Code Assistance
            'bracketPairs', 'quickSuggestions', 'autoClosingBrackets', 'guides-indentation',
            // Navigation
            'folding',
            // Scrolling
            'smoothScrolling', 'scrollBeyondLastLine'
        ];

        // Procesar toggles
        optionIds.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.tagName === 'OPTION-TOGGLE') {
                settings[id] === true
                    ? el.setAttribute('checked', '')
                    : el.removeAttribute('checked');
            }
        });

        // Procesar selects
        const selectIds = ['fontFamily', 'fontSize', 'lineHeight', 'tabSize', 'cursorStyle', 'cursorBlinking'];
        selectIds.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.tagName === 'OPTION-SELECT' && settings[id] !== undefined) {
                el.setAttribute('value', settings[id]);
            }
        });

    } catch (error) {
        console.error('Error loading settings:', error);
        Toast.show('Error loading settings', 'error');
    }
}

/**
 * Configura los listeners para el botón de Restablecer.
 */
function initActionButtons_() {
    const resetBtn = document.getElementById('resetBtn');

    // Listener para resetear opciones
    resetBtn?.addEventListener('click', () => resetSettings_());
}

/**
 * Permite restaurar las opciones a valores por defecto.
 */
async function resetSettings_() {
    if (await ConfirmDialog('Reset all settings?')) {
        try {
            // Obtenemos datos actuales para no perder otras propiedades
            const currentData = await DB.get('settings', G_PROPERTY_NAME) || {};

            // Construimos el payload con valores por defecto
            const payload = {
                id: G_PROPERTY_NAME,
                ...currentData,
                options: DEFAULT_SETTINGS_OPTIONS,
                lastUpdated: new Date().toISOString()
            };

            // Guardamos en IndexedDB
            await DB.set('settings', payload);

            // Actualizamos la fecha de última actualización
            await syncLastUpdated();

            // Notificar a los editores sobre el cambio de configuración para que puedan reaccionar
            notifyEditors('settings');

            // Refrescar UI sin recargar toda la página
            loadQualityCodeSettings_();
            updateAboutStats_();

            Toast.show('Settings restored to default', 'success');

        } catch (error) {
            console.error('Error resetting settings:', error);
            Toast.show('Error resetting settings', 'error');
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// AI CONTEXT — Persistido en chrome.storage.sync (global)
// ─────────────────────────────────────────────────────────────────────────

export function initAiContextModule() {
  loadAiContext_();
  initAiContextActions_();
}

/** Carga el contexto guardado y lo muestra en el textarea. */
async function loadAiContext_() {
  try {
    const result   = await chrome.storage.sync.get(['gasToolsAiContext']);
    const textarea = document.getElementById('aiContextInput');
    if (textarea) textarea.value = result['gasToolsAiContext'] || '';
  } catch (err) {
    console.error('Error loading AI context:', err);
  }
}

/** Guarda el contenido del textarea en chrome.storage.sync al hacer clic en guardar. */
function initAiContextActions_() {
  document.getElementById('saveAiContextBtn')?.addEventListener('click', async () => {
    const contextText = document.getElementById('aiContextInput')?.value || '';
    try {
      await chrome.storage.sync.set({ gasToolsAiContext: contextText });
      Toast.show('Context saved', 'success');
    } catch (err) {
      console.error('Error saving AI context:', err);
      Toast.show('Error saving context', 'error');
    }
  });
}