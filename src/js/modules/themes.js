import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { THEME_LIST } from '../utils/Themes.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { DB } from '../utils/Storage.js';
import { notifyEditors } from '../utils/Notify.js';

// Estado local del módulo para filtros
let currentThemeCategory = 'custom'; // 'default' o 'custom'

/**
 * Orquestador del módulo de temas.
 */
export async function initThemeModule() {
    initThemeNavigation_();
    initThemeSearch_();
    initThemeActions_();
    initThemeModal_();

    // Carga inicial: podemos obtener el tema activo para loguear o verificar
    const activeTheme = await getActiveThemeData_();
    console.log("Current active theme configuration:", activeTheme);

    renderThemes_();
}

/**
 * Recupera la configuración completa del tema seleccionado actualmente.
 * @returns {Promise<Object|null>} Definición del tema lista para el editor.
 */
export async function getActiveThemeData_() {
    try {
        // 1. Obtener el ID activo del storage
        const result = await new Promise(res => chrome.storage.sync.get([G_PROPERTY_NAME], res));
        const activeThemeId = result[G_PROPERTY_NAME]?.themes?.active || 'vs-dark';

        // 2. Buscar en temas por defecto (THEME_LIST)
        let themeEntry = THEME_LIST.find(t => t.value === activeThemeId);

        // 3. Si no está ahí, buscar en temas personalizados (IndexedDB)
        if (!themeEntry) {
            const customThemes = await DB.getAll('themes');
            themeEntry = customThemes.find(t => t.value === activeThemeId);
        }

        if (!themeEntry) return null;

        // 4. Si es un tema de sistema (protegido) y no tiene el JSON cargado, lo buscamos
        if (themeEntry.protected && !themeEntry.data) {
            themeEntry.data = await fetchThemeDefinition_(themeEntry.text);
        }

        return themeEntry;
    } catch (error) {
        console.error("Error al cargar el tema activo:", error);
        return null;
    }
}

/**
 * Inicializa el modal de temas y sus botones de disparo
 */
function initThemeModal_() {
    const modal = document.getElementById('themeModal');
    const addBtn = document.getElementById('addThemeBtn'); // Asegúrate de tener este ID en tu HTML

    // Usar el método .open_() que definiste en la clase ThemeModal
    addBtn?.addEventListener('click', () => modal.open_()); 

    // Escuchar el evento correcto: 'save-theme'
    modal?.addEventListener('save-theme', async (e) => {
        try {
            const themeData = e.detail;
            
            // Para IndexedDB, necesitamos un ID consistente. 
            // Tu modal ya genera uno en getFormData_: this._editingId || `theme-${Date.now()}`
            // Pero IndexedDB suele requerir que el campo 'id' esté en la raíz del objeto.
            // themeData.id = themeData.value; 

            // Guardamos en IndexedDB usando el método set, que hará upsert (insertar o actualizar según exista o no el ID)
            await DB.set('themes', themeData);
            notifyEditors('themes');
            Toast.show("Theme saved successfully", "success");
            
            // Forzar vista a 'custom' para ver el resultado
            currentThemeCategory = 'custom';
            renderThemes_();
        } catch (err) {
            console.error(err);
            Toast.show("Error saving theme", "error");
        }
    })
}

/**
 * Carga el JSON de definición desde la carpeta /themes.
 */
async function fetchThemeDefinition_(themeText) {
    const fileName = themeText;
    console.log(`${fileName}.json`);
    const url = chrome.runtime.getURL(`themes/${fileName}.json`);
    console.log("Fetching theme from:", url);
    try {
        const response = await fetch(url);
        console.log("Fetch response:", response);
        if (!response.ok) throw new Error();
        return await response.json();
    } catch (e) {
        console.error("No se pudo cargar el archivo JSON del tema");
        return null;
    }
}

/**
 * Renderiza el grid de temas filtrado.
 */
