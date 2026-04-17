// Importación de componentes Web y constantes globales
import { OptionToggle } from '../components/OptionToggle.js';
import { SnippetCard } from '../components/SnippetCard.js';
import { ThemeCard } from '../components/ThemeCard.js';
import { SnippetModal } from '../components/SnippetModal.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { Toast } from '../utils/Toast.js';
import { DEFAULT_SNIPPETS } from '../utils/Variables.js';
import { THEME_LIST } from '../utils/Themes.js';

// Nombre de la propiedad raíz usada en chrome.storage
const G_PROPERTY_NAME = 'QualityCode';

/**
 * Inicialización principal de la aplicación
 * Se ejecuta cuando el DOM está completamente cargado
 */
document.addEventListener('DOMContentLoaded', () => {
  initTabs_();                    // Inicializa navegación por tabs
  loadQualityCodeSettings_();     // Carga configuración guardada
  initActionButtons_();           // Inicializa botones principales
  loadSnippets_();                // Carga snippets
  initSnippetModal_();            // Inicializa modal
  initThemeSelection_();          // Inicializa selección de temas
  initThemeSearch_();
  renderThemes_();
  updateAboutStats_();
});

/**
 * Actualiza la información de la pestaña 'About'
 * Calcula el total de snippets y formatea la fecha de sincronización
 */
function updateAboutStats_() {
  const snippetsCountEl = document.getElementById('stat-snippets-count');
  const lastSyncEl = document.getElementById('stat-last-sync');

  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {
    const data = result[G_PROPERTY_NAME] || {};
    
    // 1. Contar snippets (Predeterminados + Usuario)
    const userSnippets = data.snippets || [];
    // const totalSnippets = DEFAULT_SNIPPETS.length + userSnippets.length;
    const totalSnippets = userSnippets.length;
    snippetsCountEl.innerText = totalSnippets;

    // 2. Formatear fecha de sincronización
    if (data.lastUpdated) {
      const date = new Date(data.lastUpdated);
      
      // Formato amigable: "16 abr 2026, 19:05"
      const formattedDate = date.toLocaleString('es-ES', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      lastSyncEl.innerText = formattedDate;
    } else {
      lastSyncEl.innerText = 'Never';
    }
  });
}

/**
 * Renderiza la lista de temas en el grid
 * @param {string} filter - Texto para filtrar por nombre
 */
function renderThemes_(filter = '') {
  const grid = document.getElementById('themes-grid');
  grid.innerHTML = '';

  // Obtener el tema activo de la configuración cargada
  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {
    const activeTheme = result[G_PROPERTY_NAME]?.themes?.active || 'vs-dark';
    
    const filteredThemes = THEME_LIST.filter(t => 
      t.text.toLowerCase().includes(filter.toLowerCase())
    );

    // Renderizar cada tema como una tarjeta
    filteredThemes.forEach(theme => {
      const card = document.createElement('theme-card');
      card.setAttribute('name', theme.text);
      card.setAttribute('value', theme.value);
      card.setAttribute('colors', theme.colors);
      
      if (theme.value === activeTheme) {
        card.setAttribute('selected', '');
      }

      grid.appendChild(card);
    });

    // Si no existen temas que coincidan con el filtro, mostrar mensaje
    if (filteredThemes.length === 0) {
      grid.innerHTML = `<div class="qc__no-results">No themes found for "${filter}"</div>`;
    }
  });
}

/**
 * Escucha los cambios en el input de búsqueda
 */
function initThemeSearch_() {
  const searchInput = document.getElementById('themeSearch');
  
  // Debounce simple para no re-renderizar en cada tecla si es muy rápido
  searchInput.addEventListener('input', (e) => {
    renderThemes_(e.target.value);
  });
}

/**
 * Inicializa la lógica de selección de temas
 */
