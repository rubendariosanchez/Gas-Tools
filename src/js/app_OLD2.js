// Importación de componentes Web y constantes globales
import { OptionToggle } from '../components/OptionToggle.js';
import { SnippetCard } from '../components/SnippetCard.js';
import { ThemeCard } from '../components/ThemeCard.js';
import { SnippetModal } from '../components/SnippetModal.js';
import { ThemeModal } from '../components/ThemeModal.js';
import { ConfirmDialog } from '../js/utils/ConfirmDialog.js';
import { Toast } from '../js/utils/Toast.js';
import { DEFAULT_SNIPPETS } from '../js/utils/Variables.js';
import { THEME_LIST } from '../js/utils/Themes.js';

// Nombre de la propiedad raíz usada en chrome.storage
const G_PROPERTY_NAME = 'QualityCode';

// Variable de estado local para los snippets
let currentSnippetFilter = 'default';
let currentThemeCategory = 'default';

/**
 * Inicialización principal de la aplicación
 * Se ejecuta cuando el DOM está completamente cargado
 */
document.addEventListener('DOMContentLoaded', () => {
  initTabs_();                    // Inicializa navegación por tabs
  loadQualityCodeSettings_();     // Carga configuración guardada
  initActionButtons_();           // Inicializa botones principales
  loadSnippets_();                // Carga snippets
  initSnippetNavigation_();       // Inicializa búsqueda y sub-tabs de snippets
  initSnippetModal_();            // Inicializa modal
  initThemeSelection_();          // Inicializa selección de temas
  initThemeSearch_();
  initThemeActions_();           // Inicializa acciones de duplicar, editar y borrar temas
  renderThemes_();
  updateAboutStats_();
  initThemeNavigation_();     // Inicializa navegación por sub-tabs de temas
});

/**
 * Inicializa la búsqueda y las sub-pestañas de Temas (Default / Custom)
 */
function initThemeNavigation_() {
  const searchInput = document.getElementById('themeSearch');
  const subTabs = document.querySelectorAll('#themes .qc__sub-tab');

  // Listener para búsqueda por texto
  searchInput.addEventListener('input', (e) => {
    renderThemes_(e.target.value, currentThemeCategory);
  });

  // Listener para cambio de pestaña (Default / Custom)
  subTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // UI: Cambiar estado activo de las sub-tabs
      subTabs.forEach(t => t.classList.remove('qc__active'));
      tab.classList.add('qc__active');
      
      // Estado: Actualizar categoría y re-renderizar
      currentThemeCategory = tab.dataset.filter;
      renderThemes_(searchInput.value, currentThemeCategory);
    });
  });
}

/**
 * Inicializa las acciones de duplicar, editar y borrar temas
 */
function initThemeActions_() {
  const container = document.querySelector('#themes');

  // DUPLICAR
  container.addEventListener('duplicate-theme', async (e) => {
    const sourceValue = e.detail.value;
    // 1. Buscar en la lista maestra para saber si es protegido
    let themeBase = THEME_LIST.find(t => t.value === sourceValue);
    let themeData = null;

    // Se valida que exista un dato base
    if (themeBase && themeBase.protected) {
      // Es un tema del sistema: Leer del archivo JSON
      themeData = await fetchThemeDefinition_(themeBase.text);
    } else {
      // Es un tema custom: Leer del storage
      const result = await chrome.storage.local.get([G_PROPERTY_NAME]);
      const customThemes = result[G_PROPERTY_NAME]?.customThemes || [];
      themeBase = customThemes.find(t => t.value === sourceValue);
    }
    console.log('Duplicating theme:', themeBase, themeData);

    // Se valida que se haya encontrado el tema (aunque debería ser raro no encontrarlo en alguna de las dos fuentes)
    if (themeBase) {

      // Se valida si se duplica un tema del sistema y no se logro obtener la estructura JSON
      if (themeBase && themeBase.protected && !themeData) {
        Toast.show("Error duplicando tema base: No se pudo cargar la definición del tema", "error");
        return;
      }

      // Obtenemos la fecha actual enmilisegundo
      const timestamp_ = Date.now();

      // Creamos el objeto
      let newTheme_ = {
        ...themeBase,
        text: `${themeBase.text} (Copy)-${timestamp_}`,
        value: `theme-copy-${timestamp_}`,
        protected: false 
      };

      // Se valiida si es un tema base
      if (themeData) {
        newTheme_["data"] = themeData;
      }

      // Se guarda el nuevo tema personalizado en el storage
      saveCustomTheme_(newTheme_, () => {
        // Actualizamos el estado global
        currentThemeCategory = 'custom';
        
        // Buscamos la sub-tab de custom y simulamos el click para actualizar la UI
        const customTab = document.querySelector('#themes .qc__sub-tab[data-filter="custom"]');
        if (customTab) {
          customTab.click(); 
        }
      });
    }
  });

  // ELIMINAR
  container.addEventListener('delete-theme', async (e) => {
    const value = e.detail.value;
    const ok = await ConfirmDialog("Delete this custom theme?");
    if (ok) {
      deleteCustomTheme_(value);
    }
  });

  // Permite habilitar la edición de temas personalizados (falta implementar la UI del editor)
  container.addEventListener('edit-theme', (e) => {
    const themeValue = e.detail.value;

    // Obtenemos los temas personalizados del storage para encontrar el que queremos editar
    chrome.storage.local.get([G_PROPERTY_NAME], (result) => {
      const data = result[G_PROPERTY_NAME] || {};
      const customThemes = data.customThemes || [];
      
      // Combinamos con THEME_LIST por si el usuario intenta editar un tema base 
      // (aunque la UI normalmente lo bloquea, es más seguro)
      const allThemes = [...THEME_LIST, ...customThemes];
      const theme = allThemes.find(t => t.value === themeValue);
      console.log('Editing theme:', theme);

      if (theme) {
        document.getElementById('themeModal').open_(theme);
      }
    });
  });
}

