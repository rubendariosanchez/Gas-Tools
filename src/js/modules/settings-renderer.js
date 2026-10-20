/**
 * @fileoverview Renderer declarativo de las opciones del popup.
 *
 * Genera secciones y componentes (option-toggle / option-select /
 * option-color) a partir de `SETTINGS_SCHEMA` y `SETTINGS_SECTIONS`.
 * No persiste nada: `settings.js` escucha los eventos de los componentes
 * (marcados con `data-setting-key`) y guarda.
 *
 * Marcado que espera en el HTML:
 *  - `[data-settings-tab="<tab>"]`: contenedor donde pintar las secciones.
 *  - `[data-settings-slot="header"]`: hueco del interruptor general.
 *  - `[data-section-slot="<sectionId>"]`: contenido estático extra que se
 *    mueve al final de esa sección (p. ej. el botón de restablecer).
 */

import { SETTINGS_SCHEMA, SETTINGS_SECTIONS } from '../utils/Variables.js';
import { tr } from '../utils/I18n.js';
import { createIcon } from '../utils/Icons.js';

// Etiqueta del componente según el tipo del esquema.
const TAG_BY_TYPE_ = { toggle: 'option-toggle', select: 'option-select', color: 'option-color' };

/**
 * Normaliza texto para buscar (minúsculas, sin tildes).
 * @param {string} text Texto de entrada.
 * @returns {string}
 */