function initThemeSelection_() {
  const container = document.querySelector('#themes');

  container.addEventListener('select-theme', (e) => {
    const selectedValue = e.detail.value;

    // 1. UI: Actualizar estado visual de las tarjetas
    document.querySelectorAll('theme-card').forEach(card => {
      if (card.getAttribute('value') === selectedValue) {
        card.setAttribute('selected', '');
      } else {
        card.removeAttribute('selected');
      }
    });

    // 2. Storage: Guardar el tema activo en el objeto global
    chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {
      const data = result[G_PROPERTY_NAME] || {};
      data.themes = { active: selectedValue };
      
      chrome.storage.sync.set({ [G_PROPERTY_NAME]: data }, () => {
        Toast.show(`Theme "${e.detail.name}" applied`, 'success');
      });
    });
  });
}

/**
 * Carga la configuración del tema activo y actualiza la UI en consecuencia
 */
function loadThemeSettings_() {

  // Obtenemos el tema activo del storage
  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {
    const activeTheme = result[G_PROPERTY_NAME]?.themes?.active || 'vs-dark';
    const card = document.querySelector(`theme-card[value="${activeTheme}"]`);
    if (card) card.setAttribute('selected', '');
  });
}

/**
 * Módulo de navegación (tabs)
 * Controla el cambio entre secciones del panel
 */
function initTabs_() {
    const tabs = document.querySelectorAll('.qc__tab');
    const pages = document.querySelectorAll('.qc__page');

    // Agrega evento a cada tab para mostrar su contenido asociado
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.target;

        // Remueve estado activo de todos los tabs y páginas
        tabs.forEach(t => t.classList.remove('qc__active'));
        pages.forEach(p => p.classList.remove('qc__active'));
        
        // Activa el tab seleccionado y su contenido asociado
        tab.classList.add('qc__active');
        document.getElementById(target).classList.add('qc__active');
      });
    });
}

/**
 * Módulo de gestión de snippets
 */

/**
 * Inicializa los eventos del modal (abrir/cerrar)
 */
function initSnippetModal_() {
  const modal_ = document.getElementById('snippetModal');
  const addBtn_ = document.getElementById('addSnippetBtn');

  // Abrir modal en modo nuevo
  addBtn_.addEventListener('click', () => modal_.open_());

  // Guardar (crear o editar)
  modal_.addEventListener('save-snippet', (e) => {
    saveSnippet_(e.detail);
  });

  // mensajes de errores
  modal_.addEventListener('form-error', (e) => {
    Toast.show(e.detail.message, 'error');
  });

  // Mensajes de éxito
  modal_.addEventListener('form-success', (e) => {
    Toast.show(e.detail.message, 'success');
  });
}

/**
 * Guarda un snippet (nuevo o existente)
 * @param {String|null} snip_ - Datos del snippet
 */
function saveSnippet_(newSnip) {

  // Obtiene los datos actuales del storage
  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {

    const data = result[G_PROPERTY_NAME] || { options: {}, snippets: [] };
    let snippets = Array.isArray(data.snippets) ? data.snippets : [];
    const index = snippets.findIndex(s => s.id === newSnip.id);

    if (index !== -1) {
      // Editar existente
      snippets[index] = { ...snippets[index], ...newSnip };
    } else {
      // Nuevo
      snippets.push(newSnip);
    }

    data.snippets = snippets;

    // Guarda cambios en storage
    chrome.storage.sync.set({ [G_PROPERTY_NAME]: data }, () => {

      // Cierra modal y recarga la lista
      this.close_();
      loadSnippets_(); 
    });
  });
}

/**
 * Elimina un snippet por ID
 * @param {String} id
 */
function deleteSnippet(id) {
  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {
    const data = result[G_PROPERTY_NAME] || {};

    // Filtra eliminando el snippet seleccionado
    data.snippets = (data.snippets || []).filter(s => s.id !== id);

    // Guarda cambios y recarga la lista
    chrome.storage.sync.set({ [G_PROPERTY_NAME]: data }, loadSnippets_);
  });
}

