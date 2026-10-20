"use strict";

/**
 * @fileoverview Service Worker (background) de la extensión Gas-Tools.
 *
 * Tres responsabilidades:
 *  1. Persistencia: lee y escribe IndexedDB (settings, snippets, themes)
 *     y `chrome.storage.sync` (tema activo, toggle global, API keys de
 *     LLMs, tokens GitHub, mapping repo↔scriptId).
 *  2. Proxy de APIs externas: enruta peticiones del editor (que vive en
 *     MAIN world) hacia OpenAI, Anthropic, Gemini, GitHub, Apps Script API.
 *     Centralizar las llamadas aquí mantiene los tokens fuera del MAIN.
 *  3. Device Flow OAuth: gestiona el flujo de autenticación de GitHub
 *     desde una pestaña popup.
 *
 * No mantiene estado vivo: como service worker MV3 puede dormirse en
 * cualquier momento. Toda la información debe persistirse antes de
 * responder.
 */

import { DB } from '../src/js/utils/Storage.js';
import { G_PROPERTY_NAME, DEFAULT_SNIPPETS, SETTINGS_SCHEMA_VERSION, normalizeSettings } from '../src/js/utils/Variables.js';
import { callLlmProvider, fetchProviderModels } from './js/services/llm-providers.js';
import { callLlmWithTools } from './js/services/llm-tools.js';
import { getActiveTheme } from './js/services/theme-service.js';
import { AI_PROVIDER_ORIGINS } from '../src/js/utils/Providers.js';
import { callGithubApi, startDeviceFlow, pollDeviceToken, getAuthenticatedUser } from './js/services/github-api.js';
import { callGoogleApi, getGoogleUser } from './js/services/google-api.js';

// ─────────────────────────────────────────────
// CLAVES DE STORAGE PARA GITHUB
// ─────────────────────────────────────────────
// Token y perfil del usuario son globales (una sola cuenta por extensión).
// El mapping de proyecto→repo se guarda por scriptId para soportar varios
// proyectos GAS desde la misma sesión sin re-configurar.
const GH_TOKEN_KEY    = 'gasToolsGithubAuth';      // { token, user } — storage.local
// Legacy: un único objeto { [scriptId]: config } en sync (límite 8 KB por
// clave). Ahora cada proyecto vive en su propia clave `GH_PROJECT_PREFIX + id`.
const GH_PROJECTS_KEY   = 'gasToolsGithubProjects';
const GH_PROJECT_PREFIX = 'gasToolsGhProject:';     // { repo, branch, basePath }

// ─────────────────────────────────────────────
// CLAVES DE STORAGE PARA LLM
// ─────────────────────────────────────────────
// La config no sensible (provider, modelo, prompts) sigue en sync. Las
// API keys viven SOLO en storage.local y nunca salen del background:
// el MAIN world recibe `apiKeysSet` (booleanos) y el background inyecta
// la key en cada LLM_CHAT_REQUEST.
const LLM_CONFIG_KEY  = 'gasToolsLlmConfig';
const LLM_SECRETS_KEY = 'gasToolsLlmSecrets';      // { [providerId]: apiKey } — storage.local

// Peticiones LLM en curso, para poder abortarlas con LLM_CANCEL.
// Clave: `${tabId}:${requestId}`.
const G_LLM_INFLIGHT = new Map();

// Página del Side Panel (chat). Global deshabilitado: solo se habilita por
// pestaña al abrirlo desde el editor (ver OPEN_SIDE_PANEL).
const SIDE_PANEL_PATH = 'extension/html/sidepanel.html';

/** Deshabilita el panel global para que no aparezca en pestañas ajenas a GAS. */
function _disableGlobalSidePanel() {
  try {
    chrome.sidePanel?.setOptions?.({ path: SIDE_PANEL_PATH, enabled: false })?.catch?.(() => {});
  } catch (_) { /* API no disponible */ }
}

// Los mensajes desde pestañas solo se aceptan del IDE de Apps Script.
const ALLOWED_TAB_ORIGIN = 'https://script.google.com/';

// Client ID de la OAuth App pública usada por la extensión. Es público
// por diseño (Device Flow no usa client_secret) y va embebido en el
// código para que la autenticación sea click → autorizar → conectado.
const GH_CLIENT_ID = 'Ov23liwkN4OIewqxXF7m';

// ─────────────────────────────────────────────
// CLAVES DE STORAGE PARA GOOGLE
// ─────────────────────────────────────────────
// Solo persistimos el perfil del usuario (email/avatar) para reabrir el
// panel sin tener que volver a llamar a userinfo. El token NO se guarda
// porque chrome.identity.getAuthToken ya lo cachea internamente y lo
// revoca/refresca cuando es necesario.
const GG_USER_KEY = 'gasToolsGoogleUser';

/**
 * Lee la auth global de GitHub desde chrome.storage.local. Si encuentra
 * la versión antigua en sync (antes se guardaba ahí), la migra a local
 * y la borra de sync para que el token deje de replicarse entre equipos.
 */
async function _getGithubAuth() {
  const local = await chrome.storage.local.get([GH_TOKEN_KEY]);
  if (local?.[GH_TOKEN_KEY]) return local[GH_TOKEN_KEY];

  const legacy = await chrome.storage.sync.get([GH_TOKEN_KEY]);
  const value  = legacy?.[GH_TOKEN_KEY] || null;
  if (value) {
    await chrome.storage.local.set({ [GH_TOKEN_KEY]: value });
    await chrome.storage.sync.remove(GH_TOKEN_KEY);
  }
  return value;
}

