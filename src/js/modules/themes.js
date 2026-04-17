import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { THEME_LIST } from '../utils/Themes.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { DB } from '../utils/Storage.js';
let currentThemeCategory = 'default';

/**
 * Orquestador del módulo de temas.
 */
export function initThemeModule() {
    initThemeNavigation_();
    initThemeSearch_();
    initThemeActions_();
    renderThemes_();
}

/**
 * Carga el JSON de definición desde la carpeta /themes.
 */
async function fetchThemeDefinition_(themeText) {
    const fileName = themeText.replace(/\s+/g, '');
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
    } catch (error) {
        console.error("Error al renderizar temas:", error);
    }
}

/**
 * Acciones de duplicar, editar y borrar.
 */
function initThemeActions_() {
    const container = document.querySelector('#themes');

    // Delegación de eventos para acciones en tarjetas de tema
    container.addEventListener('duplicate-theme', async (e) => {
        const sourceValue = e.detail.value;
        console.log("sourceValue:", sourceValue);

        // Buscar si el origen es un tema default o uno personalizado
        let themeBase = THEME_LIST.find(t => t.value === sourceValue);
        if (!themeBase) {
            const allCustom = await DB.getAll('themes');
            themeBase = allCustom.find(t => t.value === sourceValue);
        }
        console.log("themeBase:", themeBase);

        if (!themeBase) return;
        let themeData = null;

        // Si es protegido, buscamos su JSON físico
        if (themeBase?.protected) {
            console.log("Buscando definición JSON para tema protegido...");
            console.log("themeBase.text:", themeBase.text);
            themeData = await fetchThemeDefinition_(themeBase.text);
            console.log("themeData:", themeData);
            if (!themeData) {
                Toast.show("Error: Base JSON not found", "error");
                return;
            }
        }

        const timestamp = Date.now();
        let newTheme = {
            ...themeBase,
            id: `theme-${timestamp}`,
            text: `${themeBase.text} (Copy)`,
            value: `theme-copy-${timestamp}`,
            protected: false // Adjuntar definición si existe
        };

        // Se valida si existe datos del tema
        if(themeData){
            newTheme["data"] = themeData;
        }

        try {
            await DB.set('themes', newTheme);
            Toast.show("Theme duplicated", "success");
            
            // Cambiar a la pestaña de personalizados
            currentThemeCategory = 'custom';
            const customTab = document.querySelector('#themes .qc__sub-tab[data-filter="custom"]');
            if (customTab) customTab.click();
            else renderThemes_();
        } catch (err) {
            console.error("Error duplicating theme:", err);
            Toast.show("Failed to duplicate", "error");
        }
    });

    // Evento para eliminar un tema personalizado
    container.addEventListener('delete-theme', async (e) => {

        const themeValue = e.detail.value;
        if (await ConfirmDialog("Delete this custom theme?")) {
            try {
                // Buscamos el ID por el value (o puedes usar el value como ID directamente)
                const allCustom = await DB.getAll('themes');
                const target = allCustom.find(t => t.value === themeValue);
                
                if (target) {
                    await DB.delete('themes', target.id);
                    Toast.show("Theme deleted", "success");
                    renderThemes_();
                }
            } catch (err) {
                Toast.show("Error deleting theme", "error");
            }
        }
    });
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