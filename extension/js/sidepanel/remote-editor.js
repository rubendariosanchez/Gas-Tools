"use strict";

/**
 * @fileoverview Adaptador del editor para el chat del Side Panel.
 *
 * El Side Panel es una página de la extensión: no comparte página con
 * Monaco. Cada operación se pide a la pestaña activa de esta ventana:
 *
 *   chrome.tabs.sendMessage(EDITOR_REQUEST) → content script
 *     → GAS_EDITOR_REQUEST (MAIN world, gas-tools.js) → GAS_EDITOR_RESPONSE
 *
 * Interfaz (todas async, nunca lanzan): `isAvailable`, `getInfo`,
 * `getStats`, `getSelection`, `getFile`, `getProject`, `insertAtCursor`,
 * `replaceSelection`, `replaceFile`, `listFiles`, `readFile`, `readFiles`,
 * `previewChanges`, `navigatePreview`, `closePreview`, `applyFileEdits`,
 * `applyChangeSet`, `saveProject`, `reloadPage`. Si la pestaña activa no es un editor de
 * Apps Script devuelven `{ available:false }` / `{ ok:false, error:'no-editor' }`.
 */
class GasRemoteEditor {
  /** URLs del editor de Apps Script (con o sin `/u/N/`). */
  static EDITOR_URL_RE = /^https:\/\/script\.google\.com\/(?:u\/\d+\/)?home\/projects\/[^/]+\/edit/;

  /**
   * @param {{tabs: {query: Function, sendMessage: Function}}} [chromeApi]
   *   Inyectable para tests; por defecto `chrome`.
   */
  constructor(chromeApi = (typeof chrome !== 'undefined' ? chrome : null), tabId = null) {
    this._chrome = chromeApi;
    // El panel es por pestaña: su URL lleva `?tabId=N` y siempre apunta a
    // esa pestaña. Sin tabId (compatibilidad) se usa la pestaña activa.
    this._tabId = Number.isInteger(tabId) ? tabId : null;
    /** Pestaña fija ya validada (evita `tabs.get` en cada petición). */
    this._tabCache = null;
    this._watchTab_();
  }

  /** Invalida la caché si la pestaña fija se cierra o cambia de URL. @private */
  _watchTab_() {
    if (this._tabId == null) return;
    const drop = (id) => { if (id === this._tabId) this._tabCache = null; };
    try {
      this._chrome?.tabs?.onRemoved?.addListener?.((id) => drop(id));
      this._chrome?.tabs?.onUpdated?.addListener?.((id, info) => { if (info?.url || info?.status === 'loading') drop(id); });
    } catch (_) { /* sin eventos de pestañas: sin caché efectiva */ }
  }

  /** Pestaña destino si es un editor de GAS; si no, `null`. */
  async _getTargetTab_() {
    if (this._tabCache) return this._tabCache;
    try {
      const tab = this._tabId != null
        ? await this._chrome.tabs.get(this._tabId)
        : (await this._chrome.tabs.query({ active: true, currentWindow: true }))[0];
      const ok = tab && GasRemoteEditor.EDITOR_URL_RE.test(tab.url || '') ? tab : null;
      // Solo se cachea la pestaña fija y si hay eventos para invalidarla
      if (ok && this._tabId != null && this._chrome?.tabs?.onRemoved) this._tabCache = ok;
      return ok;
    } catch (_) {
      return null;   // pestaña cerrada
    }
  }

