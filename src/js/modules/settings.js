import { G_PROPERTY_NAME, DEFAULT_SETTINGS_OPTIONS } from '../utils/Variables.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { updateAboutStats_ } from './ui.js';
import { DB } from '../utils/Storage.js';

/**
 * Inicializa el módulo de configuración: carga datos y bindea botones.
 */
export function initSettingsModule() {
    loadQualityCodeSettings_();
    initActionButtons_();
}

/**
 * Carga las opciones desde el storage y aplica el estado a los toggles.
 */
async function loadQualityCodeSettings_() {
    try {
        // Obtenemos la configuración almacenada usando el id como key
        let settingsData = await DB.get('settings', G_PROPERTY_NAME);

        // Si no existe configuración, creamos una por defecto
        if (!settingsData) {
            const defaultPayload = {
                id: G_PROPERTY_NAME,
                options: DEFAULT_SETTINGS_OPTIONS,
                lastUpdated: new Date().toISOString()
            };

            // Guardamos configuración inicial
            await DB.set('settings', defaultPayload);

            settingsData = defaultPayload;
        }

        // Si no existe configuración, usamos un objeto vacío
        const settings = settingsData?.options || {};

        // Definir los IDs de las opciones para mapear con el DOM
        const optionIds = [
            'global-enable', 'showMinimap', 'wordWrap', 'bracketPairs',
            'smoothScrolling', 'tabCompletion', 'scrollBeyondLastLine',
            'peekWidget', 'formatOnSave'
        ];

        // Procesamos cada opción y actualizamos el estado del toggle correspondiente
        optionIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                settings[id] === true
                    ? el.setAttribute('checked', '')
                    : el.removeAttribute('checked');
            }
        });

    } catch (error) {
        console.error('Error loading settings:', error);
        Toast.show('Error loading settings', 'error');
    }
}

/**
 * Configura los listeners para los botones de Guardar y Reset.
 */
function initActionButtons_() {
    const saveBtn = document.getElementById('saveBtn');
    const resetBtn = document.getElementById('resetBtn');
    
    // Listener para guardar opciones
    saveBtn?.addEventListener('click', () => saveSettings_());

    // Listener para resetear opciones
    resetBtn?.addEventListener('click', () => resetSettings_());
}

/**
 * Permite guardar las opciones actuales en IndexedDB.
 */
async function saveSettings_() {
    const saveBtn = document.getElementById('saveBtn');
    const optionElements = document.querySelectorAll('option-toggle');
    const optionsData = {};

    // Recopilar estado de cada opción
    optionElements.forEach(el => {
        const isChecked = el.shadowRoot.querySelector('input').checked;
        optionsData[el.id] = isChecked;
    });

    try {
        // Obtenemos datos actuales para no sobrescribir otras propiedades
        const currentData = await DB.get('settings', G_PROPERTY_NAME) || {};

        // Construimos el payload incluyendo el id (clave primaria)
        const payload = {
            id: G_PROPERTY_NAME,
            ...currentData,
            options: optionsData,
            lastUpdated: new Date().toISOString()
        };

        console.log("Saving settings:", payload);

        // Guardamos en IndexedDB
        await DB.set('settings', payload);

        // Actualizar estadísticas en la pestaña "About" si está abierta
        updateAboutStats_();

        // Feedback visual
        const originalText = saveBtn.innerText;
        saveBtn.innerText = '✓ Saved';
        saveBtn.classList.add('qc__btn--success');

        setTimeout(() => {
            saveBtn.innerText = originalText;
            saveBtn.classList.remove('qc__btn--success');
        }, 1500);

        Toast.show('Settings saved', 'success');

    } catch (error) {
        console.error('Error saving settings:', error);
        Toast.show('Error saving settings', 'error');
    }
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