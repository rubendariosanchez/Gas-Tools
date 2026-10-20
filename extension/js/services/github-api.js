"use strict";

/**
 * @fileoverview Cliente de la API REST de GitHub usado desde el background.
 *
 * Vive en el service worker (no en MAIN world) porque solo el background
 * tiene `host_permissions` para `api.github.com` y los headers `Authorization`
 * son privados: nunca llegan al MAIN world ni a los content scripts.
 *
 * Cubre:
 *  - Validación del token (GET /user).
 *  - Listado y creación de repos.
 *  - Listado de ramas.
 *  - Push de múltiples archivos en un único commit (Git Data API).
 *  - Árbol con SHA de blob (rama y commit base) y descarga de blobs en paralelo.
 */

import { readHttpError } from './http-utils.js';

const GH_BASE     = 'https://api.github.com';
const GH_API_VER  = '2022-11-28';
const UA          = 'gas-tools-extension';

// Endpoints OAuth (Device Flow). Aceptan JSON cuando enviamos el header
// Accept correspondiente; sin él devuelven form-urlencoded.
const GH_DEVICE_CODE  = 'https://github.com/login/device/code';
const GH_DEVICE_TOKEN = 'https://github.com/login/oauth/access_token';

/**
 * Inicia el Device Flow. Devuelve los códigos que el usuario necesita
 * para completar la autorización en `verification_uri`.
 *
 * @param {string} clientId  Client ID de la OAuth App pública.
 * @param {string} scope     Scopes solicitados (ej. 'repo').
 * @returns {Promise<{
 *   device_code:string,
 *   user_code:string,
 *   verification_uri:string,
 *   expires_in:number,
 *   interval:number
 * }>}
 */
export async function startDeviceFlow(clientId, scope = 'repo') {
  if (!clientId) throw new Error('Missing GitHub client_id.');
  const res = await fetch(GH_DEVICE_CODE, {
    method:  'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
      'User-Agent':   UA,
    },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!res.ok) throw await _readError(res);
  const data = await res.json();
  if (!data?.device_code) throw new Error(data?.error_description || 'Device flow init failed.');
  return data;
}

/**
 * Hace una sola consulta al endpoint de token. Devuelve uno de:
 *   - { access_token: '...' }  si el usuario ya autorizó
 *   - { error: 'authorization_pending' }  esperar y reintentar
 *   - { error: 'slow_down' }  reintentar con interval mayor
 *   - { error: 'expired_token' | 'access_denied' | ... }  abortar
 *
 * @param {string} clientId
 * @param {string} deviceCode
 * @returns {Promise<{access_token?:string, token_type?:string, scope?:string, error?:string, error_description?:string}>}
 */
export async function pollDeviceToken(clientId, deviceCode) {
  const res = await fetch(GH_DEVICE_TOKEN, {
    method:  'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
      'User-Agent':   UA,
    },
    body: JSON.stringify({
      client_id:    clientId,
      device_code:  deviceCode,
      grant_type:   'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  // GitHub responde 200 incluso para errores funcionales (pending/slow_down).
  return res.json();
}

/** Construye los headers estándar para una llamada a la API de GitHub. */
function _headers(token, extra = {}) {
  return {
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': GH_API_VER,
    'User-Agent':           UA,
    'Authorization':        `Bearer ${token}`,
    ...extra,
  };
}

// ─────────────────────────────────────────────
// FETCH CON RETRY ANTE RATE LIMIT
// ─────────────────────────────────────────────

/**
 * Detecta si una respuesta corresponde a un rate limit secundario o
 * primario de GitHub. Cuando ocurre, GitHub responde con 403 (a veces
 * 429 en endpoints nuevos) y un cuerpo o un header informativo.
 *
 * @param {Response} res
 * @param {string}   bodyText  Cuerpo ya leído (texto).
 * @returns {boolean}
 */
function _isRateLimited(res, bodyText) {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  if (res.headers.get('Retry-After')) return true;
  if (res.headers.get('X-RateLimit-Remaining') === '0') return true;
  return /(secondary rate limit|exceeded a (?:secondary )?rate limit|abuse detection)/i.test(bodyText || '');
}

/**
 * Calcula cuánto esperar antes del siguiente reintento. Prioriza el
 * header `Retry-After` (segundos), luego `X-RateLimit-Reset` (epoch),
 * y finalmente un backoff exponencial. Cap a 60 s para no bloquear al
 * usuario indefinidamente.
 *
 * @param {Response} res
 * @param {number}   attempt  0-indexed
 * @returns {number}  Milisegundos a esperar.
 */
function _retryDelayMs(res, attempt) {
  const retryAfter = parseFloat(res.headers.get('Retry-After') || '');
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 60000);
  }
  const reset = parseInt(res.headers.get('X-RateLimit-Reset') || '', 10);
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset * 1000 - Date.now();
    if (wait > 0) return Math.min(wait, 60000);
  }
  // Backoff exponencial: 1s, 2s, 4s, 8s.
  return Math.min(1000 * Math.pow(2, attempt), 60000);
}