  /**
   * Envía una acción al editor de la pestaña activa.
   * @returns {Promise<{ok:boolean, data?:*, error?:string}>}
   */
  async _request_(action, payload = {}) {
    const tab = await this._getTargetTab_();
    if (!tab) return { ok: false, error: 'no-editor' };
    try {
      const res = await this._chrome.tabs.sendMessage(tab.id, { type: 'EDITOR_REQUEST', action, payload });
      return res && typeof res === 'object' ? res : { ok: false, error: 'no-response' };
    } catch (err) {
      this._tabCache = null;
      // Pestaña sin content script (p. ej. se instaló la extensión con la
      // pestaña ya abierta): hay que recargarla.
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** Devuelve `data` si la respuesta trae un editor disponible. */
  async _data_(action, payload) {
    const res = await this._request_(action, payload);
    return res.ok && res.data?.available ? res.data : null;
  }

  async isAvailable() {
    return !!(await this._getTargetTab_());
  }

  /**
   * Archivo activo. Si no hay editor, `reason` explica por qué para que la
   * barra de contexto pueda dar la indicación correcta:
   *  - 'not-editor': la pestaña no es un editor de Apps Script.
   *  - 'reload-tab': es un editor pero sin content script (extensión
   *    recargada/instalada con la pestaña abierta) → hay que recargarla.
   *  - 'not-ready':  hay content script pero el editor aún no responde.
   */
  async getInfo() {
    const res = await this._request_('getInfo');
    if (res.ok && res.data?.available) return { available: true, fileName: res.data.fileName || '' };
    let reason = 'not-ready';
    if (res.error === 'no-editor') reason = 'not-editor';
    else if (/receiving end|could not establish connection/i.test(res.error || '')) reason = 'reload-tab';
    return { available: false, reason };
  }

  async getStats() {
    const data = await this._data_('getStats');
    if (!data) return { available: false, selectionChars: 0, fileChars: 0, projectChars: 0 };
    return {
      available: true,
      selectionChars: data.selectionChars || 0,
      fileChars: data.fileChars || 0,
      projectChars: data.projectChars || 0,
    };
  }

  async getSelection() {
    const data = await this._data_('getSelection');
    return data ? { available: true, text: data.text || '' } : { available: false, text: '' };
  }

  async getFile() {
    const data = await this._data_('getFile');
    return data
      ? { available: true, name: data.name || '', text: data.text || '', versionId: data.versionId }
      : { available: false, name: '', text: '' };
  }

  async getProject(maxChars) {
    const data = await this._data_('getProject', { maxChars });
    return data
      ? { available: true, files: data.files || [], omitted: data.omitted || [] }
      : { available: false, files: [], omitted: [] };
  }

  async insertAtCursor(text) {
    return this._editResult_(await this._request_('insertAtCursor', { text }));
  }

  async replaceSelection(text) {
    return this._editResult_(await this._request_('replaceSelection', { text }));
  }

  /** Reemplaza el contenido completo del archivo activo (botón "Apply" del diff). */
  async replaceFile(text) {
    return this._editResult_(await this._request_('replaceFile', { text }));
  }

  /** Lista de archivos del proyecto: `[{name, type, lines}]`. */
  async listFiles() {
    const data = await this._data_('listFiles');
    return data
      ? { available: true, files: Array.isArray(data.files) ? data.files : [] }
      : { available: false, files: [] };
  }

  /** Contenido completo de un archivo del proyecto por nombre. */
  async readFile(name) {
    const data = await this._data_('readFile', { name });
    if (!data) return { available: false, found: false, name: String(name || ''), text: '' };
    return { available: true, found: !!data.found, name: data.name || String(name || ''), text: data.text || '', versionId: data.versionId };
  }

  /** Varios archivos en un solo viaje: `files[i]` corresponde a `names[i]`. */
  async readFiles(names) {
    const list = Array.isArray(names) ? names.map((n) => String(n ?? '')) : [];
    const data = await this._data_('readFiles', { names: list });
    if (!data) return { available: false, files: list.map((name) => ({ found: false, name, text: '' })) };
    const files = Array.isArray(data.files) ? data.files : [];
    return {
      available: true,
      files: list.map((name, i) => {
        const f = files[i] || {};
        return { found: !!f.found, name: f.name || name, text: f.text || '', versionId: f.versionId };
      }),
    };
  }

  /**
   * Abre la vista de revisión de cambios en el editor (diff por archivo). Los
   * archivos en conflicto se excluyen y vuelven en `conflicts`.
   */
  async previewChanges(files, index = 0) {
    const res = await this._request_('previewChanges', { files: Array.isArray(files) ? files : [], index });
    const out = this._editResult_(res);
    const conflicts = res.data?.conflicts;
    return Array.isArray(conflicts) && conflicts.length ? { ...out, conflicts } : out;
  }

  async navigatePreview(index) {
    return this._editResult_(await this._request_('navigatePreview', { index }));
  }

  async closePreview() {
    return this._editResult_(await this._request_('closePreview'));
  }

  /** Aplica el contenido propuesto a un archivo (deshacible con Ctrl+Z en el editor). */
  async applyFileEdits(name, proposed) {
    return this._editResult_(await this._request_('applyFileEdits', { name, proposed }));
  }

  /**
   * Aplica un ChangeSet en un solo viaje (todo o nada). Reintentar tras un
   * timeout es seguro: el MAIN world es idempotente.
   * @param {Array<object>} files `{name, mode, batches?, proposed, baseVersionId?, key?}`
   * @returns {Promise<{ok:boolean, error?:string, results:Array<{name:string, status:string, reason?:string, failed?:Array, fuzzy?:number}>}>}
   */
  async applyChangeSet(files) {
    const res = await this._request_('applyChangeSet', { files: Array.isArray(files) ? files : [] });
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const results = (Array.isArray(data.results) ? data.results : []).map((r) => ({
      name: String(r?.name ?? ''),
      status: String(r?.status || 'error'),
      ...(r?.reason ? { reason: String(r.reason) } : {}),
      ...(Array.isArray(r?.failed) && r.failed.length ? { failed: r.failed } : {}),
      ...(r?.fuzzy ? { fuzzy: Number(r.fuzzy) || 0 } : {}),
    }));
    const ok = !!res.ok && data.ok === true;
    return ok ? { ok: true, results } : { ok: false, error: data.error || res.error || 'no-editor', results };
  }

  async saveProject() {
    return this._editResult_(await this._request_('saveProject'));
  }

  async reloadPage() {
    return this._editResult_(await this._request_('reloadPage'));
  }

  /** Normaliza el resultado de una edición (el error puede venir fuera o dentro de `data`). */
  _editResult_(res) {
    const ok = !!res.ok && res.data?.ok !== false;
    return ok ? { ok: true } : { ok: false, error: res.data?.error || res.error || 'no-editor' };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { GasRemoteEditor };
