/**
 * Helpers de escape para interpolar datos en plantillas HTML del popup.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/** Escapa texto para contenido o atributos HTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** Devuelve el color si es hex válido (`#rgb` … `#rrggbbaa`); si no, `fallback`. */
export function safeColor(value, fallback = '') {
  const color = String(value ?? '').trim();
  return HEX_COLOR_RE.test(color) ? color : fallback;
}

/** Lista de colores de un tema (`"#a,#b"`) filtrada a hex válidos. */
export function safeColorList(value) {
  return String(value ?? '').split(',').map((c) => safeColor(c)).filter(Boolean);
}