/**
 * Wrapper de `fetch` que reintenta automáticamente en caso de rate
 * limit secundario. Necesario para endpoints que se llaman varias veces
 * por operación (blobs en push, blobs en pull): sin esto un push de
 * muchos archivos basta para gatillar el rate limit y dejar al usuario
 * con un error que parece de auth.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{maxRetries?:number}} [opts]
 * @returns {Promise<Response>}
 */
async function _ghFetch(url, init, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    // Para el caller: leemos el body solo si vamos a decidir si
    // reintentar. Si decidimos no, devolvemos el Response intacto y el
    // caller hace su propio readHttpError.
    if (!_isRateLimited(res, '')) {
      // Necesitamos leer body solo para detectar el "secondary rate
      // limit" cuya señal está en el cuerpo. Clonamos para no consumir
      // el original.
      let body = '';
      try { body = await res.clone().text(); } catch (_) {}
      if (!_isRateLimited(res, body)) return res;
    }

    if (attempt === maxRetries) return res;

    const delay = _retryDelayMs(res, attempt);
    await new Promise((r) => setTimeout(r, delay));
  }

  // Inalcanzable; el bucle siempre devuelve antes.
  return fetch(url, init);
}

/**
 * Lee el cuerpo de una respuesta fallida y devuelve un Error descriptivo.
 * @param {Response} res
 * @returns {Promise<Error>}
 */
async function _readError(res) {
  return readHttpError(res, 'GitHub');
}

/**
 * Convierte un string UTF-8 a base64. Usa TextEncoder + chunks para no
 * desbordar en archivos grandes ni perder caracteres no-ASCII.
 * @param {string} str
 * @returns {string}
 */
