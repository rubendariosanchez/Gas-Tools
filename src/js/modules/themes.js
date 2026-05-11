import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { THEME_LIST } from '../utils/Themes.js';
import { Toast } from '../utils/Toast.js';
import { ConfirmDialog } from '../utils/ConfirmDialog.js';
import { DB } from '../utils/Storage.js';
import { notifyEditors } from '../utils/Notify.js';
import { syncLastUpdated } from '../utils/Functions.js';

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
    initActiveThemeBadge_();

    // Carga inicial: podemos obtener el tema activo para loguear o verificar
    const activeTheme = await getActiveThemeData_();
    console.log("Current active theme configuration:", activeTheme);

    // Renderiza los temas
    renderThemes_(true);
}

/**
 * Inicializa el badge del tema activo con navegación al hacer clic.
 *
 * Al hacer clic en el badge, la función:
 *  1. Obtiene el tema activo actual desde storage/IndexedDB.
 *  2. Detecta en qué categoría vive ('default' si es protegido, 'custom' si no).
 *  3. Cambia al tab correspondiente si el usuario está en la categoría incorrecta.
 *  4. Hace scroll hasta la card del tema activo y aplica un pulso visual para indicar su posición.
 *
 * Se apoya en {@link getActiveThemeData_} para resolver el tema activo sin duplicar lógica,
 * y en {@link scrollWhenVisible} para manejar el caso donde el panel aún no es visible.
 *
 * @remarks
 * El `setTimeout(50ms)` tras el `tab.click()` le da tiempo al DOM para que
 * `renderThemes_` (llamada desde el listener del tab) termine de pintar las cards
 * antes de intentar hacer scroll. Si en el futuro `renderThemes_` expone su Promise,
 * este defer puede reemplazarse por un await directo.
 *
 * @returns {void} No retorna nada; opera únicamente sobre el DOM.
 */
