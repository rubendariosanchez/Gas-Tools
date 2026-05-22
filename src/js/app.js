/**
 * @fileoverview Entry point del popup de la extensión Gas-Tools.
 *
 * Bootstrap del popup HTML (`src/html/index.html`):
 *  - Registra los Web Components usados en el popup (toggles, selects,
 *    cards de snippets/temas, modales).
 *  - Inicializa cada pestaña ("Settings", "Snippets", "Themes",
 *    "AI Context", "About") delegando en módulos independientes
 *    bajo `src/js/modules/`.
 *  - Detecta si el popup se abre fuera del editor de GAS y notifica al
 *    usuario (algunas opciones solo tienen sentido dentro del editor).
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

import { initTabs_, updateAboutStats_ } from './modules/ui.js';
import { initSettingsModule, initAiContextModule } from './modules/settings.js';
import { initThemeModule } from './modules/themes.js';
import { initSnippetModule } from './modules/snippets.js';

document.addEventListener('DOMContentLoaded', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Validamos la URL del editor de Google Apps Script
    const isEditor_ = tab?.url?.includes('script.google.com/') && tab?.url?.includes('/edit');

    // Si no estamos en el editor, mostramos una pantalla de créditos o información básica
    if (!isEditor_) {
        // 1. Ocultar navegación y footer (donde están los botones Save/Reset)
        document.querySelector('.qc__nav-tabs').style.display = 'none';
        document.querySelector('.qc__footer').style.display = 'none';
        
        // 2. Forzar visualización de créditos
        document.querySelectorAll('.qc__page').forEach(p => p.classList.remove('qc__active'));
        const aboutPage = document.getElementById('about');
        aboutPage.classList.add('qc__active');

        // 3. Opcional: Eliminar los modales del DOM para liberar memoria
        document.getElementById('snippetModal')?.remove();
        document.getElementById('themeModal')?.remove();
        document.getElementById('qc__confirm')?.remove();
        
        // Inicializar solo lo básico para que se vean las estadísticas en los créditos
        updateAboutStats_();
        return; // Detenemos la inicialización de módulos pesados
    }

    // Inicializar navegación base
    initTabs_();
    
    // Inicializar estadísticas
    updateAboutStats_();

    // Inicializar módulos funcionales
    initSettingsModule();
    initAiContextModule();
    initThemeModule();
    
    // Si tienes snippets listos:
    initSnippetModule();
});