/** Guarda (o borra con `null`) la auth global de GitHub en storage.local. */
async function _setGithubAuth(value) {
  try {
    if (value) await chrome.storage.local.set({ [GH_TOKEN_KEY]: value });
    else       await chrome.storage.local.remove(GH_TOKEN_KEY);
    // Limpieza defensiva de la copia legacy en sync.
    await chrome.storage.sync.remove(GH_TOKEN_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────
// HELPERS DE LLM (config pública + secretos)
// ─────────────────────────────────────────────

/**
 * Lee las API keys desde storage.local. Migra el formato legacy en el que
 * `gasToolsLlmConfig.apiKeys` vivía en sync junto al resto de la config.
 * @returns {Promise<Object<string,string>>}
 */
async function _getLlmSecrets() {
  const local   = await chrome.storage.local.get([LLM_SECRETS_KEY]);
  const secrets = { ...(local?.[LLM_SECRETS_KEY] || {}) };

  const syncRes = await chrome.storage.sync.get([LLM_CONFIG_KEY]);
  const cfg     = syncRes?.[LLM_CONFIG_KEY];
  if (cfg?.apiKeys && typeof cfg.apiKeys === 'object') {
    for (const [provider, key] of Object.entries(cfg.apiKeys)) {
      if (key && !secrets[provider]) secrets[provider] = key;
    }
    const { apiKeys: _legacy, ...publicCfg } = cfg;
    await chrome.storage.local.set({ [LLM_SECRETS_KEY]: secrets });
    await chrome.storage.sync.set({ [LLM_CONFIG_KEY]: publicCfg });
  }
  return secrets;
}

/** Devuelve la config pública + `apiKeysSet` (sin secretos). */
async function _getPublicLlmConfig() {
  const secrets = await _getLlmSecrets();   // también migra el legacy
  const r   = await chrome.storage.sync.get([LLM_CONFIG_KEY]);
  const cfg = r?.[LLM_CONFIG_KEY] || null;
  const apiKeysSet = Object.fromEntries(
    Object.entries(secrets).filter(([, v]) => !!v).map(([k]) => [k, true])
  );
  if (!cfg && !Object.keys(apiKeysSet).length) return null;
  const { apiKeys: _drop, apiKeysSet: _drop2, ...publicCfg } = cfg || {};
  return { ...publicCfg, apiKeysSet };
}

/**
 * Persiste la config pública en sync y aplica `apiKeyUpdates` sobre los
 * secretos locales (string no vacío = guardar, null/'' = borrar).
 * Acepta también el formato legacy `apiKeys` (solo valores no vacíos).
 */
async function _saveLlmConfig(payload) {
  const {
    apiKeys, apiKeyUpdates, apiKeysSet: _ignored, aiContext: _ctx, requestId: _rid,
    ...publicCfg
  } = payload || {};

  const updates = { ...(apiKeyUpdates || {}) };
  if (apiKeys && typeof apiKeys === 'object') {
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (key && !(provider in updates)) updates[provider] = key;
    }
  }

  const secrets = await _getLlmSecrets();
  for (const [provider, key] of Object.entries(updates)) {
    if (typeof key === 'string' && key.trim()) secrets[provider] = key.trim();
    else delete secrets[provider];
  }

  await chrome.storage.local.set({ [LLM_SECRETS_KEY]: secrets });
  await chrome.storage.sync.set({ [LLM_CONFIG_KEY]: publicCfg });
  return true;
}

// Idioma de respuesta de la IA (pestaña AI Context del popup). 'auto' = no forzar.
const AI_LANGUAGE_KEY = 'gasToolsAiLanguage';
const AI_LANGUAGE_NAMES = {
  es: 'Spanish',
  en: 'English',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
};

/** Lee el código de idioma configurado (o 'auto'). */
async function _getAiLanguage() {
  let chosen = 'auto';
  try {
    const r = await chrome.storage.sync.get([AI_LANGUAGE_KEY]);
    chosen = r?.[AI_LANGUAGE_KEY] || 'auto';
  } catch (_) { /* sin storage: auto */ }
  if (chosen !== 'auto') return chosen;

  // "Auto" sigue el idioma de la interfaz (selector EN/ES del popup): con la
  // UI en español, las respuestas también salen en español. Con la UI en
  // inglés no se fuerza nada (el modelo responde en el idioma del usuario).
  try {
    const settings = await DB.get('settings', G_PROPERTY_NAME);
    return settings?.options?.['ui-language'] === 'es' ? 'es' : 'auto';
  } catch (_) {
    return 'auto';
  }
}

/**
 * Añade al mensaje `system` la instrucción de idioma. Se aplica en el
 * background para cubrir chat y autocompletado con una sola regla. Solo
 * afecta al lenguaje natural (explicaciones, comentarios), nunca a los
 * identificadores ni al código.
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} language
 * @returns {Array}
 */
function _applyResponseLanguage(messages, language) {
  const name = AI_LANGUAGE_NAMES[language];
  if (!name || !Array.isArray(messages)) return messages;

  const rule = `Language rule (overrides any previous language instruction): write all natural-language text — explanations, answers and code comments — in ${name}. Do not translate code, identifiers, API names or string literals that already exist.`;
  const idx = messages.findIndex((m) => m.role === 'system');
  if (idx === -1) return [{ role: 'system', content: rule }, ...messages];

  const copy = messages.slice();
  copy[idx] = { ...copy[idx], content: `${copy[idx].content || ''}\n\n${rule}` };
  return copy;
}

// ─────────────────────────────────────────────
// I18N DE LA UI INYECTADA
// ─────────────────────────────────────────────

// Cache en memoria mientras viva el SW: el JSON no cambia sin recargar la extensión.
const G_EDITOR_I18N_CACHE = new Map();

/**
 * Devuelve `{lang, messages}` con las claves `ed*` del idioma pedido, o
 * `null` para inglés (los componentes ya traen el inglés como fallback).
 * Resuelve placeholders con nombre (`$NAME$` → `$1`).
 * @param {string} lang
 */
async function _getEditorI18n(lang) {
  if (lang !== 'es') return null;
  if (G_EDITOR_I18N_CACHE.has(lang)) return G_EDITOR_I18N_CACHE.get(lang);
  const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
  if (!res.ok) return null;
  const raw = await res.json();
  const messages = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('ed') || typeof value?.message !== 'string') continue;
    const placeholders = value.placeholders || {};
    messages[key] = value.message.replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g,
      (m, name) => placeholders[name.toLowerCase()]?.content ?? m);
  }
  const dict = { lang, messages };
  G_EDITOR_I18N_CACHE.set(lang, dict);
  return dict;
}

// ─────────────────────────────────────────────
// PERMISOS OPCIONALES DE PROVEEDORES LLM
// ─────────────────────────────────────────────

/**
 * Error con `permissionOrigin` para que el panel indique al usuario qué
 * acceso debe conceder desde el popup (AI Context → Provider access).
 */
class MissingPermissionError extends Error {
  constructor(origin) {
    super(`Missing access to ${origin}. Grant it in the extension popup → AI Context → Provider access.`);
    this.name = 'MissingPermissionError';
    this.permissionOrigin = origin;
  }
}

/**
 * Devuelve los orígenes que necesita una petición. Para `custom` se deriva
 * del Endpoint URL, con puerto (solo localhost/127.0.0.1 son opcionales).
 * Falla en cerrado: proveedor desconocido o URL inválida lanzan error.
 * @returns {string[]}
 */
