/**
 * @fileoverview Helper de internacionalización del popup.
 *
 * El idioma lo elige el usuario (selector EN/ES de la cabecera, opción
 * `ui-language`), no el navegador: por eso no se usa `chrome.i18n.getMessage`
 * (que siempre resuelve con el idioma de Chrome). Se carga el
 * `_locales/<lang>/messages.json` elegido una sola vez y se consulta en
 * memoria. Con inglés se usa igualmente el diccionario `en` para que las
 * claves sin fallback inline también se resuelvan.
 */

/** Idiomas soportados por la UI. */
export const SUPPORTED_UI_LANGUAGES = ['en', 'es'];

/** Idioma por defecto (decisión de producto: inglés). */
export const DEFAULT_UI_LANGUAGE = 'en';

/** Clave de localStorage para arrancar el popup sin esperar a IndexedDB. */
const LANGUAGE_STORAGE_KEY = 'gasToolsUiLanguage';

// Componentes propios que renderizan `title`/`description` en su shadow DOM
const OPTION_ELEMENTS_ = ['OPTION-TOGGLE', 'OPTION-SELECT', 'OPTION-COLOR'];

let G_LANG = DEFAULT_UI_LANGUAGE;
let G_MESSAGES = {};

/** Normaliza un código de idioma a uno soportado. */
export function normalizeLanguage(lang) {
    return SUPPORTED_UI_LANGUAGES.includes(lang) ? lang : DEFAULT_UI_LANGUAGE;
}

/**
 * Convierte el formato de `messages.json` (`{key: {message, placeholders}}`)
 * en un diccionario plano `{key: string}`. Los placeholders con nombre de
 * Chrome (`$NAME$` → `placeholders.name.content`, p. ej. `$1`) se resuelven
 * aquí para que `tr()` solo tenga que sustituir `$1`, `$2`…
 * @param {Object} raw
 * @returns {Object<string, string>}
 */
export function flattenMessages(raw) {
    const out = {};
    for (const [key, value] of Object.entries(raw || {})) {
        if (typeof value?.message !== 'string') continue;
        const placeholders = value.placeholders || {};
        out[key] = value.message.replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g, (match, name) =>
            placeholders[name.toLowerCase()]?.content ?? match
        );
    }
    return out;
}

/** Idioma guardado en localStorage (o el default). */
export function getStoredLanguage() {
    try {
        return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY));
    } catch (_) {
        return DEFAULT_UI_LANGUAGE;
    }
}

/** Guarda el idioma en localStorage (espejo rápido de la opción en IndexedDB). */
export function storeLanguage(lang) {
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(lang)); } catch (_) { /* noop */ }
}

/**
 * Carga el diccionario del idioma indicado. Ante cualquier error deja el
 * diccionario vacío: `tr()` devolverá los textos de fallback (inglés).
 * @param {string} lang
 * @returns {Promise<string>} Idioma efectivamente cargado.
 */
export async function loadI18n(lang) {
    G_LANG = normalizeLanguage(lang);
    try {
        const res = await fetch(chrome.runtime.getURL(`_locales/${G_LANG}/messages.json`));
        G_MESSAGES = res.ok ? flattenMessages(await res.json()) : {};
    } catch (_) {
        G_MESSAGES = {};
    }
    return G_LANG;
}

/**
 * Sustituye `$1`, `$2`... en el texto.
 * @private
 */
function applySubstitutions_(text, substitutions) {
    if (!substitutions?.length) return text;
    return substitutions.reduce((acc, sub, idx) => acc.split(`$${idx + 1}`).join(String(sub)), text);
}

/**
 * Devuelve el mensaje traducido o el fallback si no existe.
 * @param {string} key Clave del mensaje (camelCase ASCII).
 * @param {string} [fallback] Texto original a usar si falta la traducción.
 * @param {Array<string|number>} [substitutions] Valores para los placeholders.
 * @returns {string}
 */
export function tr(key, fallback = '', substitutions = []) {
    const subs = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
    const message = key ? G_MESSAGES[key] : undefined;
    return applySubstitutions_(message ?? fallback ?? '', subs);
}

/**
 * Traduce un atributo de un elemento usando la clave indicada en otro atributo.
 * Guarda el texto original (inglés) en `data-i18n-orig-*` para poder volver
 * a traducir al cambiar de idioma sin perder el fallback.
 * @private
 */
function translateAttribute_(el, keyAttr, targetAttr) {
    const key = el.getAttribute(keyAttr);
    if (!key) return;
    const origAttr = `data-i18n-orig-${targetAttr}`;
    if (!el.hasAttribute(origAttr)) el.setAttribute(origAttr, el.getAttribute(targetAttr) || '');
    const translated = tr(key, el.getAttribute(origAttr));
    if (translated !== el.getAttribute(targetAttr)) el.setAttribute(targetAttr, translated);
}

/**
 * Aplica las traducciones a todos los nodos con atributos `data-i18n*`
 * dentro de `root`. Es re-ejecutable (cambio de idioma en vivo del popup):
 *  - `data-i18n`: textContent.
 *  - `data-i18n-placeholder`: atributo placeholder.
 *  - `data-i18n-title`: atributo title (en option-* también el título visible).
 *  - `data-i18n-description`: atributo description de option-*.
 * @param {ParentNode} [root=document]
 */
export function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        if (el.dataset.i18nOrig === undefined) el.dataset.i18nOrig = el.textContent.trim();
        el.textContent = tr(el.dataset.i18n, el.dataset.i18nOrig);
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        translateAttribute_(el, 'data-i18n-placeholder', 'placeholder');
    });

    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        translateAttribute_(el, 'data-i18n-title', 'title');
    });

    root.querySelectorAll('[data-i18n-description]').forEach((el) => {
        if (OPTION_ELEMENTS_.includes(el.tagName)) {
            translateAttribute_(el, 'data-i18n-description', 'description');
        }
    });

    if (root === document) document.documentElement.lang = G_LANG;
}

/**
 * Idioma activo de la UI (para formatear fechas/números).
 * @returns {string}
 */
export function getUiLocale() {
    return G_LANG;
}
