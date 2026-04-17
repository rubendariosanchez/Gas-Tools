/**
 * QUALITY CODE - Entry Point
 * Orquestación de módulos independientes.
 */
// Importación de componentes Web y constantes globales
import { OptionToggle } from '../components/OptionToggle.js';
import { SnippetCard } from '../components/SnippetCard.js';
import { ThemeCard } from '../components/ThemeCard.js';
import { SnippetModal } from '../components/SnippetModal.js';
import { ThemeModal } from '../components/ThemeModal.js';

import { initTabs_, updateAboutStats_ } from './modules/ui.js';
import { initSettingsModule } from './modules/settings.js';
import { initThemeModule } from './modules/themes.js';
import { initSnippetModule } from './modules/snippets.js';
// (Aquí importarías initSnippetModule si ya lo tienes separado)

document.addEventListener('DOMContentLoaded', () => {
    console.log('QualityCode Engine Started');

    // Inicializar navegación base
    initTabs_();
    
    // Inicializar estadísticas
    updateAboutStats_();

    // Inicializar módulos funcionales
    initSettingsModule();
    initThemeModule();
    
    // Si tienes snippets listos:
    initSnippetModule();
});