function _requiredOrigins(provider, endpointUrl) {
  if (provider === 'custom') {
    let u;
    try { u = new URL(endpointUrl || ''); } catch (_) { throw new Error('Invalid Endpoint URL for the Custom provider.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('The Endpoint URL must be http(s).');
    return [`${u.protocol}//${u.host}/*`];
  }
  const origins = AI_PROVIDER_ORIGINS[provider]?.origins;
  if (!origins?.length) throw new Error(`Unknown AI provider: ${provider}`);
  return origins;
}

/**
 * Endpoint efectivo: para `custom` sale de la config guardada (sync); si el
 * payload trae otro distinto, se rechaza. El resto no usa endpoint.
 * @returns {Promise<string|undefined>}
 */
async function _resolveEndpointUrl(provider, payloadUrl) {
  if (provider !== 'custom') return undefined;
  const r = await chrome.storage.sync.get([LLM_CONFIG_KEY]);
  const cfg = r?.[LLM_CONFIG_KEY] || {};
  const saved = String(cfg.providerSettings?.custom?.endpointUrl || cfg.endpointUrl || '').trim();
  if (!saved) throw new Error('Save the Endpoint URL for the Custom provider first.');
  if (payloadUrl && String(payloadUrl).trim() !== saved) {
    throw new Error('The Endpoint URL does not match the saved configuration. Save it first.');
  }
  return saved;
}

/** Lanza MissingPermissionError si falta algún origen requerido. */
async function _assertProviderPermission(provider, endpointUrl) {
  for (const origin of _requiredOrigins(provider, endpointUrl)) {
    const granted = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
    if (!granted) throw new MissingPermissionError(origin);
  }
}

/**
 * Pipeline común de una petición LLM: permisos → secretos → idioma → fetch.
 * @param {Object} payload  Sin `apiKey` (se ignora si viene).
 * @param {{signal:AbortSignal, onDelta?:(text:string)=>void}} opts
 * @returns {Promise<string>}
 */
async function _runLlmRequest(payload, { signal, onDelta } = {}) {
  const { apiKey: _ignored, requestId: _rid, ...cfg } = payload || {};
  const endpointUrl = await _resolveEndpointUrl(cfg.provider, cfg.endpointUrl);
  await _assertProviderPermission(cfg.provider, endpointUrl);
  const [secrets, language] = await Promise.all([_getLlmSecrets(), _getAiLanguage()]);
  const apiKey = secrets[cfg.provider] || '';
  const request = {
    ...cfg,
    endpointUrl,
    messages: _applyResponseLanguage(cfg.messages, language),
    apiKey,
    signal,
  };
  // Modo agente: con `tools` se hace una vuelta sin streaming y se devuelve
  // `{content, toolCalls, providerData}`; sin `tools`, texto (string).
  if (Array.isArray(cfg.tools) && cfg.tools.length) return callLlmWithTools(request);
  return callLlmProvider({ ...request, onDelta });
}

/**
 * Oculta secretos en un texto de error: `Bearer …` y las API keys indicadas.
 * @param {string} text
 * @param {string[]} [secrets]
 */
function _redactSecrets(text, secrets = []) {
  let out = String(text ?? '').replace(/Bearer\s+[^\s"',;}]+/gi, 'Bearer ***');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

/** Normaliza un error de LLM para enviarlo al MAIN world (sin secretos). */
async function _llmErrorPayload(err) {
  const aborted = err?.name === 'AbortError';
  const secrets = aborted ? [] : Object.values(await _getLlmSecrets().catch(() => ({})));
  return {
    aborted,
    error: aborted ? 'Cancelled.' : _redactSecrets(err?.message || err, secrets),
    permissionOrigin: err?.permissionOrigin || null,
  };
}

// ─────────────────────────────────────────────
// MAPPING GITHUB POR PROYECTO
// ─────────────────────────────────────────────

/** Migra el objeto legacy a claves por proyecto (una sola vez). */
async function _migrateGithubProjects() {
  const r = await chrome.storage.sync.get([GH_PROJECTS_KEY]);
  const legacy = r?.[GH_PROJECTS_KEY];
  if (!legacy || typeof legacy !== 'object') return;
  const entries = Object.fromEntries(
    Object.entries(legacy).filter(([, v]) => v).map(([id, v]) => [GH_PROJECT_PREFIX + id, v])
  );
  if (Object.keys(entries).length) await chrome.storage.sync.set(entries);
  await chrome.storage.sync.remove(GH_PROJECTS_KEY);
}

async function _getGithubProject(scriptId) {
  if (!scriptId) return null;
  await _migrateGithubProjects();
  const key = GH_PROJECT_PREFIX + scriptId;
  const r = await chrome.storage.sync.get([key]);
  return r?.[key] || null;
}

const GH_SCRIPT_ID_RE = /^[A-Za-z0-9_-]{20,120}$/;
const GH_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const GH_BRANCH_RE = /^[^\s~^:?*[\\]{1,255}$/;
const GH_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Normaliza la config de proyecto a la lista blanca `{repo, branch, basePath, baseSha?}`.
 * @param {object} config Config recibida del MAIN world.
 * @returns {{repo:string, branch:string, basePath:string, baseSha?:string}}
 * @throws {Error} Si algún campo obligatorio no es válido.
 */
function _cleanGithubProject(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid project config.');
  const { repo, branch, basePath = '', baseSha } = config;
  const repoName = typeof repo === 'string' ? repo.split('/')[1] : '';
  if (typeof repo !== 'string' || !GH_REPO_RE.test(repo) || repoName === '.' || repoName === '..') {
    throw new Error('Invalid repository.');
  }
  if (typeof branch !== 'string' || !GH_BRANCH_RE.test(branch) || branch.includes('..') || GH_CONTROL_RE.test(branch)) {
    throw new Error('Invalid branch.');
  }
  const path = typeof basePath === 'string' ? basePath : '';
  if (path.length > 512 || path.includes('..') || path.includes('\\') || GH_CONTROL_RE.test(path)) {
    throw new Error('Invalid base path.');
  }
  const clean = { repo, branch, basePath: path };
  if (typeof baseSha === 'string' && /^[0-9a-f]{40}$/.test(baseSha)) clean.baseSha = baseSha;
  return clean;
}

/**
 * Guarda la config del proyecto (lista blanca validada; `baseSha` solo si es un SHA válido).
 * @param {string} scriptId
 * @param {{repo:string,branch:string,basePath?:string,baseSha?:string}|null} config
 * @throws {Error} Si el scriptId o la config no son válidos.
 */
async function _saveGithubProject(scriptId, config) {
  if (typeof scriptId !== 'string' || !GH_SCRIPT_ID_RE.test(scriptId)) throw new Error('Invalid scriptId.');
  await _migrateGithubProjects();
  const key = GH_PROJECT_PREFIX + scriptId;
  if (!config) { await chrome.storage.sync.remove(key); return; }
  await chrome.storage.sync.set({ [key]: _cleanGithubProject(config) });
}

/**
 * Valida el origen de un mensaje: debe venir de esta extensión y, si viene
 * de una pestaña, del IDE en script.google.com (content script).
 */
function _isTrustedSender(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (!sender.tab) return true;   // popup / páginas de la extensión
  return typeof sender.url === 'string' && sender.url.startsWith(ALLOWED_TAB_ORIGIN);
}

// ─────────────────────────────────────────────
// HELPERS DE GOOGLE
// ─────────────────────────────────────────────

/** Lee el perfil de Google cacheado (sin tocar el token). */
function _getGoogleUserCached() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([GG_USER_KEY], (r) => resolve(r?.[GG_USER_KEY] || null));
  });
}

/** Persiste o limpia el perfil de Google. */
function _setGoogleUserCached(value) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [GG_USER_KEY]: value || null }, () => resolve(!chrome.runtime.lastError));
  });
}

