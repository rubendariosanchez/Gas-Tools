/**
 * Iconos SVG del popup a partir del registro compartido (`GasUi`, gas-ui.js).
 * Sin fuentes externas: `data-icon` en el HTML se hidrata al arrancar.
 */

// Iconos usados en pseudo-elementos CSS (`--qc-icon-*` → mask-image).
const CSS_ICONS = { 'chevron-down': 'chevronDown', 'search-off': 'searchOff', check: 'check' };

/** @returns {Object|null} API GasUi o null si gas-ui.js no cargó. */
function gasUi_() {
    return globalThis.GasUi || null;
}

/**
 * Marcado SVG de un icono (para plantillas).
 * @param {string} name Nombre del registro.
 * @param {number} [size=20] Lado en px.
 * @returns {string} `<svg>` o ''.
 */
export function icon(name, size = 20) {
    return gasUi_()?.icon(name, size) || '';
}

/**
 * Icono como nodo DOM.
 * @param {string} name Nombre del registro.
 * @param {number} [size=20] Lado en px.
 * @param {Document} [doc=document] Documento propietario.
 * @returns {SVGElement|null}
 */
export function iconNode(name, size = 20, doc = document) {
    return gasUi_()?.iconNode(doc, name, size) || null;
}

/**
 * Span `qc__symbol` con el icono (y su variante activa si se indica).
 * @param {string} name Nombre del registro.
 * @param {Object} [opts] Opciones.
 * @param {number} [opts.size=20] Lado en px.
 * @param {string} [opts.active] Icono para el estado activo (p. ej. `buildFill`).
 * @param {string} [opts.className] Clases extra.
 * @param {Document} [opts.doc=document] Documento propietario.
 * @returns {HTMLSpanElement}
 */
export function createIcon(name, { size = 20, active, className = '', doc = document } = {}) {
    const span = doc.createElement('span');
    span.className = `qc__symbol ${className}`.trim();
    span.setAttribute('aria-hidden', 'true');
    span.dataset.icon = name;
    if (active) span.dataset.iconActive = active;
    span.dataset.iconSize = String(size);
    fillIcon_(span, doc);
    return span;
}

/**
 * Inserta los SVG de un `[data-icon]` (idempotente).
 * @param {HTMLElement} el Contenedor.
 * @param {Document} doc Documento.
 * @private
 */
function fillIcon_(el, doc) {
    if (el.querySelector('svg')) return;
    const size = Number(el.dataset.iconSize) || 20;
    const idle = iconNode(el.dataset.icon, size, doc);
    if (!idle) return;
    if (!el.dataset.iconActive) { el.appendChild(idle); return; }
    const on = iconNode(el.dataset.iconActive, size, doc);
    idle.classList.add('qc__icon-idle');
    el.appendChild(idle);
    if (on) { on.classList.add('qc__icon-on'); el.appendChild(on); }
}

/**
 * Hidrata los `[data-icon]` y publica los iconos de pseudo-elementos como variables CSS.
 * @param {Document|HTMLElement} [root=document] Raíz a recorrer.
 * @returns {void}
 */
export function hydrateIcons(root = document) {
    const doc = root.ownerDocument || root;
    root.querySelectorAll('[data-icon]').forEach((el) => fillIcon_(el, doc));
    const ui = gasUi_();
    const style = doc.documentElement?.style;
    if (!ui || !style) return;
    for (const [cssName, name] of Object.entries(CSS_ICONS)) {
        const svg = ui.icon(name, 24).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
        if (svg) style.setProperty(`--qc-icon-${cssName}`, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    }
}