function _toBase64(str) {
  const bytes = new TextEncoder().encode(str || '');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Decodifica un blob base64 (formato GitHub) a string UTF-8.
 * @param {string} b64
 * @returns {string}
 */
function _fromBase64(b64) {
  const binary = atob((b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

// ─────────────────────────────────────────────
// USUARIO
// ─────────────────────────────────────────────

/**
 * Valida el token contra `/user` y devuelve el perfil mínimo.
 * @param {string} token
 * @returns {Promise<{login:string, name:string|null, avatar_url:string, html_url:string}>}
 */
export async function getAuthenticatedUser(token) {
  const res = await _ghFetch(`${GH_BASE}/user`, { headers: _headers(token) });
  if (!res.ok) throw await _readError(res);
  const u = await res.json();
  return {
    login:      u.login,
    name:       u.name || null,
    avatar_url: u.avatar_url,
    html_url:   u.html_url,
  };
}

// ─────────────────────────────────────────────
// REPOS
// ─────────────────────────────────────────────

/**
 * Lista los repos accesibles por el token paginando hasta agotar la lista
 * o llegar al máximo. Devuelve todos los repos donde el usuario es
 * dueño, colaborador o miembro de la organización.
 *
 * @param {string} token
 * @param {{maxPages?:number}} [opts]
 * @returns {Promise<Array<{full_name:string, name:string, private:boolean, default_branch:string, html_url:string}>>}
 */
export async function listRepos(token, opts = {}) {
  const maxPages = opts.maxPages ?? 5;        // hasta 500 repos
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${GH_BASE}/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;
    const res = await _ghFetch(url, { headers: _headers(token) });
    if (!res.ok) throw await _readError(res);
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) break;
    for (const r of items) {
      all.push({
        full_name:      r.full_name,
        name:           r.name,
        private:        !!r.private,
        default_branch: r.default_branch,
        html_url:       r.html_url,
      });
    }
    // Si la página devolvió menos de 100, no hay más resultados.
    if (items.length < 100) break;
  }
  return all;
}

// ─────────────────────────────────────────────
// VALIDACIÓN DE ENTRADAS DEL MAIN WORLD
// ─────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[^\s~^:?*[\\]{1,255}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Valida `owner/repo` (nombres de GitHub) y lo separa.
 * @param {string} fullName
 * @returns {{owner:string, name:string}}
 * @throws {Error} Si no es un repo válido.
 */
export function parseRepo(fullName) {
  const s = String(fullName ?? '');
  const [owner, name] = s.split('/');
  if (!REPO_RE.test(s) || name === '.' || name === '..') throw new Error('Invalid repository name.');
  return { owner, name };
}

/**
 * Nombre de rama aceptable para la API (sin `..`, espacios, controles ni barras sueltas).
 * @param {string} branch
 * @returns {boolean}
 */
export function isValidBranch(branch) {
  return typeof branch === 'string' && BRANCH_RE.test(branch) && !CONTROL_RE.test(branch)
    && !branch.includes('..') && !branch.includes('//') && !branch.startsWith('/') && !branch.endsWith('/')
    && !branch.endsWith('.lock');
}

/** Codifica una ref de git segmento a segmento (`feature/x` → `feature/x`, sin `%2F`). */
const _encRef = (ref) => String(ref).split('/').map(encodeURIComponent).join('/');

/**
 * URL de la API bajo `/repos/{owner}/{name}/`, con segmentos codificados y prefijo verificado.
 * @param {string} repo `owner/repo`.
 * @param {string} suffix Resto de la ruta (ya codificado), con query opcional.
 * @returns {string}
 * @throws {Error} Si el repo no es válido o la URL resultante sale del prefijo.
 */
function _repoUrl(repo, suffix) {
  const { owner, name } = parseRepo(repo);
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/`;
  const url = `${GH_BASE}${prefix}${suffix}`;
  if (!new URL(url).pathname.startsWith(prefix)) throw new Error('Unsafe GitHub URL.');
  return url;
}

/** Error traducible: la rama avanzó con cambios que afectan a lo que se sube. */
function _branchChangedError() {
  const err = new Error('GH_BRANCH_CHANGED: The branch changed on GitHub. Recompute the diff.');
  err.code = 'BRANCH_CHANGED';
  return err;
}

/**
 * Crea un repositorio nuevo en la cuenta del usuario autenticado.
 * Inicializa con README para que tenga al menos un commit y una rama.
 * @param {string} token
 * @param {{name:string, isPrivate?:boolean, description?:string}} cfg
 * @returns {Promise<{full_name:string, default_branch:string, html_url:string}>}
 */
export async function createRepo(token, { name, isPrivate = true, description = '' }) {
  if (!REPO_NAME_RE.test(String(name ?? '')) || name === '.' || name === '..') throw new Error('Invalid repository name.');
  const res = await _ghFetch(`${GH_BASE}/user/repos`, {
    method:  'POST',
    headers: _headers(token, { 'Content-Type': 'application/json' }),
    body:    JSON.stringify({
      name,
      private:     isPrivate,
      description: description || 'Created from gas-tools extension',
      auto_init:   true,
    }),
  });
  if (!res.ok) throw await _readError(res);
  const r = await res.json();
  return {
    full_name:      r.full_name,
    default_branch: r.default_branch,
    html_url:       r.html_url,
  };
}

/**
 * Lista las ramas de un repo.
 * @param {string} token
 * @param {string} fullName  `owner/repo`
 * @returns {Promise<Array<{name:string, commitSha:string}>>}
 */
export async function listBranches(token, fullName) {
  const res = await _ghFetch(_repoUrl(fullName, 'branches?per_page=100'), {
    headers: _headers(token),
  });
  if (!res.ok) throw await _readError(res);
  const items = await res.json();
  return items.map((b) => ({ name: b.name, commitSha: b.commit?.sha || '' }));
}

/**
 * Crea una rama `name` en `repo` a partir de `fromBranch`.
 * @param {string} token
 * @param {{repo:string, name:string, fromBranch:string}} cfg
 * @returns {Promise<{name:string, commitSha:string}>}
 */
export async function createBranch(token, { repo, name, fromBranch }) {
  if (!repo || !name || !fromBranch) {
    throw new Error('createBranch requires repo, name and fromBranch.');
  }
  if (!isValidBranch(name) || !isValidBranch(fromBranch)) throw new Error('Invalid branch name.');

  const srcRes = await _ghFetch(_repoUrl(repo, `git/ref/heads/${_encRef(fromBranch)}`), { headers: _headers(token) });
  if (!srcRes.ok) throw await _readError(srcRes);
  const sha = (await srcRes.json())?.object?.sha;
  if (!sha) throw new Error('Could not resolve source branch SHA.');

  const res = await _ghFetch(_repoUrl(repo, 'git/refs'), {
    method:  'POST',
    headers: _headers(token, { 'Content-Type': 'application/json' }),
    body:    JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
  if (!res.ok) throw await _readError(res);

  return { name, commitSha: sha };
}

// ─────────────────────────────────────────────
// LECTURA DEL ÁRBOL (PULL)
// ─────────────────────────────────────────────

/** Descargas de blobs simultáneas (equilibrio entre velocidad y rate limit secundario). */
const BLOB_CONCURRENCY = 6;
/** Tope de archivos por árbol: más allá el diff y el rate limit se vuelven un problema. */
const TREE_HARD_CAP = 1000;
/** Tope de subárboles al recorrer a mano un árbol truncado. */
const MAX_SUBTREES = 200;
/** Blobs mayores se rechazan (binarios obvios). */
const MAX_BLOB_BYTES = 1_000_000;
/** Bytes máximos por llamada a `fetchBlobs` (respuesta por `sendResponse`). */
const MAX_BLOBS_TOTAL_BYTES = 20_000_000;

/**
 * Devuelve el SHA del commit referenciado por una rama (sin caché: decide el fast-forward).
 * @param {string} token
 * @param {string} fullName
 * @param {string} branch
 * @returns {Promise<string>}
 */
async function _getBranchCommitSha(token, fullName, branch) {
  const url = _repoUrl(fullName, `git/ref/heads/${_encRef(branch)}?_=${Date.now()}`);
  const res = await _ghFetch(url, {
    headers: _headers(token, { 'Cache-Control': 'no-cache' }),
    cache:   'no-store',
  });
  if (!res.ok) throw await _readError(res);
  return (await res.json())?.object?.sha;
}

/**
 * Árbol completo (recursivo) de un commit.
 * @param {string} token
 * @param {string} fullName
 * @param {string} commitSha
 * @returns {Promise<{treeSha:string, entries:Array<{path:string, sha:string, type:string, size:number}>, incomplete:boolean}>}
 */
async function _getTree(token, fullName, commitSha) {
  const cRes = await _ghFetch(_repoUrl(fullName, `git/commits/${encodeURIComponent(commitSha)}`), {
    headers: _headers(token),
  });
  if (!cRes.ok) throw await _readError(cRes);
  const treeSha = (await cRes.json())?.tree?.sha;

  const tRes = await _ghFetch(_repoUrl(fullName, `git/trees/${encodeURIComponent(treeSha)}?recursive=1`), {
    headers: _headers(token),
  });
  if (!tRes.ok) throw await _readError(tRes);
  const tree = await tRes.json();

  // `truncated: true` (más de 100k entradas o 7 MB): se recorre nivel a nivel.
  if (tree.truncated) {
    console.warn('[github-api] Tree truncated, walking subdirs manually for', fullName);
    const walked = await _walkTreeRecursively(token, fullName, treeSha);
    return { treeSha, entries: walked.entries, incomplete: walked.incomplete };
  }
  const entries = (tree.tree || [])
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha, type: e.type, size: e.size || 0 }));
  return { treeSha, entries, incomplete: false };
}

/**
 * Recorre un árbol truncado subdirectorio a subdirectorio (máx. `MAX_SUBTREES`).
 * @param {string} token
 * @param {string} fullName
 * @param {string} rootTreeSha
 * @returns {Promise<{entries:Array<{path:string,sha:string,type:string,size:number}>, incomplete:boolean}>}
 * @throws {Error} Si un subárbol no se puede leer (el árbol quedaría incompleto sin saberlo).
 */
async function _walkTreeRecursively(token, fullName, rootTreeSha) {
  const out = [];
  const queue = [{ sha: rootTreeSha, prefix: '' }];
  let visited = 0;

  while (queue.length) {
    if (visited >= MAX_SUBTREES) return { entries: out, incomplete: true };
    const { sha, prefix } = queue.shift();
    visited++;
    const res = await _ghFetch(_repoUrl(fullName, `git/trees/${encodeURIComponent(sha)}`), {
      headers: _headers(token),
    });
    if (!res.ok) throw await _readError(res);
    const data = await res.json();
    for (const e of (data.tree || [])) {
      const fullPath = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') queue.push({ sha: e.sha, prefix: fullPath });
      else if (e.type === 'blob') out.push({ path: fullPath, sha: e.sha, type: 'blob', size: e.size || 0 });
    }
  }
  return { entries: out, incomplete: false };
}

/**
 * Descarga el contenido de un blob por SHA como string UTF-8.
 * @param {string} token
 * @param {string} fullName
 * @param {string} blobSha
 * @returns {Promise<string>}
 * @throws {Error} Si falla o supera `MAX_BLOB_BYTES`.
 */
async function _getBlobContent(token, fullName, blobSha) {
  const res = await _ghFetch(_repoUrl(fullName, `git/blobs/${encodeURIComponent(blobSha)}`), {
    headers: _headers(token),
  });
  if (!res.ok) throw await _readError(res);
  const blob = await res.json();
  if ((blob.size || 0) > MAX_BLOB_BYTES) throw new Error('Blob too large.');
  if (blob.encoding === 'base64') return _fromBase64(blob.content);
  return blob.content || '';
}

/**
 * Ejecuta `fn` sobre cada elemento con como mucho `limit` promesas a la vez.
 * @param {Array} items Elementos de entrada.
 * @param {number} limit Concurrencia máxima.
 * @param {Function} fn `(item, index) => Promise`.
 * @returns {Promise<Array>} Resultados en el mismo orden.
 */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Filtra las entradas del árbol al `basePath` y devuelve rutas relativas (máx. `TREE_HARD_CAP`).
 * @param {Array<{path:string,sha:string,size:number}>} entries Blobs del árbol.
 * @param {string} base Carpeta normalizada (sin barras extremas) o ''.
 * @returns {{entries:Array<{path:string,sha:string,size:number}>, incomplete:boolean}}
 */
function _scopeEntries(entries, base) {
  const inScope = base ? entries.filter((e) => e.path.startsWith(`${base}/`)) : entries;
  const incomplete = inScope.length > TREE_HARD_CAP;
  if (incomplete) console.warn(`[github-api] Repo has ${inScope.length} files, capping at ${TREE_HARD_CAP}.`);
  return {
    incomplete,
    entries: inScope.slice(0, TREE_HARD_CAP).map((e) => ({
      path: base ? e.path.slice(base.length + 1) : e.path,
      sha:  e.sha,
      size: e.size || 0,
    })),
  };
}

/** Quita barras al inicio y al final de un `basePath`. */
const _normBase = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/**
 * Árbol de la rama (y del commit base, si se pide) con los SHA de blob, sin contenido.
 * `incomplete`/`baseIncomplete`: la lista no cubre todo el árbol (no deducir borrados).
 * @param {string} token
 * @param {{repo:string, branch:string, basePath?:string, baseSha?:string|null}} cfg
 * @returns {Promise<{branch:string, basePath:string, commitSha:string,
 *   files:Array<{path:string,sha:string,size:number}>, incomplete:boolean, baseSha:string|null,
 *   baseFiles:Array<{path:string,sha:string,size:number}>|null, baseIncomplete:boolean, baseMissing:boolean}>}
 * @throws {Error} Si falla la lectura (salvo base inexistente: 404/422 → `baseMissing`).
 */
export async function fetchRepoTree(token, { repo, branch, basePath = '', baseSha = null }) {
  const base = _normBase(basePath);
  const commitSha = await _getBranchCommitSha(token, repo, branch);
  const head = await _getTree(token, repo, commitSha);
  const scoped = _scopeEntries(head.entries, base);
  const files = scoped.entries;
  const incomplete = head.incomplete || scoped.incomplete;

  let baseFiles = null;
  let baseIncomplete = false;
  let baseMissing = false;
  const wantBase = typeof baseSha === 'string' && SHA_RE.test(baseSha);
  if (wantBase && baseSha === commitSha) {
    baseFiles = files;
    baseIncomplete = incomplete;
  } else if (wantBase) {
    try {
      const bt = await _getTree(token, repo, baseSha);
      const bs = _scopeEntries(bt.entries, base);
      baseFiles = bs.entries;
      baseIncomplete = bt.incomplete || bs.incomplete;
    } catch (err) {
      // Solo "no existe" (force push o rama reescrita) vale como base perdida.
      if (!/^GitHub (404|422)\b/.test(String(err?.message || ''))) throw err;
      baseMissing = true;
      console.warn('[github-api] base commit not found', baseSha);
    }
  }
  return {
    branch, basePath: base, commitSha, files, incomplete,
    baseSha: baseFiles ? baseSha : null, baseFiles, baseIncomplete, baseMissing,
  };
}

/**
 * Descarga varios blobs por SHA (sin duplicados, concurrencia 6, tope de bytes por llamada).
 * @param {string} token
 * @param {{repo:string, shas:string[]}} cfg
 * @returns {Promise<{blobs:Object<string,string>, failed:string[]}>} `failed`: no descargados (error, > 1 MB o tope).
 */
export async function fetchBlobs(token, { repo, shas }) {
  parseRepo(repo);
  const unique = [...new Set((Array.isArray(shas) ? shas : [])
    .filter((s) => typeof s === 'string' && SHA_RE.test(s)))].slice(0, TREE_HARD_CAP * 2);
  const blobs = {};
  const failed = [];
  let total = 0;
  await mapPool(unique, BLOB_CONCURRENCY, async (sha) => {
    if (total >= MAX_BLOBS_TOTAL_BYTES) { failed.push(sha); return; }
    try {
      const text = await _getBlobContent(token, repo, sha);
      total += text.length;
      if (total > MAX_BLOBS_TOTAL_BYTES) { failed.push(sha); return; }
      blobs[sha] = text;
    } catch (err) {
      failed.push(sha);
      console.warn('[github-api] skip blob', sha, err?.message);
    }
  });
  return { blobs, failed };
}

/**
 * Descarga todos los archivos de la rama (opcionalmente bajo `basePath`), en paralelo.
 * @param {string} token
 * @param {{repo:string, branch:string, basePath?:string}} cfg
 * @returns {Promise<{branch:string, basePath:string, commitSha:string, files:Array<{path:string, content:string, size:number}>}>}
 */
export async function fetchRepoFiles(token, { repo, branch, basePath = '' }) {
  const tree = await fetchRepoTree(token, { repo, branch, basePath });
  const wanted = tree.files.filter((e) => e.size <= MAX_BLOB_BYTES);
  const results = await mapPool(wanted, BLOB_CONCURRENCY, async (entry) => {
    try {
      return { path: entry.path, content: await _getBlobContent(token, repo, entry.sha), size: entry.size };
    } catch (err) {
      console.warn('[github-api] skip blob', entry.path, err?.message);
      return null;
    }
  });
  return { branch, basePath: tree.basePath, files: results.filter(Boolean), commitSha: tree.commitSha };
}

// ─────────────────────────────────────────────
// PUSH (Git Data API)
// ─────────────────────────────────────────────

/**
 * Sube varios archivos en un único commit (blobs → tree → commit → ref).
 * Con `expectedParentSha` (commit con el que se calculó el diff) solo sigue si la rama no
 * avanzó o si los commits nuevos no tocan ninguna de las rutas que se suben.
 *
 * @param {string} token
 * @param {{
 *   repo:     string,
 *   branch:   string,
 *   basePath?:string,
 *   files:    Array<{path:string, content:string}>,
 *   message:  string,
 *   force?:   boolean,
 *   expectedParentSha?: string|null,
 *   existingBlobs?: Map<string,string>|Object<string,string>|null,
 * }} cfg
 * @returns {Promise<{commitSha:string, parentSha:string|null, htmlUrl:string|null, branch:string}>}
 * @throws {Error} `code === 'BRANCH_CHANGED'` si la rama avanzó con cambios en esas rutas.
 */
export async function pushFiles(token, {
  repo, branch, basePath = '', files, message, force = false,
  existingBlobs = null, onProgress = null, expectedParentSha,
}) {
  if (!Array.isArray(files) || !files.length) throw new Error('No files to push.');
  if (!message) message = 'Update from gas-tools';
  const guarded = expectedParentSha !== undefined;
  if (guarded && expectedParentSha !== null && !SHA_RE.test(String(expectedParentSha))) {
    throw new Error('Invalid expected parent SHA.');
  }

  const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
  const base = norm(basePath);
  const fullPath = (p) => (base ? `${base}/${norm(p)}` : norm(p));
  const emit = (evt) => { try { onProgress && onProgress(evt); } catch (_) {} };
  const pushedPaths = new Set(files.map((f) => fullPath(f.path)));

  // Caché de blobs de un intento anterior (llega como objeto por el mensaje).
  const cached = existingBlobs instanceof Map
    ? existingBlobs
    : new Map(Object.entries(existingBlobs || {}).filter(([, s]) => typeof s === 'string' && SHA_RE.test(s)));

  /**
   * Permite pasar de `from` a `to` solo si `to` desciende de `from` sin tocar las rutas subidas.
   * @throws {Error} `BRANCH_CHANGED` en cualquier otro caso.
   */
  const ensureSafeAdvance = async (from, to) => {
    if ((from || null) === (to || null)) return;
    if (!from || !to) throw _branchChangedError();
    const res = await _ghFetch(_repoUrl(repo, `compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`), {
      headers: _headers(token),
    });
    if (!res.ok) throw _branchChangedError();
    const cmp = await res.json();
    const changed = Array.isArray(cmp?.files) ? cmp.files : null;
    // `ahead` = `to` desciende de `from`; la API corta en 300 archivos.
    if (cmp?.status !== 'ahead' || !changed || changed.length >= 300) throw _branchChangedError();
    if (changed.some((f) => pushedPaths.has(f.filename) || (f.previous_filename && pushedPaths.has(f.previous_filename)))) {
      throw _branchChangedError();
    }
  };

  // ── 0. Head actual y comprobación contra el commit comparado ─────────
  let parentSha = null;
  try {
    parentSha = await _getBranchCommitSha(token, repo, branch);
  } catch (_) {}
  if (guarded && !force) await ensureSafeAdvance(expectedParentSha, parentSha);

  emit({ type: 'phase', phase: 'blobs', total: files.length });

  // ── 1. Subir blobs en paralelo limitado (3 a la vez) ─────────────────
  const blobs = [];
  let done = 0;
  const queue = files.map((f) => ({ ...f }));
  const inFlight = [];
  const MAX_PARALLEL = 3;
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      const localPath = file.path;
      let sha = cached.get(localPath);
      let reused = false;

      if (sha) {
        reused = true;
      } else {
        const res = await _ghFetch(_repoUrl(repo, 'git/blobs'), {
          method:  'POST',
          headers: _headers(token, { 'Content-Type': 'application/json' }),
          body:    JSON.stringify({ content: _toBase64(file.content || ''), encoding: 'base64' }),
        });
        if (!res.ok) throw await _readError(res);
        sha = (await res.json()).sha;
      }
      blobs.push({ path: fullPath(localPath), sha, localPath });
      done++;
      emit({ type: 'blob', path: localPath, sha, reused, done, total: files.length });
    }
  };
  const uploaded = () => Object.fromEntries(blobs.map((b) => [b.localPath, b.sha]));
  for (let i = 0; i < Math.min(MAX_PARALLEL, files.length); i++) inFlight.push(worker());
  try {
    await Promise.all(inFlight);
  } catch (err) {
    err.uploadedBlobs = uploaded();
    throw err;
  }

  // ── 2. Helper: construye tree + commit basados en un parent dado ─────
  const buildCommit = async (parent) => {
    emit({ type: 'phase', phase: 'tree' });
    let baseTreeSha = null;
    if (parent) {
      const parentCommitRes = await _ghFetch(_repoUrl(repo, `git/commits/${encodeURIComponent(parent)}`), {
        headers: _headers(token),
      });
      if (parentCommitRes.ok) baseTreeSha = (await parentCommitRes.json())?.tree?.sha || null;
    }

    const treePayload = {
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    };
    if (baseTreeSha) treePayload.base_tree = baseTreeSha;

    const treeRes = await _ghFetch(_repoUrl(repo, 'git/trees'), {
      method:  'POST',
      headers: _headers(token, { 'Content-Type': 'application/json' }),
      body:    JSON.stringify(treePayload),
    });
    if (!treeRes.ok) throw await _readError(treeRes);
    const newTreeSha = (await treeRes.json()).sha;

    emit({ type: 'phase', phase: 'commit' });
    const commitBody = { message, tree: newTreeSha };
    if (parent) commitBody.parents = [parent];

    const commitRes = await _ghFetch(_repoUrl(repo, 'git/commits'), {
      method:  'POST',
      headers: _headers(token, { 'Content-Type': 'application/json' }),
      body:    JSON.stringify(commitBody),
    });
    if (!commitRes.ok) throw await _readError(commitRes);
    return commitRes.json();
  };

  /** Hace el PATCH/POST de la ref. @returns {Promise<{ok:boolean, error?:string, isFastForward?:boolean}>} */
  const updateRef = async (commitSha, hadParent) => {
    const url = hadParent ? _repoUrl(repo, `git/refs/heads/${_encRef(branch)}`) : _repoUrl(repo, 'git/refs');
    const res = await _ghFetch(url, {
      method:  hadParent ? 'PATCH' : 'POST',
      headers: _headers(token, { 'Content-Type': 'application/json' }),
      body:    hadParent
        ? JSON.stringify({ sha: commitSha, force })
        : JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
    });
    if (res.ok) return { ok: true };
    let text = '';
    try { text = await res.text(); } catch (_) {}
    return {
      ok: false,
      isFastForward: res.status === 422 && /not a fast forward/i.test(text),
      error: `GitHub ${res.status}: ${(text || res.statusText).slice(0, 240)}`,
    };
  };

  try {
    // ── 3. Commit sobre el head y movimiento de la ref ───────────────────
    let newCommit = await buildCommit(parentSha);
    emit({ type: 'phase', phase: 'ref' });
    let refResult = await updateRef(newCommit.sha, !!parentSha);

    // ── 4. Auto-rebase si la rama avanzó entre la lectura y el PATCH ─────
    // Con guarda, solo si los commits nuevos no tocan las rutas que se suben.
    if (parentSha && !force) {
      const backoffs = [200, 500, 1000];
      for (let i = 0; i < backoffs.length && !refResult.ok && refResult.isFastForward; i++) {
        await new Promise((r) => setTimeout(r, backoffs[i]));
        let realHead = null;
        try { realHead = await _getBranchCommitSha(token, repo, branch); } catch (_) {}
        if (!realHead || realHead === parentSha) continue;
        if (guarded) await ensureSafeAdvance(expectedParentSha ?? parentSha, realHead);
        parentSha = realHead;
        newCommit = await buildCommit(realHead);
        refResult = await updateRef(newCommit.sha, true);
      }
    }
    if (!refResult.ok) throw new Error(refResult.error);

    return {
      commitSha:     newCommit.sha,
      // Padre real del commit (cambia si hubo auto-rebase): el panel lo compara con el diff.
      parentSha:     parentSha || null,
      htmlUrl:       newCommit.html_url || null,
      branch,
      uploadedBlobs: uploaded(),
    };
  } catch (err) {
    // El caller reintenta sin re-subir los blobs ya creados.
    err.uploadedBlobs = uploaded();
    throw err;
  }
}

// ─────────────────────────────────────────────
// DESPACHADOR (usado por background.js)
// ─────────────────────────────────────────────

/** Acciones que reciben `payload.repo` y su campo de rama, si lo tienen. */
const REPO_ACTIONS = Object.freeze({
  LIST_BRANCHES: null,
  CREATE_BRANCH: null,
  FETCH_FILES:   'branch',
  FETCH_TREE:    'branch',
  FETCH_BLOBS:   null,
  PUSH_FILES:    'branch',
});

/**
 * Despacha una acción al cliente correspondiente. Valida `repo` y la rama que llegan
 * del MAIN world antes de construir cualquier URL.
 *
 * @param {string} action
 * @param {string} token
 * @param {Object} payload
 * @param {{onProgress?:Function}} [opts]
 * @returns {Promise<*>}
 * @throws {Error} Si la acción no existe o la entrada no es válida.
 */
export async function callGithubApi(action, token, payload = {}, opts = {}) {
  if (!token && action !== 'PING') throw new Error('Missing GitHub token.');
  const p = payload && typeof payload === 'object' ? payload : {};
  if (Object.prototype.hasOwnProperty.call(REPO_ACTIONS, action)) {
    parseRepo(p.repo);
    const branchField = REPO_ACTIONS[action];
    if (branchField && !isValidBranch(p[branchField])) throw new Error('Invalid branch name.');
  }

  switch (action) {
    case 'GET_USER':     return getAuthenticatedUser(token);
    case 'LIST_REPOS':   return listRepos(token);
    case 'LIST_BRANCHES':return listBranches(token, p.repo);
    case 'CREATE_BRANCH':return createBranch(token, p);
    case 'CREATE_REPO':  return createRepo(token, p);
    case 'FETCH_FILES':  return fetchRepoFiles(token, p);
    case 'FETCH_TREE':   return fetchRepoTree(token, p);
    case 'FETCH_BLOBS':  return fetchBlobs(token, p);
    case 'PUSH_FILES':   return pushFiles(token,
      { ...p, onProgress: opts.onProgress || null });
    default:             throw new Error(`Unknown GitHub action: ${action}`);
  }
}