/**
 * Pide un access token a chrome.identity. Si `interactive` es false y no
 * hay sesión cacheada, devuelve null (ideal para verificar al abrir).
 *
 * @param {{interactive?:boolean}} [opts]
 * @returns {Promise<string|null>}
 */
function _getGoogleToken({ interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!chrome.identity?.getAuthToken) {
      reject(new Error('chrome.identity is not available. Reload the extension.'));
      return;
    }
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chrome.runtime.lastError?.message || '';
        if (err) {
          // OAuth2 not granted o user not signed in son benignos para
          // verificación silenciosa: simplemente no hay sesión.
          if (!interactive && /(not granted|not signed in|user did not approve|invalidated)/i.test(err)) {
            resolve(null);
            return;
          }
          reject(new Error(err));
          return;
        }
        resolve(token || null);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Limpia el token cacheado por chrome.identity y opcionalmente lo revoca. */
function _clearGoogleToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve();
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        // Best-effort revoke. Si falla por offline/firewall, ya no hay
        // forma de revocar desde aquí; el usuario puede hacerlo en
        // myaccount.google.com.
        fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: 'POST',
        }).catch(() => {}).finally(resolve);
      });
    } catch (_) { resolve(); }
  });
}

// ─────────────────────────────────────────────
// DEVICE FLOW STATE
// ─────────────────────────────────────────────
// Mantenemos UNA sola sesión activa de Device Flow: si el usuario hace
// click dos veces, descartamos la anterior. Como el service worker de
// MV3 se duerme a los ~30 s aunque haya `setTimeout` pendientes, el
// polling se complementa con `chrome.alarms` (los alarms despiertan al
// SW): el flow nunca queda detenido aunque el SW haya entrado en idle.
let G_DEVICE_FLOW = null;
const G_DEVICE_FLOW_ALARM = 'gh-device-flow-poll';

/**
 * Inicia (o reinicia) un Device Flow. Resuelve cuando el usuario autoriza,
 * o rechaza con un Error si expira o el usuario lo deniega.
 *
 * @param {string} clientId
 * @param {string} scope     Scopes solicitados (ej. 'repo,user').
 * @param {(info:{user_code:string, verification_uri:string, expires_in:number}) => void} onCode
 *   Callback invocado en cuanto GitHub devuelve el user_code (para que el
 *   panel pueda mostrarlo y el background pueda abrir la pestaña).
 * @returns {Promise<{token:string, user:object}>}
 */
async function _runDeviceFlow(clientId, scope, onCode) {
  // 1. Cancelar cualquier flow previo en curso.
  if (G_DEVICE_FLOW?.cancel) G_DEVICE_FLOW.cancel();

  const init = await startDeviceFlow(clientId, scope);

  // Notificamos los códigos al panel inmediatamente.
  try { onCode?.(init); } catch (_) { /* el panel se cerró */ }

  let cancelled = false;
  const session = {
    cancel: () => { cancelled = true; _wakeFlow(); },
    /** windowId del popup de autorización; lo setea el caller. */
    popupWindowId: null,
    /** Resolver que el alarm/cancel/timer despierta. */
    wake: null,
  };
  G_DEVICE_FLOW = session;

  /** Cierra la ventana popup si sigue abierta. Idempotente. */
  const closePopup = () => {
    const id = session.popupWindowId;
    session.popupWindowId = null;
    if (id != null) {
      chrome.windows.remove(id).catch(() => { /* ya cerrada */ });
    }
  };

  /** Despierta el await del polling sin esperar al próximo alarm. */
  function _wakeFlow() {
    const w = session.wake; session.wake = null;
    if (w) w();
  }

  // El alarm es nuestro "timer que sobrevive al sleep del SW".
  const alarmListener = (alarm) => {
    if (alarm?.name === G_DEVICE_FLOW_ALARM) _wakeFlow();
  };
  chrome.alarms.onAlarm.addListener(alarmListener);

  /**
   * Espera `ms` milisegundos usando chrome.alarms (que sí mantiene vivo
   * al SW y lo despierta si se durmió). Si el flow se cancela en el
   * medio, _wakeFlow() lo resuelve antes de tiempo.
   */
  function waitWithAlarm(ms) {
    return new Promise((resolve) => {
      session.wake = resolve;
      // chrome.alarms tiene precisión mínima de 1 minuto en producción,
      // pero en desarrollo (extensión sin firmar) acepta intervalos más
      // cortos. Para garantizar que GitHub recibe los polls dentro del
      // intervalo solicitado usamos un setTimeout corto como respaldo:
      // si el SW está vivo, se dispara el setTimeout; si se durmió, el
      // alarm igual lo despierta cerca del minuto.
      try {
        // delayInMinutes mínimo 0.5 sin warning en MV3.
        chrome.alarms.create(G_DEVICE_FLOW_ALARM, {
          delayInMinutes: Math.max(ms / 60000, 0.5),
        });
      } catch (_) { /* fallback puro a setTimeout */ }
      setTimeout(_wakeFlow, ms);
    });
  }

  const expiresAt = Date.now() + (init.expires_in * 1000);
  let interval    = (init.interval || 5) * 1000;

  try {
    while (!cancelled) {
      if (Date.now() >= expiresAt) throw new Error('Authorization expired. Please try again.');
      await waitWithAlarm(interval);
      if (cancelled) throw new Error('Cancelled.');

      let resp;
      try { resp = await pollDeviceToken(clientId, init.device_code); }
      catch (err) { console.warn('[Background] Device poll failed:', err); continue; }

      if (resp.access_token) {
        const user = await getAuthenticatedUser(resp.access_token);
        return { token: resp.access_token, user };
      }

      switch (resp.error) {
        case 'authorization_pending':
          continue;                      // sigue esperando
        case 'slow_down':
          interval += 5000;              // GitHub pide bajar el ritmo
          continue;
        case 'expired_token':
          throw new Error('Authorization expired. Please try again.');
        case 'access_denied':
          throw new Error('Authorization was denied.');
        default:
          throw new Error(resp.error_description || resp.error || 'Unknown OAuth error.');
      }
    }
    throw new Error('Cancelled.');
  } finally {
    // Garantizamos cerrar la popup, parar el alarm y limpiar el listener
    // en TODOS los caminos: éxito, error, expiración, cancelación.
    closePopup();
    chrome.alarms.clear(G_DEVICE_FLOW_ALARM).catch(() => {});
    chrome.alarms.onAlarm.removeListener(alarmListener);
    if (G_DEVICE_FLOW === session) G_DEVICE_FLOW = null;
  }
}