export async function renderThemes_(filter = '', category = currentThemeCategory) {
    const grid = document.getElementById('themes-grid');
    const activeThemeBadge = document.getElementById('activeThemeBadge');
    if (!grid) return;

    try {
        // 1. Obtener temas personalizados de IndexedDB y configuración de Sync
        const [customThemes, result] = await Promise.all([
            DB.getAll('themes'),
            new Promise(res => chrome.storage.sync.get([G_PROPERTY_NAME], res))
        ]);

        const activeTheme = result[G_PROPERTY_NAME]?.themes?.active || 'vs-dark';

        // 2. Unificar y Filtrar
        const allThemes = [...THEME_LIST, ...customThemes];
        const targetThemes = allThemes.filter(t => (category === 'default' ? t.protected : !t.protected));
        const filtered = targetThemes.filter(t => t.text.toLowerCase().includes(filter.toLowerCase()));

        // 3. Renderizar
        grid.innerHTML = '';
        filtered.forEach(theme => {
            const card = document.createElement('theme-card');
            card.setAttribute('name', theme.text);
            card.setAttribute('value', theme.value);
            card.setAttribute('colors', theme.colors);
            if (theme.protected) card.setAttribute('protected', '');
            if (theme.value === activeTheme) card.setAttribute('selected', '');
            grid.appendChild(card);
        });

        if (activeThemeBadge) {
            const activeThemeEntry = allThemes.find(theme => theme.value === activeTheme);
            const colors = activeThemeEntry?.colors ? activeThemeEntry.colors.split(',') : ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'];
            activeThemeBadge.innerHTML = `
                <div class="qc__badge-colors">
                    ${colors.slice(0, 4).map(c => `<div class="qc__badge-color" style="background:${c}"></div>`).join('')}
                </div>
                <span class="material-symbols-outlined qc__badge-icon">palette</span>
                <div class="qc__badge-info">
                    <span class="qc__badge-label">Active Theme</span>
                    <span class="qc__badge-name">${activeThemeEntry?.text || activeTheme}</span>
                </div>
            `;
        }
    } catch (error) {
        console.error("Error al renderizar temas:", error);
    }
}

/**
 * Inicializa los escuchadores de eventos para las acciones de temas.
 * Utiliza delegación de eventos sobre el contenedor principal.
 */
function initThemeActions_() {
    const container = document.querySelector('#themes');

    // Delegación de eventos para acciones en tarjetas de tema
    container.addEventListener('edit-theme', (e) => handleEditTheme_(e.detail.value));
    container.addEventListener('duplicate-theme', (e) => handleDuplicateTheme_(e.detail.value));
    container.addEventListener('delete-theme', (e) => handleDeleteTheme_(e.detail.value));

    // Listener de selección simplificado
    document.addEventListener('select-theme', (e) => {
        const { value, name } = e.detail;
        handleSelectTheme_(value, name);
    });
}


/**
 * Maneja la selección de un tema, persiste la elección y actualiza la UI.
 * @param {string} selectedValue - El ID/Value del tema.
 * @param {string} themeName - El nombre legible del tema para el feedback.
 * @private
 */
async function handleSelectTheme_(selectedValue, themeName) {
    try {
        // 1. Persistencia: Actualizamos el storage de Chrome
        const result = await new Promise(res => chrome.storage.sync.get([G_PROPERTY_NAME], res));
        const currentSettings = result[G_PROPERTY_NAME] || {};

        const updatedSettings = {
            ...currentSettings,
            themes: {
                ...currentSettings.themes,
                active: selectedValue
            }
        };

        await chrome.storage.sync.set({ [G_PROPERTY_NAME]: updatedSettings });

        // 2. UI: Actualización visual de las tarjetas en el grid
        const allCards = document.querySelectorAll('theme-card');
        allCards.forEach(card => {
            if (card.getAttribute('value') === selectedValue) {
                card.setAttribute('selected', '');
            } else {
                card.removeAttribute('selected');
            }
        });

        // 3. Actualizar badge del tema activo inmediatamente
        const activeThemeBadge = document.getElementById('activeThemeBadge');
        if (activeThemeBadge) {
            // Obtener los colores del tema seleccionado
            let themeEntry = THEME_LIST.find(t => t.value === selectedValue);
            if (!themeEntry) {
                const customThemes = await DB.getAll('themes');
                themeEntry = customThemes.find(t => t.value === selectedValue);
            }
            const colors = themeEntry?.colors ? themeEntry.colors.split(',') : ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'];
            activeThemeBadge.innerHTML = `
                <div class="qc__badge-colors">
                    ${colors.slice(0, 4).map(c => `<div class="qc__badge-color" style="background:${c}"></div>`).join('')}
                </div>
                <span class="material-symbols-outlined qc__badge-icon">palette</span>
                <div class="qc__badge-info">
                    <span class="qc__badge-label">Active Theme</span>
                    <span class="qc__badge-name">${themeName}</span>
                </div>
            `;
        }

        // 4. Notificación: Avisamos a los content scripts/editores
        notifyEditors('themes');

        // 5. Feedback: Toast informativo
        Toast.show(`Theme "${themeName}" selected and will be applied.`, "success");

    } catch (error) {
        console.error("Error al seleccionar el tema:", error);
        Toast.show("Could not save theme selection", "error");
    }
}