/**
 * Carga el archivo JSON de un tema desde la carpeta local /themes
 * @param {string} themeText - El nombre del tema (propiedad 'text')
 * @returns {Promise<Object>} Datos del tema en formato Monaco
 */
async function fetchThemeDefinition_(themeText) {
  // Limpiamos el nombre para que coincida con el archivo (ej: "Active4D" -> "Active4D.json")
  // Eliminamos espacios por si acaso, aunque tus nombres parecen limpios.
  const fileName = themeText.replace(/\s+/g, '');
  const url = chrome.runtime.getURL(`themes/${fileName}.json`);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`No se pudo cargar el tema: ${fileName}`);
    return await response.json();
  } catch (error) {
    console.error("Error cargando tema base:", error);
    return null;
  }
}

/**
 * Guarda un tema personalizado en chrome.storage
 */
function saveCustomTheme_(theme, callback = null) {

  // Se procede a guardar el nuevo tema personalizado en el storage local
  chrome.storage.local.get([G_PROPERTY_NAME], (result) => {
    const data = result[G_PROPERTY_NAME] || {};
    if (!data.customThemes) data.customThemes = [];
    
    data.customThemes.push(theme);
    
    // Guardamos el nuevo tema personalizado en el storage
    chrome.storage.local.set({ [G_PROPERTY_NAME]: data }, () => {
      Toast.show("Theme duplicated", "success");

      // Si existe un callback lo ejecutamos, si no, renderizamos normal
      if (callback) {
        callback();
      } else {
        renderThemes_(); 
      }
    });
  });
}

/**
 * Elimina un tema personalizado del storage.
 * @param {string} value - El identificador único del tema a eliminar.
 */
function deleteCustomTheme_(value) {
  chrome.storage.local.get([G_PROPERTY_NAME], (result) => {
    const data = result[G_PROPERTY_NAME] || {};
    
    // Filtrar para mantener todos menos el que queremos borrar
    const customThemes = (data.customThemes || []).filter(t => t.value !== value);
    
    data.customThemes = customThemes;

    // Si el tema que borramos era el activo, volvemos al por defecto
    if (data.themes?.active === value) {
      data.themes.active = 'vs-dark';
    }

    chrome.storage.local.set({ [G_PROPERTY_NAME]: data }, () => {
      Toast.show("Theme deleted", "success");
      renderThemes_(); // Refrescar la lista visual
    });
  });
}

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
 * Renderiza la lista de temas en el grid, combinando temas del sistema y personalizados.
 * Maneja el filtrado por búsqueda y marca visualmente el tema activo.
 * @param {string} filter - Texto para filtrar temas por nombre (opcional).
 * @private
 */
