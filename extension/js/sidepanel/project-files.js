"use strict";

/**
 * @fileoverview Creación de archivos nuevos del proyecto desde el modo agente.
 *
 * Monaco no puede crear archivos de GAS, así que se usa la Apps Script API
 * (misma vía que el pull de GitHub y el borrado masivo):
 *   GOOGLE_GET_AUTH → GET_CONTENT → añadir archivos → PUT_CONTENT.
 * El caller debe guardar el editor ANTES (la API lee lo guardado, no Monaco)
 * y ofrecer recargar la pestaña DESPUÉS (Monaco no ve los archivos nuevos).
 */
const GasProjectFiles = (() => {
  /** Extensión → tipo de archivo de la Apps Script API. */
  const TYPE_BY_EXT = Object.freeze({ gs: 'SERVER_JS', js: 'SERVER_JS', html: 'HTML', json: 'JSON' });

  /** scriptId desde la URL del editor (`/home/projects/<id>/edit`). */
  function scriptIdFromUrl(url) {
    const m = String(url || '').match(/\/projects\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /**
   * Convierte una ruta tipo "Utils/Dates.gs" al par `{name, type}` de la API
   * ("Utils/Dates", SERVER_JS). Sin extensión conocida → SERVER_JS.
   */
  function toApiFile(path) {
    const clean = String(path || '').trim().replace(/^\/+/, '');
    const m = clean.match(/^(.*)\.(gs|js|html|json)$/i);
    const name = m ? m[1] : clean;
    const type = m ? TYPE_BY_EXT[m[2].toLowerCase()] : 'SERVER_JS';
    return { name, type };
  }

  /**
   * Crea archivos en el proyecto.
   * @param {Object} opts
   * @param {string} opts.scriptId
   * @param {Array<{path:string, content:string}>} opts.files
   * @param {(message:Object, fallback?:*) => Promise<*>} opts.sendToBackground
   * @returns {Promise<{ok:boolean, created?:string[], error?:string, existing?:string[]}>}
   *   Errores: 'auth-required', 'no-script-id', 'exists', 'api-error: …'.
   */
  async function createFiles({ scriptId, files, sendToBackground }) {
    if (!scriptId) return { ok: false, error: 'no-script-id' };
    const toCreate = (files || []).filter((f) => f?.path);
    if (!toCreate.length) return { ok: true, created: [] };

    const auth = await sendToBackground({ type: 'GOOGLE_GET_AUTH' }, null);
    if (!auth?.user) return { ok: false, error: 'auth-required' };

    const got = await sendToBackground({ type: 'GOOGLE_API_CALL', payload: { action: 'GET_CONTENT', payload: { scriptId } } }, null);
    if (!got?.ok) return { ok: false, error: `api-error: ${got?.error || 'GET_CONTENT failed'}` };
    const current = (got.data?.files || []).map((f) => ({ name: f.name, type: f.type, source: f.source ?? '' }));

    const taken = new Set(current.map((f) => `${f.name}|${f.type}`));
    const additions = toCreate.map((f) => ({ ...toApiFile(f.path), source: String(f.content ?? ''), path: f.path }));
    const existing = additions.filter((f) => taken.has(`${f.name}|${f.type}`)).map((f) => f.path);
    if (existing.length) return { ok: false, error: 'exists', existing };

    // Misma protección que el pull de GitHub: jamás enviar menos archivos de
    // los que ya tiene el proyecto (PUT reemplaza el conjunto completo).
    const next = [...current, ...additions.map(({ name, type, source }) => ({ name, type, source }))];
    if (next.length < current.length) return { ok: false, error: 'api-error: refusing to shrink the project' };

    const put = await sendToBackground({ type: 'GOOGLE_API_CALL', payload: { action: 'PUT_CONTENT', payload: { scriptId, files: next } } }, null);
    if (!put?.ok) return { ok: false, error: `api-error: ${put?.error || 'PUT_CONTENT failed'}` };
    return { ok: true, created: additions.map((f) => f.path) };
  }

  return Object.freeze({ scriptIdFromUrl, toApiFile, createFiles });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasProjectFiles };
