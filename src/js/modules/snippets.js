import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { DEFAULT_SNIPPETS } from '../utils/Variables.js';
import { DB } from '../utils/Storage.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { notifyEditors } from '../utils/Notify.js';

// Estado local del módulo para filtros
let currentSnippetFilter = 'custom'; // 'default' o 'custom'

/**
 * Inicializa el módulo de Snippets: navegación, modal y carga inicial.
 */
export function initSnippetModule() {
    loadSnippets_();            // Renderizado inicial
    initSnippetNavigation_();   // Tabs de Default/Custom y búsqueda
    initSnippetModal_();        // Eventos del modal de creación/edición
}

/**
 * Gestiona la navegación de sub-pestañas (Default / Custom) y el buscador.
 */
function initSnippetNavigation_() {
    const searchInput = document.getElementById('snippetSearch');
    const subTabs = document.querySelectorAll('#snippets .qc__sub-tab');

    // Listener para el buscador de texto
    searchInput?.addEventListener('input', (e) => {
        loadSnippets_(e.target.value, currentSnippetFilter);
    });

    // Listener para cambio entre snippets de sistema y de usuario
    subTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            subTabs.forEach(t => t.classList.remove('qc__active'));
            tab.classList.add('qc__active');
            
            currentSnippetFilter = tab.dataset.filter;
            loadSnippets_(searchInput.value, currentSnippetFilter);
        });
    });
}

/**
 * Carga y renderiza la lista de snippets según el filtro y la categoría.
 */
export async function loadSnippets_(query = '', category = currentSnippetFilter) {

    // En lugar de chrome.storage, usamos nuestra API
    const userSnippets = await DB.getAll('snippets');
    const container = document.getElementById('snippets-list');

    if (!container) return;
    container.innerHTML = '';

    // 1. Seleccionar fuente de datos
    let targetList = (category === 'default') ? DEFAULT_SNIPPETS : userSnippets;

    // 2. Filtrar por búsqueda (Título o Prefijo)
    const filtered = targetList.filter(snip => 
        snip.title.toLowerCase().includes(query.toLowerCase()) || 
        snip.prefix.toLowerCase().includes(query.toLowerCase())
    );

    // 3. Validar si hay resultados
    if (filtered.length === 0) {
        container.innerHTML = `<div class="qc__no-results">No ${category} snippets found</div>`;
        return;
    }

    // 4. Crear y añadir tarjetas (SnippetCard)
    filtered.forEach(snip => {
        const card = document.createElement('snippet-card');
        card.setAttribute('title', snip.title);
        card.setAttribute('prefix', snip.prefix);
        card.setAttribute('lang', snip.lang);
        card.setAttribute('code', snip.code);
        
        if (snip.protected) card.setAttribute('protected', '');

        // Evento: Abrir modal para editar
        card.addEventListener('edit-snippet', () => {
            document.getElementById('snippetModal').open_(snip);
        });

        // Evento: Confirmar y eliminar
        card.addEventListener('delete-snippet', async () => {
            if (await ConfirmDialog(`Delete "${snip.title}"?`)) {
                deleteSnippet_(snip.id);
            }
        });

        container.appendChild(card);
    });
}

/**
 * Inicializa la lógica del modal (SnippetModal).
 */
function initSnippetModal_() {
    const modal = document.getElementById('snippetModal');
    const addBtn = document.getElementById('addSnippetBtn');

    // Botón flotante para nuevo snippet
    addBtn?.addEventListener('click', () => modal.open_());

    // Evento personalizado lanzado por el componente modal al guardar
    modal?.addEventListener('save-snippet', (e) => {
        saveSnippet_(e.detail, modal);
    });

    // Manejo de mensajes internos del modal
    modal?.addEventListener('form-error', (e) => Toast.show(e.detail.message, 'error'));
    modal?.addEventListener('form-success', (e) => Toast.show(e.detail.message, 'success'));
}

/**
 * Persiste un snippet (nuevo o editado) en el storage.
 */
async function saveSnippet_(newSnip, modalInstance) {

    try {

        // Almacenamos los datos en IndexedDB para optimizar rendimiento y evitar bloqueos
        await DB.set('snippets', newSnip); // Guarda o actualiza directamente
        notifyEditors('snippets');

        // Después de guardar, cerramos el modal y recargamos la lista para reflejar cambios
        modalInstance.close_();

        // Cargar nuevamente los snippets para actualizar la vista (podemos optimizar esto más adelante para solo actualizar el snippet modificado)
        loadSnippets_();
    } catch (err) {
        Toast.show("Error saving data", "error");
    }
}

/**
 * Elimina un snippet del storage local.
 */
async function deleteSnippet_(id) {
    try {
        // Llamada directa a nuestra API de IndexedDB
        await DB.delete('snippets', id);

        // Refrescar la interfaz
        loadSnippets_();
        notifyEditors('snippets');
        
        // Feedback al usuario
        Toast.show('Snippet deleted from IndexedDB', 'success');
    } catch (error) {
        console.error('Error al eliminar snippet:', error);
        Toast.show('Could not delete snippet', 'error');
    }
}