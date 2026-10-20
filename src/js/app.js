/**
 * @fileoverview Entry point del popup de la extensión Gas-Tools.
 *
 * Bootstrap del popup HTML (`src/html/index.html`):
 *  - Registra los Web Components usados en el popup (toggles, selects,
 *    cards de snippets/temas, modales).
 *  - Inicializa las pestañas ("Editor", "Herramientas", "IA", "Temas",
 *    "Snippets") y la vista "About" delegando en módulos independientes
 *    bajo `src/js/modules/`.
 *  - Fuera del editor de GAS solo muestra About (las opciones solo tienen
 *    sentido dentro del editor).
 *
 * Los tokens de diseño (`--gt-*`) los instala antes
 * `extension/js/shared/gas-ui.js` (script clásico cargado en el HTML).
 *
 * Este archivo no contiene lógica de negocio: todo el comportamiento
 * vive en sus respectivos módulos y se comunica con el background vía
 * `chrome.runtime.sendMessage`.
 */

// Importación de componentes Web y constantes globales
import { OptionToggle } from '../components/OptionToggle.js';
import { OptionSelect } from '../components/OptionSelect.js';
import { SnippetCard } from '../components/SnippetCard.js';
import { ThemeCard } from '../components/ThemeCard.js';
import { SnippetModal } from '../components/SnippetModal.js';
import { ThemeModal } from '../components/ThemeModal.js';
import { OptionColor } from '../components/OptionColor.js';

import {
    initTabs_, updateAboutStats_, showAboutOnly_, initColorMode_, initGlobalStatus_, renderVersion_,
} from './modules/ui.js';
import { initSettingsModule, initAiContextModule } from './modules/settings.js';
import { initThemeModule } from './modules/themes.js';
import { initSnippetModule } from './modules/snippets.js';
import { initProviderAccessModule } from './modules/providers.js';
import { initLanguageModule } from './modules/language.js';
import { applyI18n, loadI18n, getStoredLanguage } from './utils/I18n.js';
import { hydrateIcons } from './utils/Icons.js';

document.addEventListener('DOMContentLoaded', async () => {
    // Modo de color antes de nada para evitar el parpadeo claro/oscuro.
    initColorMode_();
    // Iconos SVG del HTML estático (sin fuentes externas).
    hydrateIcons(document);

    // Traducciones antes de cualquier otra inicialización: idioma elegido
    // por el usuario (inglés por defecto), no el del navegador.
    const lang = await loadI18n(getStoredLanguage());
    applyI18n(document);
    initLanguageModule(lang);
    renderVersion_();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Validamos la URL del editor de Google Apps Script
    const isEditor_ = tab?.url?.includes('script.google.com/') && tab?.url?.includes('/edit');

    // Fuera del editor: solo la vista About (sin pestañas, búsqueda ni pie).
    if (!isEditor_) {
        showAboutOnly_();

        // Eliminar la confirmación del DOM para liberar memoria
        document.getElementById('qc__confirm')?.remove();
        return; // Detenemos la inicialización de módulos pesados
    }

    // Modales: se crean tras loadI18n para que pinten sus textos ya traducidos.
    mountModals_();

    // Módulos funcionales (settings pinta los controles del esquema).
    initGlobalStatus_();
    initSettingsModule();
    initAiContextModule();
    initProviderAccessModule();
    initThemeModule();
    initSnippetModule();

    // Navegación al final: indexa la búsqueda con todo ya pintado.
    initTabs_();
    updateAboutStats_();
});

/**
 * Inserta los modales de snippet y tema (su render usa `tr()` al conectarse).
 * @returns {void}
 */
function mountModals_() {
    const confirm = document.getElementById('qc__confirm');
    [['snippet-modal', 'snippetModal'], ['theme-modal', 'themeModal']].forEach(([tag, id]) => {
        if (document.getElementById(id)) return;
        const modal = document.createElement(tag);
        modal.id = id;
        document.body.insertBefore(modal, confirm);
    });
}