function initActiveThemeBadge_() {
    const badge = document.getElementById('activeThemeBadge');
    if (!badge) return;

    badge.addEventListener('click', async () => {
        // 1. Reutilizamos getActiveThemeData_ que ya maneja THEME_LIST + IndexedDB
        const activeEntry = await getActiveThemeData_();
        if (!activeEntry) return;

        // 2. Determinar categoría según si el tema es protegido o no
        const targetCategory = activeEntry.protected ? 'default' : 'custom';

        // 3. Cambiar tab si es necesario
        if (currentThemeCategory !== targetCategory) {
            const targetTab = document.querySelector(
                `#themes .qc__sub-tab[data-filter="${targetCategory}"]`
            );
            targetTab?.click();
            // Esperar a que renderThemes_ termine de pintar las cards tras el click
            await new Promise(r => setTimeout(r, 50));
        }

        // 4. Scroll + pulso visual para indicar la posición del tema activo
        const activeCard = document.querySelector(`theme-card[value="${activeEntry.value}"]`);
        if (activeCard) {
            scrollWhenVisible(activeCard);
            activeCard.classList.add('qc__highlight-pulse');
            activeCard.addEventListener('animationend', () => {
                activeCard.classList.remove('qc__highlight-pulse');
            }, { once: true });
        }
    });
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

            // Guardamos en IndexedDB usando el método set, que hará upsert (insertar o actualizar según exista o no el ID)
            await DB.set('themes', themeData);
            await syncLastUpdated();
            notifyEditors('themes');
            Toast.show("Theme saved successfully", "success");
            
            // Cambiar tab visual a 'custom' antes de renderizar
            const customTab = document.querySelector('#themes .qc__sub-tab[data-filter="custom"]');
            if (customTab) {
                customTab.click();
            }
            renderThemes_(false);
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
 *
 * @param {boolean} startModule_  - Indica si es la primera carga (inicialización del módulo).
 * @param {string}  filter        - Texto para filtrar temas por nombre.
 * @param {string}  category      - Categoría activa: 'default' | 'custom'.
 */
export async function renderThemes_(startModule_, filter = '', category = currentThemeCategory) {
    const grid = document.getElementById('themes-grid');
    const activeThemeBadge = document.getElementById('activeThemeBadge');

    // Salida temprana: si no existe el contenedor no hay nada que renderizar
    if (!grid) return;

    try {
        // 1. Obtener en paralelo los temas personalizados (IndexedDB) y el tema activo (chrome.storage.sync)
        const [customThemes, syncResult] = await Promise.all([
            DB.getAll('themes'),
            chrome.storage.sync.get([G_PROPERTY_NAME])
        ]);

        // Tema activo guardado en sync storage (null si no existe)
        const activeTheme = syncResult[G_PROPERTY_NAME]?.themes?.active ?? null;

        // 2. Lógica de inicialización: determinar qué tab/categoría mostrar al arrancar
        if (startModule_) {
            // Categoría por defecto según si hay temas personalizados
            currentThemeCategory = customThemes?.length > 0 ? 'custom' : 'default';

            // Si hay un tema activo, la tab activa debe ser la que lo contiene
            if (activeTheme) {
                const estaEnCustom   = customThemes.some(t => t.value === activeTheme);
                const estaEnDefault  = THEME_LIST.some(t => t.value === activeTheme);
                // OPTIMIZACIÓN: usamos .some() en lugar de .find() porque solo
                // necesitamos saber si existe, no obtener el objeto.

                if (estaEnCustom)        currentThemeCategory = 'custom';
                else if (estaEnDefault)  currentThemeCategory = 'default';
            }

            category = currentThemeCategory;

            // Actualizar clases CSS de los sub-tabs
            document.querySelectorAll('#themes .qc__sub-tab').forEach(tab => {
                tab.classList.toggle('qc__active', tab.dataset.filter === currentThemeCategory);
            });
        }

        // 3. Unificar lista de temas y aplicar filtros
        const allThemes = [...THEME_LIST, ...customThemes];

        // Filtra por categoría (protected = default) y luego por texto de búsqueda
        const filterLower = filter.toLowerCase(); // OPTIMIZACIÓN: calcular una sola vez
        const filtered = allThemes.filter(t => {
            const matchCategory = category === 'default' ? t.protected : !t.protected;
            const matchText     = t.text.toLowerCase().includes(filterLower);
            return matchCategory && matchText;
        });

        // 4. Renderizar cards en el grid
        // OPTIMIZACIÓN: usar DocumentFragment evita reflows intermedios al agregar múltiples nodos
        const fragment = document.createDocumentFragment();
        filtered.forEach(theme => {
            const card = document.createElement('theme-card');
            card.setAttribute('name',   theme.text);
            card.setAttribute('value',  theme.value);
            card.setAttribute('colors', theme.colors);
            if (theme.protected)           card.setAttribute('protected', '');
            if (theme.value === activeTheme) card.setAttribute('selected', '');
            fragment.appendChild(card);
        });

        grid.innerHTML = ''; // Limpiar antes de insertar el fragment
        grid.appendChild(fragment);

        // 5. Scroll hacia la card activa
        if (activeTheme) {
            const activeCard = grid.querySelector(`theme-card[value="${activeTheme}"]`);
            if (activeCard) {
                scrollWhenVisible(activeCard);
            }
        }

        // 6. Actualizar el badge del tema activo
        if (activeThemeBadge) {
            const activeEntry  = allThemes.find(t => t.value === activeTheme);
            const colors = activeEntry?.colors
                ? activeEntry.colors.split(',').slice(0, 4)
                : ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b'];

            // OPTIMIZACIÓN: construir el HTML de colores con join en lugar de map+join separados
            activeThemeBadge.innerHTML = `
                <div class="qc__badge-colors">
                    ${colors.map(c => `<div class="qc__badge-color" style="background:${c}"></div>`).join('')}
                </div>
                <span class="material-symbols-outlined qc__badge-icon">palette</span>
                <div class="qc__badge-info">
                    <span class="qc__badge-label">Active Theme</span>
                    <span class="qc__badge-name">${activeEntry?.text ?? activeTheme ?? ''}</span>
                </div>
            `;
        }

    } catch (error) {
        console.error('renderThemes_: error al renderizar temas:', error);
    }
}

/**
 * Hace scroll hacia `element` solo cuando este sea visible en el layout.
 *
 * Maneja tres escenarios:
 *  1. El elemento ya es visible → espera el próximo frame de pintura y scrollea.
 *  2. El elemento está oculto pero su panel contenedor se vuelve visible →
 *     usa un MutationObserver sobre el panel para detectar el cambio de
 *     display/visibility y entonces scrollea. Esto resuelve el caso de carga
 *     inicial donde el panel está con display:none.
 *  3. Fallback: si no se encuentra un panel contenedor, usa IntersectionObserver
 *     como antes.
 *
 * @param {Element} element - El elemento al que hacer scroll.
 */
function scrollWhenVisible(element) {
    // Caso 1: ya visible, esperamos el próximo frame
    if (element.offsetParent !== null) {
        requestAnimationFrame(() => {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return;
    }

    // Caso 2: panel oculto — buscamos el contenedor que tiene display:none
    // y observamos cuando cambie (cuando el usuario abra el panel)
    const hiddenPanel = element.closest('[style*="display: none"], [style*="display:none"], [hidden]')
        ?? document.getElementById('themes'); // fallback al panel de temas

    if (hiddenPanel) {
        const mutationObserver = new MutationObserver((_, obs) => {
            // Verificar que el elemento ya tiene layout visible
            if (element.offsetParent !== null) {
                obs.disconnect();
                requestAnimationFrame(() => {
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
            }
        });

        mutationObserver.observe(hiddenPanel, {
            attributes: true,                // detecta cambios en style, hidden, class
            attributeFilter: ['style', 'hidden', 'class'],
            subtree: false
        });
        return;
    }

    // Caso 3: fallback con IntersectionObserver
    const intersectionObserver = new IntersectionObserver((entries, obs) => {
        if (entries[0].isIntersecting) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            obs.disconnect();
        }
    }, { threshold: 0.1 });

    intersectionObserver.observe(element);
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
        await syncLastUpdated();
        notifyEditors('themes');
        Toast.show("Theme duplicated", "success");

        // Redirigir a pestaña de personalizados ANTES de renderizar
        const customTab = document.querySelector('#themes .qc__sub-tab[data-filter="custom"]');
        if (customTab) {
            customTab.click();
        }
        
        // Renderizamos la vista de temas personalizados para mostrar el nuevo tema
        renderThemes_(false);
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
            // Verificar si es el tema activo para restaurar vs-dark
            const syncResult = await chrome.storage.sync.get([G_PROPERTY_NAME]);
            const currentActive = syncResult[G_PROPERTY_NAME]?.themes?.active;
            let wasActive = false;
            
            // Se valida si el tema eliminado es el activo actualmente
            if (currentActive === themeValue) {
                wasActive = true;
                // Restaurar tema por defecto vs-dark
                const updatedSettings = {
                    ...syncResult[G_PROPERTY_NAME],
                    themes: {
                        ...syncResult[G_PROPERTY_NAME]?.themes,
                        active: 'vs-dark'
                    }
                };
                await chrome.storage.sync.set({ [G_PROPERTY_NAME]: updatedSettings });
            }

            // Eliminamos el tema de IndexedDB
            await DB.delete('themes', target.id);
            await syncLastUpdated();
            notifyEditors('themes');
            Toast.show(wasActive ? "Theme deleted. Default theme restored." : "Theme deleted", "success");
            renderThemes_(true);
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
            renderThemes_(false, document.getElementById('themeSearch').value|| '');
        });
    });
}

/**
 * Inicializa el buscador de temas por nombre. Filtra en tiempo real mientras se escribe.
 */
function initThemeSearch_() {
    // Listener para el buscador de temas
    document.getElementById('themeSearch')?.addEventListener('input', (e) => renderThemes_(false, e.target.value));
}