/**
 * Maneja la lógica para abrir el editor de un tema personalizado.
 * @param {string} themeValue - El identificador único (value) del tema.
 */
async function handleEditTheme_(themeValue) {
    const modal = document.getElementById('themeModal');
    const allCustom = await DB.getAll('themes');
    const targetTheme = allCustom.find(t => t.value === themeValue);

    if (targetTheme) {
        modal.open_(targetTheme);
    } else {
        Toast.show("Cannot edit system themes. Try duplicating it first.", "error");
    }
}

/**
 * Crea una copia de un tema existente (sistema o personalizado).
 * @param {string} sourceValue - El valor del tema origen a duplicar.
 */
async function handleDuplicateTheme_(sourceValue) {
    // 1. Buscar el tema base
    let themeBase = THEME_LIST.find(t => t.value === sourceValue);
    if (!themeBase) {
        const allCustom = await DB.getAll('themes');
        themeBase = allCustom.find(t => t.value === sourceValue);
    }

    if (!themeBase) return;

    // 2. Si es protegido, obtener definición JSON física
    let themeData = null;
    if (themeBase.protected) {
        themeData = await fetchThemeDefinition_(themeBase.text);
        if (!themeData) {
            return Toast.show("Error: Base JSON not found", "error");
        }
    }

    // 3. Preparar el nuevo objeto
    const timestamp = Date.now();
    const newTheme = {
        ...themeBase,
        id: `theme-${timestamp}`,
        text: `${themeBase.text} (Copy)`,
        value: `theme-copy-${timestamp}`,
        protected: false,
        data: themeData || themeBase.data
    };

    // 4. Guardar y actualizar UI
    try {
        
        // Guardamos en IndexedDB usando el método set, que hará upsert (insertar o actualizar según exista o no el ID)
        await DB.set('themes', newTheme);
        notifyEditors('themes');
        Toast.show("Theme duplicated", "success");

        // Renderizamos la vista de temas personalizados para mostrar el nuevo tema
        renderThemes_();
        
        // Redirigir a pestaña de personalizados
        const customTab = document.querySelector('#themes .qc__sub-tab[data-filter="custom"]');
        if (customTab) {
            customTab.click();
        }
    } catch (err) {
        console.error("Error duplicating theme:", err);
        Toast.show("Failed to duplicate", "error");
    }
}

/**
 * Elimina un tema personalizado después de una confirmación.
 * @param {string} themeValue - El identificador único (value) del tema.
 */
async function handleDeleteTheme_(themeValue) {
    const isConfirmed = await ConfirmDialog("Delete this custom theme?");
    if (!isConfirmed) return;

    try {
        const allCustom = await DB.getAll('themes');
        const target = allCustom.find(t => t.value === themeValue);
        
        if (target) {

            // Eliminamos el tema de IndexedDB
            await DB.delete('themes', target.id);
            notifyEditors('themes');
            Toast.show("Theme deleted", "success");
            renderThemes_();
        }
    } catch (err) {
        console.error("Error deleting theme:", err);
        Toast.show("Error deleting theme", "error");
    }
}

/**
 * Inicializa los eventos de navegación entre categorías de temas (default/custom).
 */
function initThemeNavigation_() {
    const subTabs = document.querySelectorAll('#themes .qc__sub-tab');

    // Listener para cambiar categoría de temas
    subTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            subTabs.forEach(t => t.classList.remove('qc__active'));
            tab.classList.add('qc__active');
            currentThemeCategory = tab.dataset.filter;
            renderThemes_(document.getElementById('themeSearch').value|| '');
        });
    });
}

/**
 * Inicializa el buscador de temas por nombre. Filtra en tiempo real mientras se escribe.
 */
function initThemeSearch_() {
    // Listener para el buscador de temas
    document.getElementById('themeSearch')?.addEventListener('input', (e) => renderThemes_(e.target.value));
}