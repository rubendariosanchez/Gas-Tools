"use strict";

/**
 * @fileoverview Cliente de las APIs de Google usadas desde el background.
 *
 * Hoy cubre:
 *  - Identidad (GET /userinfo) para mostrar email + avatar.
 *  - Apps Script API: GET y PUT /v1/projects/{scriptId}/content para
 *    leer y escribir el contenido completo del proyecto. Es la fuente de
 *    verdad para Pull/Push porque, a diferencia de Monaco, devuelve TODOS
 *    los archivos del proyecto, no solo los pestañas abiertas.
 *
 * El token se obtiene vía `chrome.identity.getAuthToken` desde
 * `background.js` y nunca llega al MAIN world.
 *
 * Mapeo de tipos GAS ↔ extensiones de archivo:
 *   SERVER_JS  → .gs
 *   HTML       → .html
 *   JSON       → .json   (reservado para appsscript.json)
 */

import { readHttpError } from './_http-utils.js';

const SCRIPT_BASE = 'https://script.googleapis.com/v1/projects';
const USERINFO    = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Valida un token contra `userinfo` y devuelve el perfil mínimo. */
export async function getGoogleUser(token) {
  const res = await fetch(USERINFO, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw await _readError(res);
  const u = await res.json();
  return {
    email:   u.email   || null,
    name:    u.name    || null,
    picture: u.picture || null,
    sub:     u.sub     || null,
  };
}

/**
 * GET /v1/projects/{scriptId}/content
 * @returns {Promise<{
 *   scriptId: string,
 *   files: Array<{name:string, type:string, source:string, path:string}>
 * }>}
 *   El campo `path` se calcula a partir de `name` + `type` para que el
 *   panel pueda compararlo directamente contra los paths del repo
 *   (`Code.gs`, `appsscript.json`, `Sidebar.html`, etc.).
 */
export async function getProjectContent(token, scriptId) {
  if (!scriptId) throw new Error('Missing scriptId.');
  const res = await fetch(`${SCRIPT_BASE}/${encodeURIComponent(scriptId)}/content`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw await _readError(res);
  const data = await res.json();
  const files = (data.files || []).map((f) => ({
    name:   f.name,
    type:   f.type,
    source: f.source || '',
    path:   _toFsPath(f.name, f.type),
  }));
  return { scriptId: data.scriptId || scriptId, files };
}

/**
 * PUT /v1/projects/{scriptId}/content
 * Reemplaza el contenido completo del proyecto. GAS sincroniza en una
 * sola operación: crea archivos nuevos, actualiza los modificados y
 * borra los que no aparezcan en el array.
 *
 * @param {string} token
 * @param {string} scriptId
 * @param {Array<{name:string, type:string, source:string}>} files
 * @returns {Promise<{scriptId:string}>}
 */
export async function putProjectContent(token, scriptId, files) {
  if (!scriptId) throw new Error('Missing scriptId.');
  if (!Array.isArray(files)) throw new Error('files must be an array.');

  // Validamos antes de pegar al servidor: la API de Apps Script rechaza
  // peticiones con types desconocidos o nombres con extensión incluida.
  const sanitized = files.map((f) => {
    const name = String(f.name || '').replace(/\.(gs|html|json)$/i, '');
    const type = (f.type || '').toUpperCase();
    if (!name) throw new Error('File without name.');
    if (!['SERVER_JS', 'HTML', 'JSON'].includes(type)) {
      throw new Error(`Unsupported type "${type}" for "${name}".`);
    }
    return { name, type, source: String(f.source ?? '') };
  });

  const res = await fetch(`${SCRIPT_BASE}/${encodeURIComponent(scriptId)}/content`, {
    method:  'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ files: sanitized }),
  });
  if (!res.ok) throw await _readError(res);
  const data = await res.json();
  return { scriptId: data.scriptId || scriptId };
}

/**
 * Mapea (name, type) que devuelve la API a una ruta tipo filesystem
 * usando las extensiones convencionales. Coincide con la convención
 * de gas-github y con cómo `_collectProjectFiles_` deriva paths hoy.
 *
 * @param {string} name
 * @param {string} type  SERVER_JS | HTML | JSON
 * @returns {string}
 */
function _toFsPath(name, type) {
  if (!name) return '';
  switch ((type || '').toUpperCase()) {
    case 'SERVER_JS': return `${name}.gs`;
    case 'HTML':      return `${name}.html`;
    case 'JSON':      return `${name}.json`;
    default:          return name;
  }
}

/**
 * Mapea una extensión de archivo (.gs/.html/.json) al tipo aceptado por
 * la API. Útil para construir el payload del PUT desde paths del repo.
 *
 * @param {string} path
 * @returns {string|null}
 */
export function pathToScriptType(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.gs') || lower.endsWith('.js')) return 'SERVER_JS';
  if (lower.endsWith('.html')) return 'HTML';
  if (lower.endsWith('.json')) return 'JSON';
  return null;
}

/**
 * Despachador único usado por el background. Sigue el mismo patrón que
 * `callGithubApi` para que el flujo de mensajes quede simétrico.
 *
 * @param {string} action
 * @param {string} token
 * @param {Object} payload
 * @returns {Promise<*>}
 */
export async function callGoogleApi(action, token, payload = {}) {
  if (!token) throw new Error('Missing Google token.');
  switch (action) {
    case 'GET_USER':      return getGoogleUser(token);
    case 'GET_CONTENT':   return getProjectContent(token, payload.scriptId);
    case 'PUT_CONTENT':   return putProjectContent(token, payload.scriptId, payload.files || []);
    default:              throw new Error(`Unknown Google action: ${action}`);
  }
}

/** Construye un Error legible a partir de una respuesta HTTP fallida. */
async function _readError(res) {
  return readHttpError(res, 'Google');
}
