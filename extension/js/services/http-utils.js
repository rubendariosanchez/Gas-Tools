"use strict";

// ─────────────────────────────────────────────────────────────────────────
// Utilidades HTTP compartidas entre google-api, github-api y llm-providers.
// Centralizar el parseo de errores evita inconsistencias en los mensajes
// y reduce la duplicación entre servicios.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Construye un `Error` legible a partir de una respuesta HTTP fallida.
 *
 * Intenta interpretar el cuerpo como JSON y extraer un mensaje de error
 * descriptivo siguiendo los campos más comunes (`error.message`,
 * `error_description`, `error`, `message`). Si el body no es JSON o no
 * contiene esos campos, usa los primeros 240 caracteres como fallback.
 *
 * @async
 * @param {Response} res                  - Respuesta `fetch` con `res.ok === false`.
 * @param {string}   [prefix]             - Prefijo para el mensaje (ej. 'Google', 'GitHub').
 *                                          Si se omite, usa `HTTP {status} {statusText}`.
 * @returns {Promise<Error>} Error con mensaje listo para `throw`.
 */
export async function readHttpError(res, prefix) {
  let body = '';
  try { body = await res.text(); } catch (_) { /* sin body */ }

  let parsed = null;
  try { parsed = JSON.parse(body); } catch (_) { /* no JSON */ }

  const msg =
    parsed?.error?.message ||
    parsed?.error_description ||
    (typeof parsed?.error === 'string' ? parsed.error : null) ||
    parsed?.message ||
    body.slice(0, 240) ||
    res.statusText;

  if (prefix) return new Error(`${prefix} ${res.status}: ${msg}`);
  return new Error(`HTTP ${res.status} ${res.statusText}: ${msg}`);
}
