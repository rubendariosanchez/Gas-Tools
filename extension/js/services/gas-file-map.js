"use strict";

/**
 * @fileoverview Singleton global `window.gasFileMap`.
 *
 * Almacén compartido del mapa URI → nombre legible de archivo. Se
 * registra en `window` para que cualquier consumidor (web components,
 * servicios) lo lea directamente, sin que `gas-tools.js` tenga que
 * inyectarlo manualmente en cada uno.
 *
 * Extiende `EventTarget` para permitir que los componentes se suscriban
 * a `change` y refresquen su UI cuando el mapa se actualice. La actualización
 * es responsabilidad de `gas-tools.js`, que llama `replace()` tras cada
 * `_buildUriToNameMap`.
 *
 * API pública:
 *   - `has(uri)` / `get(uri)` / `entries()` / `keys()` / `forEach(fn)` /
 *     `size` para consultar.
 *   - `set(uri, name)` para añadir/actualizar una entrada.
 *   - `delete(uri)` / `clear()` para borrar.
 *   - `replace(otherMap)` para reemplazar el contenido en una sola
 *     notificación (caso típico tras `_buildUriToNameMap`).
 *   - Evento `'change'` cada vez que el mapa muta.
 */
class GasFileMap extends EventTarget {

  constructor() {
    super();
    /** @type {Map<string, string>} */
    this._map = new Map();
  }

  /** Cantidad de entradas. */
  get size() { return this._map.size; }

  /** @param {string} uri */
  has(uri) { return this._map.has(uri); }

  /** @param {string} uri */
  get(uri) { return this._map.get(uri); }

  entries() { return this._map.entries(); }
  keys()    { return this._map.keys(); }
  values()  { return this._map.values(); }

  /** @param {(value:string, key:string)=>void} fn */
  forEach(fn) { this._map.forEach(fn); }

  /**
   * Añade o actualiza una entrada y notifica.
   * @param {string} uri
   * @param {string} name
   */
  set(uri, name) {
    if (this._map.get(uri) === name) return;
    this._map.set(uri, name);
    this._notify_();
  }

  /** @param {string} uri */
  delete(uri) {
    if (!this._map.has(uri)) return;
    this._map.delete(uri);
    this._notify_();
  }

  /** Vacía el mapa y notifica si tenía contenido. */
  clear() {
    if (!this._map.size) return;
    this._map.clear();
    this._notify_();
  }

  /**
   * Reemplaza el contenido completo del mapa por el del Map dado.
   * Emite un único evento de cambio. Útil tras una reconstrucción
   * masiva en `gas-tools.js`.
   *
   * @param {Map<string,string>|null} other
   */
  replace(other) {
    this._map = (other instanceof Map) ? other : new Map();
    this._notify_();
  }

  /** @private */
  _notify_() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

// Singleton: si ya existe (recarga de scripts), conservamos la instancia
// para no perder los suscriptores actuales.
if (!window.gasFileMap) {
  window.gasFileMap = new GasFileMap();
}