/**
 * Carga y renderiza todos los snippets
 * Incluye los predeterminados y los del usuario
 */
function loadSnippets_() {
  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {

    const userSnippets = result[G_PROPERTY_NAME]?.snippets || [];
    const container = document.getElementById('snippets-list');

    // Limpia el contenedor antes de renderizar
    container.innerHTML = '';

    // Combina snippets protegidos y personalizados
    const allSnippets = [...DEFAULT_SNIPPETS, ...userSnippets];

    allSnippets.forEach(snip => {

      const card = document.createElement('snippet-card');

      // Asigna atributos al componente
      card.setAttribute('title', snip.title);
      card.setAttribute('prefix', snip.prefix);
      card.setAttribute('lang', snip.lang);
      card.setAttribute('code', snip.code);

      if (snip.protected) card.setAttribute('protected', '');

      // Eventos del componente
      card.addEventListener('edit-snippet', () => {
        const modal_ = document.getElementById('snippetModal');
        modal_.open_(snip);
      });

      card.addEventListener('delete-snippet', async () => {
        const ok = await ConfirmDialog(`Delete "${snip.title}"?`);
        if (ok) {
          deleteSnippet(snip.id);
          Toast.show('Snippet deleted', 'success');
        }
      });

      container.appendChild(card);
    });
  });
}

/**
 * Módulo de opciones y persistencia
 */

/**
 * Carga configuración guardada y la aplica a los toggles
 */
function loadQualityCodeSettings_() {
  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {

    const settings = result[G_PROPERTY_NAME]?.options || {};

    const optionIds = [
      'global-enable', 'showMinimap', 'wordWrap', 'bracketPairs', 
      'smoothScrolling', 'tabCompletion', 'scrollBeyondLastLine', 
      'peekWidget', 'formatOnSave'
    ];

    optionIds.forEach(id => {
      const el = document.getElementById(id);

      if (el) {
        settings[id] === true 
          ? el.setAttribute('checked', '') 
          : el.removeAttribute('checked');
      }
    });
  });
}

/**
 * Inicializa eventos de botones principales
 */
function initActionButtons_() {
    const saveBtn = document.getElementById('saveBtn');
    const resetBtn = document.getElementById('resetBtn');

    saveBtn.addEventListener('click', () => saveCurrentSettings_(saveBtn));

    // Boton de restablecer cambios
    resetBtn.addEventListener('click', async () => {
      const ok = await ConfirmDialog('Reset all settings?');
      if (ok) {
        chrome.storage.sync.remove(G_PROPERTY_NAME, () => window.location.reload());
      }
    });
}

/**
 * Guarda las opciones actuales desde los componentes option-toggle
 * @param {HTMLElement} btn - Botón que dispara el guardado
 */
function saveCurrentSettings_(btn) {
  const optionElements = document.querySelectorAll('option-toggle');
  const optionsData = {};

  optionElements.forEach(el => {
      const isChecked = el.shadowRoot.querySelector('input').checked;
      optionsData[el.id] = isChecked;
  });

  chrome.storage.sync.get([G_PROPERTY_NAME], (result) => {

    const currentData = result[G_PROPERTY_NAME] || {};

    const QualityCode = {
      ...currentData,
      options: optionsData,
      lastUpdated: new Date().toISOString()
    };

    // Guardamos la configuración actualizada en chrome.storage
    chrome.storage.sync.set({ [G_PROPERTY_NAME]: QualityCode }, () => {
      updateAboutStats_();

      // Feedback visual al usuario
      const oldText = btn.innerText;

      btn.innerText = '✓ Saved';
      btn.classList.add('qc__btn--success'); 

      setTimeout(() => {
        btn.innerText = oldText;
        btn.classList.remove('qc__btn--success');
      }, 1500);
    });
  });
}