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
 *  - Pull del árbol y descarga del contenido por archivo.
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

/**
 * Crea un repositorio nuevo en la cuenta del usuario autenticado.
 * Inicializa con README para que tenga al menos un commit y una rama.
 * @param {string} token
 * @param {{name:string, isPrivate?:boolean, description?:string}} cfg
 * @returns {Promise<{full_name:string, default_branch:string, html_url:string}>}
 */
export async function createRepo(token, { name, isPrivate = true, description = '' }) {
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
  const res = await _ghFetch(`${GH_BASE}/repos/${fullName}/branches?per_page=100`, {
    headers: _headers(token),
  });
  if (!res.ok) throw await _readError(res);
  const items = await res.json();
  return items.map((b) => ({ name: b.name, commitSha: b.commit?.sha || '' }));
}

/**
 * Creates a new branch in `repo` based on `fromBranch`.
 *
 *   1. GET /git/ref/heads/<fromBranch> → commit SHA
 *   2. POST /git/refs with `refs/heads/<newBranch>` pointing at that SHA
 *
 * @param {string} token
 * @param {{repo:string, name:string, fromBranch:string}} cfg
 * @returns {Promise<{name:string, commitSha:string}>}
 */
export async function createBranch(token, { repo, name, fromBranch }) {
  if (!repo || !name || !fromBranch) {
    throw new Error('createBranch requires repo, name and fromBranch.');
  }

  // Resolve the source commit.
  const srcRes = await _ghFetch(
    `${GH_BASE}/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
    { headers: _headers(token) }
  );
  if (!srcRes.ok) throw await _readError(srcRes);
  const sha = (await srcRes.json())?.object?.sha;
  if (!sha) throw new Error('Could not resolve source branch SHA.');

  // Create the new ref.
  const res = await _ghFetch(`${GH_BASE}/repos/${repo}/git/refs`, {
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

/**
 * Devuelve el SHA del commit referenciado por una rama.
 * @param {string} token
 * @param {string} fullName
 * @param {string} branch
 * @returns {Promise<string>}
 */
async function _getBranchCommitSha(token, fullName, branch) {
  // `cache: 'no-store'` + cache-buster en el query: garantizamos que la
  // respuesta es del momento (no del cache del navegador ni proxies).
  // El SHA del head es lo que decide si un push será fast-forward, así
  // que necesitamos el valor en vivo aunque tarde un poco más.
  const url = `${GH_BASE}/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}?_=${Date.now()}`;
  const res = await _ghFetch(url, {
    headers: _headers(token, { 'Cache-Control': 'no-cache' }),
    cache:   'no-store',
  });
  if (!res.ok) throw await _readError(res);
  return (await res.json())?.object?.sha;
}

/**
 * Devuelve el árbol completo (recursivo) de un commit.
 * @param {string} token
 * @param {string} fullName
 * @param {string} commitSha
 * @returns {Promise<{treeSha:string, entries:Array<{path:string, sha:string, type:string, size:number}>}>}
 */
async function _getTree(token, fullName, commitSha) {
  // 1. Necesitamos el tree sha del commit.
  const cRes = await _ghFetch(`${GH_BASE}/repos/${fullName}/git/commits/${commitSha}`, {
    headers: _headers(token),
  });
  if (!cRes.ok) throw await _readError(cRes);
  const treeSha = (await cRes.json())?.tree?.sha;

  // 2. Pedimos el árbol recursivo.
  const tRes = await _ghFetch(`${GH_BASE}/repos/${fullName}/git/trees/${treeSha}?recursive=1`, {
    headers: _headers(token),
  });
  if (!tRes.ok) throw await _readError(tRes);
  const tree = await tRes.json();

  // GitHub puede devolver `truncated: true` cuando el árbol supera 100k
  // entradas o 7MB de payload. En ese caso la lista llega incompleta y
  // archivos que claramente existen en el repo no aparecen, y el panel
  // los confunde con "solo en GAS". Recursamos manualmente nivel a nivel
  // hasta cubrir todo.
  let entries;
  if (tree.truncated) {
    console.warn('[github-api] Tree truncated, walking subdirs manually for', fullName);
    entries = await _walkTreeRecursively(token, fullName, treeSha);
  } else {
    entries = (tree.tree || [])
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, sha: e.sha, type: e.type, size: e.size || 0 }));
  }

  return { treeSha, entries };
}

/**
 * Camina el árbol nivel a nivel cuando GitHub responde con
 * `truncated: true` al pedir el tree completo recursivo. Pide cada
 * subdirectorio por separado (sin `recursive`) y va acumulando blobs.
 *
 * @param {string} token
 * @param {string} fullName
 * @param {string} rootTreeSha
 * @returns {Promise<Array<{path:string,sha:string,type:string,size:number}>>}
 */
async function _walkTreeRecursively(token, fullName, rootTreeSha) {
  const out = [];
  /** @type {Array<{sha:string, prefix:string}>} */
  const queue = [{ sha: rootTreeSha, prefix: '' }];

  while (queue.length) {
    const { sha, prefix } = queue.shift();
    const res = await _ghFetch(`${GH_BASE}/repos/${fullName}/git/trees/${sha}`, {
      headers: _headers(token),
    });
    if (!res.ok) {
      console.warn('[github-api] Could not read subtree', sha, 'at', prefix);
      continue;
    }
    const data = await res.json();
    for (const e of (data.tree || [])) {
      const fullPath = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'tree') {
        queue.push({ sha: e.sha, prefix: fullPath });
      } else if (e.type === 'blob') {
        out.push({ path: fullPath, sha: e.sha, type: 'blob', size: e.size || 0 });
      }
    }
  }
  return out;
}

/**
 * Descarga el contenido de un blob por SHA y lo devuelve como string UTF-8.
 * @param {string} token
 * @param {string} fullName
 * @param {string} blobSha
 * @returns {Promise<string>}
 */
async function _getBlobContent(token, fullName, blobSha) {
  const res = await _ghFetch(`${GH_BASE}/repos/${fullName}/git/blobs/${blobSha}`, {
    headers: _headers(token),
  });
  if (!res.ok) throw await _readError(res);
  const blob = await res.json();
  if (blob.encoding === 'base64') return _fromBase64(blob.content);
  return blob.content || '';
}

/**
 * Pull: descarga todos los archivos de la rama indicada, opcionalmente
 * filtrados por un `basePath` (carpeta dentro del repo).
 *
 * @param {string} token
 * @param {{repo:string, branch:string, basePath?:string}} cfg
 * @returns {Promise<{branch:string, basePath:string, files:Array<{path:string, content:string, size:number}>}>}
 */
export async function fetchRepoFiles(token, { repo, branch, basePath = '' }) {
  const commitSha = await _getBranchCommitSha(token, repo, branch);
  const { entries } = await _getTree(token, repo, commitSha);

  const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
  const base = norm(basePath);

  const inScope = base
    ? entries.filter((e) => e.path === base || e.path.startsWith(`${base}/`))
    : entries;

  // Cap defensivo: 1000 archivos. Pasado ese punto el pull/diff sería
  // pesado y el rate limit de GitHub se vuelve un problema (cada blob
  // es una request). Lo subimos respecto al 200 anterior porque
  // proyectos GAS reales pueden tener varios cientos de archivos
  // distribuidos en carpetas.
  const HARD_CAP = 1000;
  if (inScope.length > HARD_CAP) {
    console.warn(
      `[github-api] Repo has ${inScope.length} files, capping at ${HARD_CAP}.`,
    );
  }
  const limited = inScope.slice(0, HARD_CAP);

  const files = [];
  for (const entry of limited) {
    // Saltamos binarios obvios (>1MB) para que el panel no se cuelgue.
    if (entry.size > 1_000_000) continue;
    try {
      const content = await _getBlobContent(token, repo, entry.sha);
      const relPath = base ? entry.path.slice(base.length + 1) : entry.path;
      files.push({ path: relPath, content, size: entry.size });
    } catch (err) {
      console.warn('[github-api] skip blob', entry.path, err?.message);
    }
  }

  return { branch, basePath: base, files };
}

// ─────────────────────────────────────────────
// PUSH (Git Data API)
// ─────────────────────────────────────────────

/**
 * Sube múltiples archivos en un único commit usando la Git Data API:
 *   1. GET ref → commit SHA padre
 *   2. POST blobs por archivo
 *   3. POST tree (basado en el árbol del padre + entradas nuevas)
 *   4. POST commit
 *   5. PATCH ref para mover la rama al nuevo commit
 *
 * @param {string} token
 * @param {{
 *   repo:     string,
 *   branch:   string,
 *   basePath?:string,
 *   files:    Array<{path:string, content:string}>,
 *   message:  string,
 *   force?:   boolean,
 * }} cfg
 * @returns {Promise<{commitSha:string, htmlUrl:string|null, branch:string}>}
 */
export async function pushFiles(token, {
  repo, branch, basePath = '', files, message, force = false,
  existingBlobs = null, onProgress = null,
}) {
  if (!Array.isArray(files) || !files.length) throw new Error('No files to push.');
  if (!message) message = 'Update from gas-tools';

  const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
  const base = norm(basePath);
  const fullPath = (p) => (base ? `${base}/${norm(p)}` : norm(p));
  const emit = (evt) => { try { onProgress && onProgress(evt); } catch (_) {} };

  // Cache de blobs ya subidos en intentos previos: si el caller pasa
  // `existingBlobs` (Map de path local → blob sha), reutilizamos esos
  // blobs en lugar de re-subirlos. Esto permite reintentar un push
  // que cayó a la mitad sin gastar cuota ni saturar el rate limit.
  const cached = existingBlobs instanceof Map ? existingBlobs : new Map();

  emit({ type: 'phase', phase: 'blobs', total: files.length });

  // ── 1. Subir blobs en paralelo limitado (3 a la vez) ─────────────────
  // 3 paralelos + retry con backoff balancea velocidad y estabilidad
  // frente al secondary rate limit de GitHub.
  const blobs = [];
  let done = 0;
  const queue = files.map((f) => ({ ...f, _idx: f.path }));
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
        const res = await _ghFetch(`${GH_BASE}/repos/${repo}/git/blobs`, {
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
  for (let i = 0; i < Math.min(MAX_PARALLEL, files.length); i++) inFlight.push(worker());
  try {
    await Promise.all(inFlight);
  } catch (err) {
    err.uploadedBlobs = Object.fromEntries(blobs.map((b) => [b.localPath, b.sha]));
    throw err;
  }

  // ── 2. Helper: construye tree + commit basados en un parent dado ─────
  const buildCommit = async (parentSha) => {
    emit({ type: 'phase', phase: 'tree' });
    let baseTreeSha = null;
    if (parentSha) {
      const parentCommitRes = await _ghFetch(`${GH_BASE}/repos/${repo}/git/commits/${parentSha}`, {
        headers: _headers(token),
      });
      if (parentCommitRes.ok) {
        baseTreeSha = (await parentCommitRes.json())?.tree?.sha || null;
      }
    }

    const treePayload = {
      tree: blobs.map((b) => ({ path: b.path, mode: '100644', type: 'blob', sha: b.sha })),
    };
    if (baseTreeSha) treePayload.base_tree = baseTreeSha;

    const treeRes = await _ghFetch(`${GH_BASE}/repos/${repo}/git/trees`, {
      method:  'POST',
      headers: _headers(token, { 'Content-Type': 'application/json' }),
      body:    JSON.stringify(treePayload),
    });
    if (!treeRes.ok) throw await _readError(treeRes);
    const newTreeSha = (await treeRes.json()).sha;

    emit({ type: 'phase', phase: 'commit' });
    const commitBody = { message, tree: newTreeSha };
    if (parentSha) commitBody.parents = [parentSha];

    const commitRes = await _ghFetch(`${GH_BASE}/repos/${repo}/git/commits`, {
      method:  'POST',
      headers: _headers(token, { 'Content-Type': 'application/json' }),
      body:    JSON.stringify(commitBody),
    });
    if (!commitRes.ok) throw await _readError(commitRes);
    return await commitRes.json();
  };

  // ── 3. Resolver el head actual de la rama (si existe) ────────────────
  let parentSha = null;
  try {
    parentSha = await _getBranchCommitSha(token, repo, branch);
  } catch (_) {}

  // ── 4. Crear commit basado en ese head ───────────────────────────────
  let newCommit = await buildCommit(parentSha);

  // ── 5. Mover (o crear) la ref con auto-rebase si hubo avance ─────────
  emit({ type: 'phase', phase: 'ref' });
  /** Hace el PATCH/POST de la ref. @returns {Promise<{ok:boolean, error?:string, isFastForward?:boolean}>} */
  const updateRef = async (commitSha, hadParent) => {
    const url = hadParent
      ? `${GH_BASE}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`
      : `${GH_BASE}/repos/${repo}/git/refs`;
    const method = hadParent ? 'PATCH' : 'POST';
    const body = hadParent
      ? JSON.stringify({ sha: commitSha, force })
      : JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha });

    const res = await _ghFetch(url, {
      method,
      headers: _headers(token, { 'Content-Type': 'application/json' }),
      body,
    });
    if (res.ok) return { ok: true };

    // Capturamos texto + status para decidir si reintentamos.
    let text = '';
    try { text = await res.text(); } catch (_) {}
    const isFastForward = res.status === 422 && /not a fast forward/i.test(text);
    return {
      ok: false,
      isFastForward,
      error: `GitHub ${res.status}: ${(text || res.statusText).slice(0, 240)}`,
    };
  };

  let refResult = await updateRef(newCommit.sha, !!parentSha);

  // ── 6. Auto-rebase con reintentos si la rama avanzó entre que leímos
  //      el head y el PATCH ─────────────────────────────────────────────
  // Pasa típicamente cuando dos pushes salen muy seguidos: el segundo ve
  // el head viejo (cache de GitHub) y el PATCH cae como non-fast-forward.
  // Releemos el head real, reconstruimos el commit con ese padre y
  // reintentamos. Hasta 3 intentos con backoff (200, 500, 1000 ms) para
  // dar tiempo a que el cache de la API propague.
  if (parentSha && !force) {
    const backoffs = [200, 500, 1000];
    for (let i = 0; i < backoffs.length && !refResult.ok && refResult.isFastForward; i++) {
      await new Promise((r) => setTimeout(r, backoffs[i]));

      let realHead = null;
      try { realHead = await _getBranchCommitSha(token, repo, branch); } catch (_) {}

      if (!realHead || realHead === parentSha) continue;
      parentSha = realHead;
      newCommit = await buildCommit(realHead);
      refResult = await updateRef(newCommit.sha, true);
    }
  }

  if (!refResult.ok) {
    // Pasamos el mapa de blobs ya subidos al caller para que pueda
    // reintentar sin re-subirlos.
    const err = new Error(refResult.error);
    err.uploadedBlobs = Object.fromEntries(blobs.map((b) => [b.localPath, b.sha]));
    throw err;
  }

  return {
    commitSha:     newCommit.sha,
    htmlUrl:       newCommit.html_url || null,
    branch,
    uploadedBlobs: Object.fromEntries(blobs.map((b) => [b.localPath, b.sha])),
  };
}

// ─────────────────────────────────────────────
// DESPACHADOR (usado por background.js)
// ─────────────────────────────────────────────

/**
 * Punto de entrada único llamado desde el background. Recibe la acción
 * y delega en la función correspondiente. Mantiene el background en una
 * sola línea por mensaje (mismo patrón que `callLlmProvider`).
 *
 * @param {string} action
 * @param {string} token
 * @param {Object} payload
 * @returns {Promise<*>}
 */
/**
 * Despacha una acción al cliente correspondiente.
 *
 * @param {string} action
 * @param {string} token
 * @param {Object} payload
 * @param {{onProgress?:Function}} [opts]
 * @returns {Promise<*>}
 */
export async function callGithubApi(action, token, payload = {}, opts = {}) {
  if (!token && action !== 'PING') throw new Error('Missing GitHub token.');

  switch (action) {
    case 'GET_USER':     return getAuthenticatedUser(token);
    case 'LIST_REPOS':   return listRepos(token);
    case 'LIST_BRANCHES':return listBranches(token, payload.repo);
    case 'CREATE_BRANCH':return createBranch(token, payload);
    case 'CREATE_REPO':  return createRepo(token, payload);
    case 'FETCH_FILES':  return fetchRepoFiles(token, payload);
    case 'PUSH_FILES':   return pushFiles(token,
      { ...payload, onProgress: opts.onProgress || null });
    default:             throw new Error(`Unknown GitHub action: ${action}`);
  }
}