/**
 * Cuando el usuario cierra la ventana popup manualmente, cancelamos el
 * flow para que la promesa resuelva con error en vez de quedar colgada
 * hasta `expires_in` (15 minutos).
 */
chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (G_DEVICE_FLOW?.popupWindowId === closedWindowId) {
    G_DEVICE_FLOW.popupWindowId = null;
    G_DEVICE_FLOW.cancel?.();
  }
});

// ─────────────────────────────────────────────
// UTILIDADES INTERNAS
// ─────────────────────────────────────────────

/** Obtiene los snippets finales (predeterminados + usuario) desde IndexedDB. */
async function _buildSnippets() {
  const userSnippets = await DB.getAll('snippets') || [];
  return [...DEFAULT_SNIPPETS, ...userSnippets];
}

/**
 * Envía un mensaje a las páginas abiertas de la extensión (Side Panel,
 * popup). Si no hay ninguna, Chrome rechaza con "Receiving end does not
 * exist": es lo normal y se ignora.
 * @param {Object} message
 */
function _sendToExtensionPages(message) {
  try {
    chrome.runtime.sendMessage(message)?.catch?.(() => { /* sin receptores */ });
  } catch (_) { /* sin receptores */ }
}

// Respaldo si el manifest no declara content_scripts (no debería ocurrir).
const EDITOR_URL_FALLBACK = ['https://script.google.com/home/projects/*/edit'];

/**
 * Patrones de URL del editor, tomados de los content_scripts del manifest (única fuente de verdad).
 * @returns {string[]}
 */
function _editorUrlPatterns() {
  try {
    const patterns = (chrome.runtime.getManifest?.()?.content_scripts || [])
      .flatMap((cs) => cs?.matches || []);
    return patterns.length ? [...new Set(patterns)] : EDITOR_URL_FALLBACK;
  } catch (_) {
    return EDITOR_URL_FALLBACK;
  }
}

/**
 * Notifica que cambió la config LLM: el autocompletado de cada pestaña de
 * GAS recarga su copia (vía content script) y el Side Panel puede refrescar.
 */
function _broadcastLlmConfigUpdated() {
  _sendToExtensionPages({ type: 'LLM_CONFIG_UPDATED' });
  chrome.tabs.query({ url: _editorUrlPatterns() }, (tabs) => {
    (tabs || []).forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: 'LLM_CONFIG_UPDATED' }).catch(() => { /* tab sin content script */ });
    });
  });
}

/**
 * Envía un payload a las páginas de la extensión y a las pestañas del editor GAS.
 * @param {Object} payload
 */
function _sendToTabs(payload) {
  _sendToExtensionPages({ type: 'SETTINGS_UPDATED', payload });
  chrome.tabs.query({ url: _editorUrlPatterns() }, (tabs) => {
    (tabs || []).forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'SETTINGS_UPDATED',
        payload,
      }).catch(err => {
        // "Receiving end does not exist" es esperado cuando el content script
        // todavía no está listo o ya fue descargado. Lo ignoramos silenciosamente.
        if (!err?.message?.includes('Receiving end does not exist')) {
          console.error('[Background] No se pudo enviar al tab:', tab.id, err.message);
        }
      });
    });
  });
}

