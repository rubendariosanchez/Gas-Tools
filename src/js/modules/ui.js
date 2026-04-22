import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { DB } from '../utils/Storage.js';

/**
 * Gestiona el sistema de pestañas (Tabs) principales de la aplicación.
 */
export function initTabs_() {
    const footer = document.querySelector('.qc__footer');
    const tabs = document.querySelectorAll('.qc__tab');
    const pages = document.querySelectorAll('.qc__page');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.target;
            console.log(`Tab clicked: ${target}`);

            // Limpiar estados activos previos
            tabs.forEach(t => t.classList.remove('qc__active'));
            pages.forEach(p => p.classList.remove('qc__active'));

            // Activar pestaña y página seleccionada
            tab.classList.add('qc__active');
            document.getElementById(target).classList.add('qc__active');

            // Actualizar estadísticas si es la pestaña "About"
            if (target === 'about') {
                updateAboutStats_();
            }

            // Control adicional para mostrar/ocultar footer basado en la pestaña seleccionada
            if (footer) {
                footer.style.display = (target === 'options') ? 'flex' : 'none';
            }
        });
    });
}

/**
 * Actualiza las estadísticas en la pestaña "About".
 * Obtiene el conteo de snippets y la última fecha de sincronización.
 */
export async function updateAboutStats_() {
    const snippetsCountEl = document.getElementById('stat-snippets-count');
    const themesCountEl = document.getElementById('stat-themes-count');
    const lastSyncEl = document.getElementById('stat-last-update');
    if (!snippetsCountEl || !themesCountEl || !lastSyncEl) return;

    try {
        // 1. Consultas paralelas a IndexedDB para mayor velocidad
        const [userSnippets, userThemes] = await Promise.all([
            DB.getAll('snippets'),
            DB.getAll('themes')
        ]);

        // 2. Actualizar conteos en la UI
        snippetsCountEl.innerText = userSnippets.length;
        themesCountEl.innerText = userThemes.length;

        // 3. Obtener metadatos de sincronización (Settings)
        chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {
            const data = result[G_PROPERTY_NAME] || {};
            
            if (data.lastUpdated) {
                const date = new Date(data.lastUpdated);
                lastSyncEl.innerText = date.toLocaleString('es-ES', {
                    day: '2-digit', 
                    month: 'short', 
                    year: 'numeric',
                    hour: '2-digit', 
                    minute: '2-digit'
                });
            } else {
                lastSyncEl.innerText = 'Never';
            }
        });

    } catch (error) {
        console.error("Error actualizando estadísticas:", error);
        snippetsCountEl.innerText = "0";
        themesCountEl.innerText = "0";
    }
}