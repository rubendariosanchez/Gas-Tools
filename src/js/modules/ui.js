/**
 * @fileoverview Helpers de UI compartidos del popup.
 *
 * Utilidades transversales que no encajan en un módulo concreto:
 * navegación accesible entre pestañas (+ vista About), búsqueda común de
 * ajustes, modo de color (claro/oscuro según `ide-dark-mode`), estado del
 * interruptor general y estadísticas de la vista "About".
 */

import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { DB } from '../utils/Storage.js';
import { tr, getUiLocale } from '../utils/I18n.js';
import { filterSettings, indexStaticSearch } from './settings-renderer.js';

// Vistas con búsqueda de ajustes y con el aviso "se guarda automáticamente".
const SEARCHABLE_VIEWS_ = ['editor', 'tools', 'ai'];
const AUTOSAVE_VIEWS_ = ['editor', 'tools', 'ai', 'themes'];

// Clase canónica del modo oscuro (compartida con el IDE y el Side Panel).
const DARK_MODE_CLASS_ = 'qc__is-dark-mode';

// Espejo en localStorage para pintar el modo correcto sin esperar a IndexedDB.
const DARK_MODE_STORAGE_KEY_ = 'gasToolsDarkMode';

/**
 * Gestiona las pestañas (tablist accesible), el botón ⓘ de About y la búsqueda común.
 * @returns {void}
 */
export function initTabs_() {
    const tablist = document.querySelector('.qc__nav-tabs');
    const tabs = [...document.querySelectorAll('.qc__tab')];
    const aboutBtn = document.getElementById('aboutBtn');
    const searchInput = document.getElementById('settingsSearch');
    if (!tablist || !tabs.length) return;

    tablist.hidden = false;
    tablist.setAttribute('aria-label', tr('tablistLabel', 'Settings sections'));
    if (aboutBtn) aboutBtn.hidden = false;
    if (searchInput) searchInput.setAttribute('aria-label', tr('settingsSearchPlaceholder', 'Search settings'));
    indexStaticSearch(document);

    let lastTab = tabs.find((t) => t.classList.contains('qc__active')) || tabs[0];

    const selectTab_ = (tab, focus = false) => {
        lastTab = tab;
        tabs.forEach((t) => {
            const active = t === tab;
            t.classList.toggle('qc__active', active);
            t.setAttribute('aria-selected', String(active));
            t.tabIndex = active ? 0 : -1;
        });
        if (focus) tab.focus();
        showView_(tab.dataset.target);
    };

    tabs.forEach((tab) => tab.addEventListener('click', () => selectTab_(tab)));

    // Flechas ←/→, Inicio y Fin con tabindex itinerante.
    tablist.addEventListener('keydown', (e) => {
        const idx = tabs.indexOf(document.activeElement);
        if (idx === -1) return;
        const next = {
            ArrowRight: (idx + 1) % tabs.length,
            ArrowLeft: (idx - 1 + tabs.length) % tabs.length,
            Home: 0,
            End: tabs.length - 1,
        }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        selectTab_(tabs[next], true);
    });

    // ⓘ alterna entre About y la última pestaña.
    aboutBtn?.addEventListener('click', () => {
        if (aboutBtn.getAttribute('aria-pressed') === 'true') {
            selectTab_(lastTab);
            return;
        }
        tabs.forEach((t) => {
            t.classList.remove('qc__active');
            t.setAttribute('aria-selected', 'false');
        });
        showView_('about');
    });

    searchInput?.addEventListener('input', () => runSearch_(currentView_()));
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && searchInput.value) {
            e.preventDefault();
            searchInput.value = '';
            runSearch_(currentView_());
        }
    });

    showView_(lastTab.dataset.target);
}

/**
 * Id de la vista visible.
 * @returns {string}
 * @private
 */
function currentView_() {
    return document.querySelector('.qc__page.qc__active')?.id || '';
}

/**
 * Muestra una vista y ajusta búsqueda, pie y botón ⓘ.
 * @param {string} viewId Id del panel.
 * @returns {void}
 * @private
 */
function showView_(viewId) {
    document.querySelectorAll('.qc__page').forEach((p) => p.classList.toggle('qc__active', p.id === viewId));

    const aboutBtn = document.getElementById('aboutBtn');
    aboutBtn?.setAttribute('aria-pressed', String(viewId === 'about'));

    const searchBar = document.getElementById('settingsSearchBar');
    if (searchBar) searchBar.hidden = !SEARCHABLE_VIEWS_.includes(viewId);

    const footer = document.getElementById('appFooter');
    if (footer) footer.hidden = !AUTOSAVE_VIEWS_.includes(viewId);

    if (SEARCHABLE_VIEWS_.includes(viewId)) runSearch_(viewId);
    if (viewId === 'about') updateAboutStats_();
}