// ─────────────────────────────────────────────
// MANEJADORES DE MENSAJES
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (!_isTrustedSender(sender)) {
    console.warn('[Background] Mensaje rechazado de origen no confiable:', sender?.url);
    return false;
  }

  // ── GET_SETTINGS ──────────────────────────────────────────────────
  if (msg.type === 'GET_SETTINGS') {
    DB.get('settings', G_PROPERTY_NAME)
      .then(data => sendResponse(normalizeSettings(data?.options)))
      .catch(() => sendResponse(normalizeSettings(null)));
    return true;
  }

  // ── GET_SNIPPETS ──────────────────────────────────────────────────
  if (msg.type === 'GET_SNIPPETS') {
    _buildSnippets()
      .then(snippets => sendResponse(snippets))
      .catch(err => { console.error('[BG] Error al obtener snippets:', err); sendResponse([]); });
    return true;
  }

  // ── OPEN_SIDE_PANEL ───────────────────────────────────────────────
  // Botón IA / atajos del editor. `sidePanel.open` exige gesto del usuario:
  // se invoca de inmediato (sin awaits previos) dentro del mensaje.
  //
  // Panel POR PESTAÑA: se habilita solo en la pestaña de GAS que lo pide
  // (con su tabId en la URL), así Chrome lo oculta al cambiar a otra
  // pestaña y lo vuelve a mostrar —con su conversación— al regresar.
  // `setOptions` no se espera: un await antes de `open` perdería el gesto.
  if (msg.type === 'OPEN_SIDE_PANEL') {
    const tabId = sender?.tab?.id;
    if (tabId == null || !chrome.sidePanel?.open) {
      sendResponse({ ok: false, error: 'Side panel not available.' });
      return true;
    }
    chrome.sidePanel.setOptions({ tabId, path: `${SIDE_PANEL_PATH}?tabId=${tabId}`, enabled: true })
      ?.catch?.(() => { /* se reporta vía open() */ });
    chrome.sidePanel.open({ tabId })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // ── GET_EDITOR_I18N ───────────────────────────────────────────────
  // Diccionario de la UI inyectada (claves `ed*`) para el idioma pedido.
  // Lo lee el background porque el content script no puede hacer fetch de
  // `_locales/` (Chrome lo bloquea si no es web_accessible_resource, y no
  // queremos exponerlo a la página).
  if (msg.type === 'GET_EDITOR_I18N') {
    _getEditorI18n(msg.payload?.lang)
      .then((dict) => sendResponse(dict))
      .catch(() => sendResponse(null));
    return true;
  }

  // ── GET_ACTIVE_THEME ──────────────────────────────────────────────
  if (msg.type === 'GET_ACTIVE_THEME') {
    getActiveTheme()
      .then(themeData => sendResponse(themeData))
      .catch(() => sendResponse(null));
    return true;
  }

  // ── NOTIFY_UPDATE ─────────────────────────────────────────────────
  if (msg.type === 'NOTIFY_UPDATE') {
    const { updateType } = msg;
    // Solo las páginas de la extensión (popup) pueden aportar el delta; una
    // pestaña no puede inyectar settings en las demás.
    const fromExtensionPage = !sender?.tab;
    const changed = fromExtensionPage && _isPlainObject(msg.changed) ? msg.changed : null;
    const sentOptions = fromExtensionPage && _isPlainObject(msg.options) ? msg.options : null;

    (async () => {
      try {
        if (updateType === 'settings') {
          // Con `changed` + `options` del popup no hace falta releer IndexedDB.
          const options = sentOptions
            ? normalizeSettings(sentOptions)
            : normalizeSettings((await DB.get('settings', G_PROPERTY_NAME))?.options);
          _sendToTabs(changed ? { options, changed, updateType } : { options, updateType });

        } else if (updateType === 'snippets') {
          const finalSnippets = await _buildSnippets();
          _sendToTabs({ data: finalSnippets, updateType });

        } else if (updateType === 'themes') {
          const themeData = await getActiveTheme();
          _sendToTabs({ data: themeData, updateType });
        }
      } catch (err) {
        console.error('[Background] Error en NOTIFY_UPDATE:', err);
      }
    })();

    sendResponse({ ok: true });
    return true;
  }

  // ── LLM_GET_CONFIG ────────────────────────────────────────────────
  // Nunca incluye API keys: solo `apiKeysSet` con booleanos.
  if (msg.type === 'LLM_GET_CONFIG') {
    _getPublicLlmConfig()
      .then((cfg) => sendResponse(cfg))
      .catch((err) => { console.error('[Background] LLM_GET_CONFIG:', err); sendResponse(null); });
    return true;
  }

  // ── LLM_SAVE_CONFIG ───────────────────────────────────────────────
  // Guardar config y listar modelos: solo páginas de la extensión (Side
  // Panel, popup), nunca una pestaña.
  if ((msg.type === 'LLM_SAVE_CONFIG' || msg.type === 'LLM_FETCH_MODELS') && sender?.tab) {
    sendResponse({ ok: false, error: 'Not allowed from a tab.' });
    return false;
  }

  if (msg.type === 'LLM_SAVE_CONFIG') {
    _saveLlmConfig(msg.payload)
      .then(() => { sendResponse({ ok: true }); _broadcastLlmConfigUpdated(); })
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // ── LLM_FETCH_MODELS ──────────────────────────────────────────────
  if (msg.type === 'LLM_FETCH_MODELS') {
    (async () => {
      try {
        const { provider, endpointUrl: requested } = msg.payload || {};
        if (!provider) throw new Error('Provider no especificado.');
        const endpointUrl = await _resolveEndpointUrl(provider, requested);
        await _assertProviderPermission(provider, endpointUrl);
        const secrets = await _getLlmSecrets();
        const apiKey = secrets[provider] || '';
        const models = await fetchProviderModels({ provider, apiKey, endpointUrl });
        sendResponse({ ok: true, models });
      } catch (err) {
        const { error, permissionOrigin } = await _llmErrorPayload(err);
        sendResponse({ ok: false, error, permissionOrigin });
      }
    })();
    return true;
  }

  // ── LLM_CANCEL ────────────────────────────────────────────────────
  // Aborta el fetch real hacia el proveedor (evita pagar tokens de
  // peticiones que el editor ya descartó).
  if (msg.type === 'LLM_CANCEL') {
    const key  = `${sender?.tab?.id ?? 'ext'}:${msg.payload?.requestId}`;
    const ctrl = G_LLM_INFLIGHT.get(key);
    if (ctrl) { ctrl.abort(); G_LLM_INFLIGHT.delete(key); }
    sendResponse({ ok: !!ctrl });
    return true;
  }

  // ── GET_GLOBAL_AI_CONTEXT ─────────────────────────────────────────
  if (msg.type === 'GET_GLOBAL_AI_CONTEXT') {
    chrome.storage.sync.get(['gasToolsAiContext'], (result) => {
      sendResponse(result['gasToolsAiContext'] || null);
    });
    return true;
  }

  // ── LLM_CHAT_REQUEST ──────────────────────────────────────────────
  // La API key se resuelve aquí desde storage.local; cualquier `apiKey`
  // que venga en el payload se ignora.
  if (msg.type === 'LLM_CHAT_REQUEST') {
    const requestId = msg.payload?.requestId;
    const key  = `${sender?.tab?.id ?? 'ext'}:${requestId}`;
    const ctrl = new AbortController();
    if (requestId) G_LLM_INFLIGHT.set(key, ctrl);

    (async () => {
      try {
        const result = await _runLlmRequest(msg.payload, { signal: ctrl.signal });
        if (result && typeof result === 'object') {
          sendResponse({ ok: true, content: result.content || '', toolCalls: result.toolCalls || [], providerData: result.providerData || null });
        } else {
          sendResponse({ ok: true, content: result });
        }
      } catch (err) {
        sendResponse({ ok: false, ...(await _llmErrorPayload(err)) });
      } finally {
        if (G_LLM_INFLIGHT.get(key) === ctrl) G_LLM_INFLIGHT.delete(key);
      }
    })();
    return true;
  }

  // ── GITHUB_GET_AUTH ───────────────────────────────────────────────
  // Devuelve `{ user }` o `null`. El token NUNCA sale del background.
  if (msg.type === 'GITHUB_GET_AUTH') {
    _getGithubAuth()
      .then((auth) => sendResponse(auth?.token && auth?.user ? { user: auth.user } : null))
      .catch(() => sendResponse(null));
    return true;
  }

  // ── GITHUB_AUTHENTICATE ───────────────────────────────────────────
  // Inicia el Device Flow:
  //   1. POST /login/device/code → user_code, verification_uri
  //   2. chrome.tabs.create(verification_uri) en una pestaña nueva
  //   3. Avisa al panel con GITHUB_DEVICE_CODE_READY (con user_code)
  //   4. Polling al endpoint de token hasta éxito/error/expiración
  //   5. GET /user con el token y persistencia
  if (msg.type === 'GITHUB_AUTHENTICATE') {
    (async () => {
      try {
        const result = await _runDeviceFlow(GH_CLIENT_ID, 'repo,user', (info) => {
          // Abrimos github.com/login/device en una VENTANA popup (sin barra
          // de direcciones, sin tabs), igual que el flujo de Google OAuth.
          // Adjuntamos `user_code` en el query para que GitHub lo pre-rellene.
          const verifyUrl = info.verification_uri_complete
                         || `${info.verification_uri}?user_code=${encodeURIComponent(info.user_code)}`;

          // Dimensiones tipo modal de OAuth: lo suficientemente cómodo para
          // ver el formulario de "Authorize" sin sentirse encajonado.
          chrome.windows.create({
            url:    verifyUrl,
            type:   'popup',
            width:  560,
            height: 720,
            focused: true,
          }).then((win) => {
            // Guardamos el windowId en la sesión activa para poder cerrarla
            // automáticamente cuando el flow termine (éxito o error).
            if (G_DEVICE_FLOW) G_DEVICE_FLOW.popupWindowId = win.id;
          }).catch((err) => {
            console.warn('[Background] No se pudo abrir popup OAuth:', err);
          });

          // Notificamos a los content scripts conectados con los datos
          // del código para que el panel los muestre como respaldo.
          chrome.tabs.query({ url: 'https://script.google.com/*' }, (tabs) => {
            tabs.forEach((tab) => {
              chrome.tabs.sendMessage(tab.id, {
                type:    'GITHUB_DEVICE_CODE',
                payload: {
                  user_code:        info.user_code,
                  verification_uri: info.verification_uri,
                  expires_in:       info.expires_in,
                },
              }).catch(() => { /* tab cerrada */ });
            });
          });
        });

        await _setGithubAuth({ token: result.token, user: result.user });
        sendResponse({ ok: true, user: result.user });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // ── GITHUB_CANCEL_AUTH ────────────────────────────────────────────
  if (msg.type === 'GITHUB_CANCEL_AUTH') {
    G_DEVICE_FLOW?.cancel?.();
    sendResponse({ ok: true });
    return true;
  }

  // ── GITHUB_LOGOUT ─────────────────────────────────────────────────
  if (msg.type === 'GITHUB_LOGOUT') {
    _setGithubAuth(null).then((ok) => sendResponse({ ok }));
    return true;
  }

  // ── GITHUB_GET_PROJECT_CONFIG ─────────────────────────────────────
  // Devuelve la config del proyecto identificado por scriptId, o null.
  if (msg.type === 'GITHUB_GET_PROJECT_CONFIG') {
    _getGithubProject(msg.payload?.scriptId)
      .then((cfg) => sendResponse(cfg))
      .catch(() => sendResponse(null));
    return true;
  }

  // ── GITHUB_SAVE_PROJECT_CONFIG ────────────────────────────────────
  if (msg.type === 'GITHUB_SAVE_PROJECT_CONFIG') {
    const { scriptId, config } = msg.payload || {};
    if (!scriptId) { sendResponse({ ok: false, error: 'scriptId requerido' }); return true; }
    _saveGithubProject(scriptId, config)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // ── GITHUB_API_CALL ───────────────────────────────────────────────
  // Despacho genérico para todas las llamadas autenticadas (list repos,
  // create, branches, push, fetch). El token se inyecta aquí desde
  // storage para que NUNCA viaje al MAIN world. Cuando la acción es
  // PUSH_FILES, reenviamos eventos de progreso al tab originador para
  // que el panel pueda pintar el avance archivo a archivo.
  if (msg.type === 'GITHUB_API_CALL') {
    const { action, payload, requestId } = msg.payload || {};
    const tabId = sender?.tab?.id ?? null;

    const onProgress = (action === 'PUSH_FILES' && tabId)
      ? (evt) => {
          chrome.tabs.sendMessage(tabId, {
            type:    'GH_PUSH_PROGRESS',
            payload: { requestId, ...evt },
          }).catch(() => { /* tab cerrada o recargada */ });
        }
      : null;

    (async () => {
      try {
        const auth = await _getGithubAuth();
        if (!auth?.token) throw new Error('Not authenticated.');
        const data = await callGithubApi(action, auth.token, payload || {}, { onProgress });
        sendResponse({ ok: true, data });
      } catch (err) {
        // El mensaje puede citar cabeceras o URLs: nunca el token.
        const auth = await _getGithubAuth().catch(() => null);
        sendResponse({
          ok: false,
          error: _redactSecrets(err?.message || err, [auth?.token]),
          uploadedBlobs: err?.uploadedBlobs || null,
        });
      }
    })();
    return true;
  }

  // ── GOOGLE_GET_AUTH ───────────────────────────────────────────────
  // Verificación silenciosa: si chrome.identity tiene un token válido,
  // devolvemos el perfil cacheado; si no, null. No pedimos consentimiento.
  if (msg.type === 'GOOGLE_GET_AUTH') {
    (async () => {
      try {
        const token = await _getGoogleToken({ interactive: false });
        if (!token) {
          await _setGoogleUserCached(null);
          sendResponse(null);
          return;
        }
        // Si tenemos token pero no perfil cacheado (primer arranque tras
        // recarga), lo refrescamos.
        let user = await _getGoogleUserCached();
        if (!user) {
          try { user = await getGoogleUser(token); await _setGoogleUserCached(user); }
          catch (e) {
            // Token presente pero inválido: lo descartamos para forzar
            // re-login en el siguiente intento interactivo.
            await _clearGoogleToken(token);
            sendResponse(null);
            return;
          }
        }
        sendResponse({ user });
      } catch (err) {
        console.warn('[Background] GOOGLE_GET_AUTH failed:', err);
        sendResponse(null);
      }
    })();
    return true;
  }

  // ── GOOGLE_AUTHENTICATE ───────────────────────────────────────────
  // Login interactivo: muestra el consent screen de Google la primera
  // vez. Si el usuario ya autorizó la extensión, normalmente devuelve
  // el token sin UI.
  if (msg.type === 'GOOGLE_AUTHENTICATE') {
    (async () => {
      try {
        const token = await _getGoogleToken({ interactive: true });
        if (!token) {
          sendResponse({ ok: false, error: 'No token returned by Chrome.' });
          return;
        }
        const user = await getGoogleUser(token);
        await _setGoogleUserCached(user);
        sendResponse({ ok: true, user });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // ── GOOGLE_LOGOUT ─────────────────────────────────────────────────
  // Limpia el token cacheado, intenta revocarlo y borra el perfil
  // persistido. La cuenta queda con un consent expirado: el siguiente
  // login mostrará el consent screen de nuevo.
  if (msg.type === 'GOOGLE_LOGOUT') {
    (async () => {
      try {
        const token = await _getGoogleToken({ interactive: false }).catch(() => null);
        if (token) await _clearGoogleToken(token);
        await _setGoogleUserCached(null);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // ── GOOGLE_API_CALL ───────────────────────────────────────────────
  // Despachador genérico (GET_USER / GET_CONTENT / PUT_CONTENT). Si el
  // token cacheado expiró, lo refrescamos transparentemente con un
  // segundo intento; si sigue sin existir, fallamos para que el panel
  // pida login.
  if (msg.type === 'GOOGLE_API_CALL') {
    const { action, payload } = msg.payload || {};
    (async () => {
      try {
        let token = await _getGoogleToken({ interactive: false });
        if (!token) throw new Error('Not authenticated with Google.');
        try {
          const data = await callGoogleApi(action, token, payload || {});
          sendResponse({ ok: true, data });
        } catch (err) {
          // 401/403: el token cacheado caducó. Lo descartamos y reintentamos
          // una sola vez con uno nuevo (sigue siendo no-interactivo: si
          // chrome.identity no puede emitir uno, el panel lo avisa).
          if (/\b(401|403)\b/.test(String(err?.message || ''))) {
            await _clearGoogleToken(token);
            token = await _getGoogleToken({ interactive: false });
            if (!token) throw new Error('Session expired. Please reconnect Google.');
            const data = await callGoogleApi(action, token, payload || {});
            sendResponse({ ok: true, data });
            return;
          }
          throw err;
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // ── DOWNLOAD_GAS_PROJECT ──────────────────────────────────────────
  // Pide al endpoint same-origin de GAS el proyecto en formato ZIP usando
  // las cookies de sesión del usuario (host_permissions para
  // script.google.com lo permite). Devuelve el ZIP como ArrayBuffer
  // serializado para que el content/MAIN script lo convierta en blob y
  // dispare la descarga.
  if (msg.type === 'DOWNLOAD_GAS_PROJECT') {
    const scriptId = msg.scriptId;
    if (!scriptId) {
      sendResponse({ ok: false, error: 'Missing scriptId' });
      return true;
    }
    const url = `https://script.google.com/feeds/download/export?id=${encodeURIComponent(scriptId)}&format=json`;

    // Se realiza la petición
    fetch(url, { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Google devuelve JSON, no ZIP
      const json = await res.json();
      sendResponse({ ok: true, data: json });
    })
    .catch((err) => {
      console.error('[Background] DOWNLOAD_GAS_PROJECT falló:', err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true;
  }
});

// ─────────────────────────────────────────────
// STREAMING LLM (chrome.runtime.Port 'llm-stream')
// ─────────────────────────────────────────────
// Un puerto por petición. El content script envía `{type:'start', payload}`
// y opcionalmente `{type:'cancel'}`; el background responde con
// `{type:'delta', text}`, `{type:'done', content}` o `{type:'error', ...}`.
// Cerrar el puerto (pestaña cerrada, recarga) también aborta el fetch.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'llm-stream') return;
  if (!_isTrustedSender(port.sender)) { port.disconnect(); return; }

  const ctrl = new AbortController();
  let closed = false;
  const post_ = (message) => {
    if (closed) return;
    try { port.postMessage(message); } catch (_) { closed = true; }
  };

  port.onDisconnect.addListener(() => { closed = true; ctrl.abort(); });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'cancel') { ctrl.abort(); return; }
    if (msg?.type !== 'start') return;
    try {
      const content = await _runLlmRequest(msg.payload, {
        signal: ctrl.signal,
        onDelta: (text) => post_({ type: 'delta', text }),
      });
      post_({ type: 'done', content });
    } catch (err) {
      post_({ type: 'error', ...(await _llmErrorPayload(err)) });
    } finally {
      if (!closed) { closed = true; port.disconnect(); }
    }
  });
});

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

/**
 * Indica si el valor es un objeto plano (no null ni array).
 * @param {*} value
 * @returns {boolean}
 */
function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Migra los settings guardados al esquema actual; no escribe si ya están al día.
 * @returns {Promise<boolean>} true si se reescribieron.
 */
async function _migrateSettingsSchema() {
  const data = await DB.get('settings', G_PROPERTY_NAME);
  if (!data?.options || data.options.schemaVersion >= SETTINGS_SCHEMA_VERSION) return false;
  await DB.set('settings', { ...data, id: G_PROPERTY_NAME, options: normalizeSettings(data.options) });
  return true;
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason === 'update') {
    _migrateSettingsSchema().catch((err) => console.error('[Background] Error migrando settings:', err));
  }

  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [
        new chrome.declarativeContent.PageStateMatcher({
          pageUrl: { hostEquals: 'script.google.com', pathContains: '/edit' },
        }),
      ],
      actions: [new chrome.declarativeContent.ShowAction()],
    }]);
  });

  // El icono de la extensión abre el popup de configuración; el Side Panel
  // (chat) se abre desde el botón IA del editor (OPEN_SIDE_PANEL).
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});
  _disableGlobalSidePanel();
});

// Las opciones globales del panel pueden perderse al reiniciar el navegador.
chrome.runtime.onStartup?.addListener?.(_disableGlobalSidePanel);