function renderThemes_(filter = document.getElementById('themeSearch')?.value || '', category = currentThemeCategory) {
  const grid = document.getElementById('themes-grid');
  if (!grid) return;

  // Obtenemos los temas personalizados y el tema activo del storage
  chrome.storage.local.get([G_PROPERTY_NAME], (result) => {
    const data = result[G_PROPERTY_NAME] || {};
    const customThemes = data.customThemes || [];
    const activeTheme = data.themes?.active || 'vs-dark';

    /**
     * Unimos todas las fuentes y filtramos según la propiedad 'protected'.
     * 'default' muestra solo los protegidos (sistema).
     * 'custom' muestra solo los NO protegidos (usuario).
     */
    const allThemes = [...THEME_LIST, ...customThemes];

    // Agrupamos temas por categoría para facilitar el filtrado
    const targetThemes = allThemes.filter(t => {
      const isProtected = t.protected === true;
      return category === 'default' ? isProtected : !isProtected;
    });

    // 2. Aplicar filtro de búsqueda por texto
    const filteredThemes = targetThemes.filter(t => 
      t.text.toLowerCase().includes(filter.toLowerCase())
    );

    grid.innerHTML = '';

    // Iteramos sobre los temas para crear y configurar sus tarjetas (ThemeCard)
    filteredThemes.forEach(theme => {
      const card = document.createElement('theme-card');
      
      // Configuración de atributos del componente
      card.setAttribute('name', theme.text);
      card.setAttribute('value', theme.value);
      card.setAttribute('colors', theme.colors);
      
      // Si el tema es del sistema, marcamos como protegido para limitar acciones
      if (theme.protected) {
        card.setAttribute('protected', '');
      }

      // Marcamos visualmente si es el tema que el usuario tiene seleccionado
      if (theme.value === activeTheme) {
        card.setAttribute('selected', '');
      }
      
      grid.appendChild(card);
    });

    /**
     * Si tras el filtrado no hay coincidencias, mostramos un feedback visual
     * para evitar que el usuario piense que hay un error de carga.
     */
    if (filteredThemes.length === 0) {
      const msg = filter ? `No themes found for "${filter}"` : `No ${category} themes available`;
      grid.innerHTML = `<div class="qc__no-results">${msg}</div>`;
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
  chrome.storage.local.get([G_PROPERTY_NAME], (result) => {

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
    chrome.storage.local.set({ [G_PROPERTY_NAME]: data }, () => {

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
  chrome.storage.local.get([G_PROPERTY_NAME], (result) => {
    const data = result[G_PROPERTY_NAME] || {};

    // Filtra eliminando el snippet seleccionado
    data.snippets = (data.snippets || []).filter(s => s.id !== id);

    // Guarda cambios y recarga la lista
    chrome.storage.local.set({ [G_PROPERTY_NAME]: data }, loadSnippets_);
  });
}

/**
 * Inicializa la búsqueda y las sub-pestañas de snippets
 */
function initSnippetNavigation_() {
  const searchInput = document.getElementById('snippetSearch');
  const subTabs = document.querySelectorAll('#snippets .qc__sub-tab');

  // Listener para búsqueda
  searchInput.addEventListener('input', (e) => {
    loadSnippets_(e.target.value, currentSnippetFilter);
  });

  // Listener para cambio de pestaña (Default / Custom)
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
 * Carga y renderiza todos los snippets
 * Incluye los predeterminados y los del usuario
 */
function loadSnippets_(query = '', category = currentSnippetFilter) {

  // Obtenemos los snippets del usuario y los renderizamos junto con los predeterminados
  chrome.storage.local.get([G_PROPERTY_NAME], (result) => {
    const userSnippets = result[G_PROPERTY_NAME]?.snippets || [];
    const container = document.getElementById('snippets-list');
    container.innerHTML = '';

    // 1. Decidir qué lista mostrar
    let targetList = (category === 'default') ? DEFAULT_SNIPPETS : userSnippets;

    // 2. Aplicar búsqueda (por título o prefijo)
    const filtered = targetList.filter(snip => 
      snip.title.toLowerCase().includes(query.toLowerCase()) || 
      snip.prefix.toLowerCase().includes(query.toLowerCase())
    );

    // 3. Renderizar
    if (filtered.length === 0) {
      container.innerHTML = `<div class="qc__no-results">No ${category} snippets found</div>`;
      return;
    }

    // Renderizamos cada snippet como una tarjeta
    filtered.forEach(snip => {
      const card = document.createElement('snippet-card');
      card.setAttribute('title', snip.title);
      card.setAttribute('prefix', snip.prefix);
      card.setAttribute('lang', snip.lang);
      card.setAttribute('code', snip.code);
      if (snip.protected) card.setAttribute('protected', '');

      // Eventos (Editar/Borrar)
      card.addEventListener('edit-snippet', () => document.getElementById('snippetModal').open_(snip));
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