export function normalizeSearchText(text) {
    return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Crea el componente de una entrada del esquema.
 * @param {Object} entry Entrada de SETTINGS_SCHEMA.
 * @param {Document} doc Documento destino.
 * @returns {HTMLElement}
 * @private
 */
function createControl_(entry, doc) {
    const el = doc.createElement(TAG_BY_TYPE_[entry.type]);
    el.id = entry.key;
    el.dataset.settingKey = entry.key;
    el.dataset.i18nTitle = entry.i18n.title;
    el.dataset.i18nDescription = entry.i18n.description;
    if (entry.options) {
        el.setAttribute('options', entry.options.map((o) => `${o.value}:${o.label}`).join(','));
    }
    if (entry.experimental) el.setAttribute('experimental', '');
    if (entry.parent) el.classList.add('gt-child');
    el.dataset.search = normalizeSearchText([
        tr(entry.i18n.title, entry.key),
        tr(entry.i18n.description, ''),
        entry.key,
        ...(entry.keywords || []),
    ].join(' '));
    return el;
}

/**
 * Crea el contenedor de una sección (plegable con <details> si procede).
 * @param {Object} section Entrada de SETTINGS_SECTIONS.
 * @param {Document} doc Documento destino.
 * @returns {{root: HTMLElement, body: HTMLElement}}
 * @private
 */
function createSection_(section, doc) {
    const titleId = `gt-sec-${section.id}`;
    const root = doc.createElement(section.collapsible ? 'details' : 'section');
    root.className = `gt-section${section.collapsible ? ' gt-section--collapsible' : ''}`;
    root.dataset.section = section.id;

    const title = doc.createElement(section.collapsible ? 'summary' : 'h2');
    title.className = 'gt-section__title';
    title.id = titleId;
    // Icono + texto en spans separados: applyI18n solo reescribe el texto.
    const icon = createIcon(section.icon || 'sliders', { className: 'gt-section__icon', doc });
    const label = doc.createElement('span');
    label.dataset.i18n = section.i18n;
    label.textContent = tr(section.i18n, section.id);
    title.append(icon, label);
    if (!section.collapsible) root.setAttribute('aria-labelledby', titleId);

    const body = doc.createElement('div');
    body.className = 'gt-section__body';
    root.append(title, body);
    return { root, body };
}

/**
 * Pinta las secciones y los controles del esquema en sus contenedores.
 * @param {Document} [doc=document] Documento del popup.
 * @returns {void}
 */
export function renderSettings(doc = document) {
    doc.querySelectorAll('[data-settings-tab]').forEach((container) => {
        const tab = container.dataset.settingsTab;
        const fragment = doc.createDocumentFragment();

        SETTINGS_SECTIONS.filter((s) => s.tab === tab).forEach((section) => {
            const { root, body } = createSection_(section, doc);
            let colorRow = null;

            SETTINGS_SCHEMA.filter((e) => e.section === section.id && !e.managed).forEach((entry) => {
                const control = createControl_(entry, doc);
                // Colores consecutivos: fila compacta.
                if (entry.type === 'color') {
                    if (!colorRow) {
                        colorRow = doc.createElement('div');
                        colorRow.className = `gt-color-row${entry.parent ? ' gt-child' : ''}`;
                        body.appendChild(colorRow);
                    }
                    control.setAttribute('compact', '');
                    control.classList.remove('gt-child');
                    colorRow.appendChild(control);
                    return;
                }
                colorRow = null;
                body.appendChild(control);
            });

            const slot = doc.querySelector(`[data-section-slot="${section.id}"]`);
            if (slot) {
                slot.hidden = false;
                body.appendChild(slot);
            }
            fragment.appendChild(root);
        });

        container.replaceChildren(fragment);
    });

    // Interruptor general en la cabecera (modo compacto).
    const headerSlot = doc.querySelector('[data-settings-slot="header"]');
    if (headerSlot) {
        SETTINGS_SCHEMA.filter((e) => e.tab === 'header' && !e.managed).forEach((entry) => {
            const control = createControl_(entry, doc);
            control.setAttribute('compact', '');
            headerSlot.appendChild(control);
        });
    }

    // Las hijas se habilitan/deshabilitan en vivo al cambiar el padre.
    doc.addEventListener('toggle', (e) => {
        const key = e.target?.dataset?.settingKey;
        if (key && SETTINGS_SCHEMA.some((entry) => entry.parent === key)) syncDependents(doc);
    });
}

/**
 * Aplica valores a los controles pintados.
 * @param {Object} values Mapa clave → valor.
 * @param {Document} [doc=document] Documento del popup.
 * @returns {void}
 */
export function applySettingValues(values, doc = document) {
    SETTINGS_SCHEMA.forEach((entry) => {
        if (!(entry.key in (values || {}))) return;
        const el = doc.getElementById(entry.key);
        if (!el || el.dataset.settingKey !== entry.key) return;
        const value = values[entry.key];
        if (entry.type === 'toggle') el.toggleAttribute('checked', value === true);
        else if (value !== undefined && value !== null && value !== '') el.setAttribute('value', String(value));
    });
    syncDependents(doc);
}

/**
 * Deshabilita las opciones hijas cuyo padre está apagado.
 * @param {Document} [doc=document] Documento del popup.
 * @returns {void}
 */
export function syncDependents(doc = document) {
    SETTINGS_SCHEMA.filter((e) => e.parent).forEach((entry) => {
        const el = doc.getElementById(entry.key);
        const parentEl = doc.getElementById(entry.parent);
        if (el && parentEl) el.toggleAttribute('disabled', !parentEl.hasAttribute('checked'));
    });
}

/**
 * Indexa para la búsqueda el contenido estático marcado con `data-search-i18n` (claves separadas por espacios).
 * @param {ParentNode} [root=document] Raíz donde buscar.
 * @returns {void}
 */
export function indexStaticSearch(root = document) {
    root.querySelectorAll('[data-search-i18n]').forEach((el) => {
        const texts = el.dataset.searchI18n.split(/\s+/).filter(Boolean).map((key) => tr(key, ''));
        el.dataset.search = normalizeSearchText([...texts, el.dataset.searchKeywords || ''].join(' '));
    });
}

/**
 * Filtra los elementos `[data-search]` de un panel y oculta las secciones vacías.
 * @param {HTMLElement} panel Panel de pestaña.
 * @param {string} query Texto buscado.
 * @returns {number} Elementos visibles.
 */
export function filterSettings(panel, query) {
    if (!panel) return 0;
    const q = normalizeSearchText(query);
    let visible = 0;

    panel.querySelectorAll('[data-search]').forEach((item) => {
        const match = !q || item.dataset.search.includes(q);
        item.hidden = !match;
        if (match) visible++;
    });

    // Contenedores: ocultos si no les queda ningún elemento visible.
    panel.querySelectorAll('.gt-color-row, .gt-section').forEach((box) => {
        const items = [...box.querySelectorAll('[data-search]')];
        box.hidden = Boolean(q) && !items.some((i) => !i.hidden);
        // Las secciones plegables se abren al encontrar algo y se cierran al limpiar.
        if (box.tagName === 'DETAILS') {
            if (q && !box.hidden && !box.open) { box.open = true; box.dataset.autoOpen = '1'; }
            if (!q && box.dataset.autoOpen) { box.open = false; delete box.dataset.autoOpen; }
        }
    });
    return visible;
}