/**
 * Aplica la búsqueda común al panel indicado y muestra "Sin resultados".
 * @param {string} viewId Id del panel.
 * @returns {void}
 * @private
 */
function runSearch_(viewId) {
    const panel = document.getElementById(viewId);
    if (!panel || !SEARCHABLE_VIEWS_.includes(viewId)) return;
    const query = document.getElementById('settingsSearch')?.value || '';
    const visible = filterSettings(panel, query);
    const empty = panel.querySelector('[data-no-results]');
    if (empty) empty.hidden = !(query.trim() && visible === 0);
}

/**
 * Muestra solo About (popup abierto fuera del editor de Apps Script).
 * @returns {void}
 */
export function showAboutOnly_() {
    document.body.classList.add('qc--about-only');
    showView_('about');
    const footer = document.getElementById('appFooter');
    if (footer) footer.hidden = true;
}

/**
 * Aplica el modo de color del popup y lo recuerda para el siguiente arranque.
 * @param {boolean} isDark true = oscuro.
 * @returns {void}
 */
export function applyColorMode(isDark) {
    document.body.classList.toggle(DARK_MODE_CLASS_, Boolean(isDark));
    try { localStorage.setItem(DARK_MODE_STORAGE_KEY_, isDark ? '1' : '0'); } catch (_) { /* noop */ }
}

/**
 * Modo de color: espejo local al instante, luego IndexedDB y cambios en vivo de `ide-dark-mode`.
 * @returns {Promise<void>}
 */
export async function initColorMode_() {
    try {
        document.body.classList.toggle(DARK_MODE_CLASS_, localStorage.getItem(DARK_MODE_STORAGE_KEY_) === '1');
    } catch (_) { /* noop */ }

    document.addEventListener('toggle', (e) => {
        if (e.target?.dataset?.settingKey === 'ide-dark-mode') applyColorMode(e.detail.checked);
    });

    try {
        const data = await DB.get('settings', G_PROPERTY_NAME);
        applyColorMode(data?.options?.['ide-dark-mode'] === true);
    } catch (_) { /* sin DB: se mantiene el espejo local */ }
}

/**
 * Refleja "Activo/Pausado" junto al interruptor general.
 * @returns {void}
 */
export function initGlobalStatus_() {
    const control = document.getElementById('globalControl');
    const status = document.getElementById('globalStatus');
    if (!control || !status) return;
    control.hidden = false;

    const update_ = () => {
        const on = document.getElementById('global-enable')?.hasAttribute('checked') ?? true;
        status.textContent = on ? tr('statusActive', 'Active') : tr('statusPaused', 'Paused');
        control.title = status.textContent;
        status.classList.toggle('qc__global-status--on', on);
        control.classList.toggle('qc__global--on', on);
    };

    document.addEventListener('toggle', (e) => {
        if (e.target?.dataset?.settingKey === 'global-enable') update_();
    });
    document.addEventListener('gt-settings-loaded', update_);
    update_();
}

/**
 * Pinta la versión del manifest en About.
 * @returns {void}
 */
export function renderVersion_() {
    const el = document.getElementById('aboutVersion');
    if (!el) return;
    try {
        el.textContent = chrome.runtime.getManifest().version;
    } catch (_) {
        el.textContent = '';
    }
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
        const [userSnippets, userThemes, settingsData, syncResult] = await Promise.all([
            DB.getAll('snippets'),
            DB.getAll('themes'),
            DB.get('settings', G_PROPERTY_NAME).catch(() => null),
            chrome.storage.sync.get([G_PROPERTY_NAME]).catch(() => ({}))
        ]);

        // 2. Actualizar conteos en la UI
        snippetsCountEl.innerText = userSnippets.length;
        themesCountEl.innerText = userThemes.length;

        // 3. Última actualización: settings (IndexedDB) o snippets/temas (sync), la más reciente.
        const lastUpdated = latestTimestamp_(settingsData?.lastUpdated, syncResult?.[G_PROPERTY_NAME]?.lastUpdated);
        lastSyncEl.innerText = lastUpdated
            ? lastUpdated.toLocaleString(getUiLocale(), {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })
            : tr('statNever', 'Never');

    } catch (error) {
        console.error("Error actualizando estadísticas:", error);
        snippetsCountEl.innerText = "0";
        themesCountEl.innerText = "0";
    }
}

/**
 * Devuelve la fecha válida más reciente entre varias marcas ISO.
 * @param {...(string|undefined)} values Marcas de tiempo ISO.
 * @returns {Date|null}
 * @private
 */
function latestTimestamp_(...values) {
    const times = values.map((v) => (v ? Date.parse(v) : NaN)).filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)) : null;
}
