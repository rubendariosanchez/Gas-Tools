/**
 * @fileoverview DomUtils - Utilidades de manipulación del DOM optimizadas.
 * @version 1.0.0
 * @author Rubén Sánchez (rubencho.dev@gmail.com)
 */

class DomUtils {
  /**
   * Prefijo para clases CSS de elementos inyectados por la extensión.
   * Permite limpiar todos los elementos de un tipo usando removeByClass.
   * @type {string}
   */
  static REF_CLASS_PREFIX = 'qc-ref--';

  /**
   * Clase única para identificar elementos inyectados que deben ser limpiados
   * al deshabilitar o reinicializar el componente.
   * @type {string}
   */
  static REF_CLASS = 'qc-ref';

  static #policy = null;
  static #policyInitialized = false;

  /**
   * Activa o desactiva el modo debug (opción `debug-mode` del popup).
   * El flag se publica en `window.__gasToolsDebug` para que otros
   * scripts del MAIN world puedan consultarlo sin depender de DomUtils.
   * @param {boolean} enabled
   */
  static setDebug(enabled) {
    window.__gasToolsDebug = enabled === true;
  }

  /** @returns {boolean} true si el modo debug está activo. */
  static isDebug() {
    return window.__gasToolsDebug === true;
  }

  /**
   * Log de depuración con scope. No hace nada si el modo debug está apagado.
   * @param {string} scope - Módulo emisor (ej. 'Editor', 'ErrorLens').
   * @param {...*} args
   */
  static debug(scope, ...args) {
    if (window.__gasToolsDebug !== true) return;
    console.debug('[GASTools:' + scope + ']', ...args);
  }

  /**
   * Elimina un elemento del DOM de forma segura.
   * @param {string|HTMLElement} target - ID del elemento o el nodo directamente.
   */
  static remove(target) {
    const node = (typeof target === 'string') ? document.getElementById(target) : target;
    if (node) {
      // Método moderno: más rápido y limpio que parent.removeChild()
      node.remove();
    }
  }

  /**
   * Busca el ancestro más cercano que coincida con el tag o selector.
   * @param {HTMLElement} element - Elemento de origen.
   * @param {string} selector - Nombre del tag o selector CSS.
   * @returns {HTMLElement|null}
   */
  static closest(element, selector) {
    if (!element) return null;
    // Usamos el método nativo .closest() que está altamente optimizado en el motor del navegador
    return element.closest(selector);
  }

  /**
   * Inicialización única de la política de Trusted Types para evitar 
   * advertencias de seguridad en la extensión de Chrome.
   * @private
   */
  static #getTrustedPolicy() {
    if (this.#policyInitialized) return this.#policy;
    this.#policyInitialized = true;

    if (!window.trustedTypes?.createPolicy) {
      this.#policy = null;
      return this.#policy;
    }

    try {
      this.#policy = window.trustedTypes.createPolicy("qc-security-policy", {
        createHTML: (input) => input
      });
    } catch (err) {
      // Si la página restringe el nombre de política, seguimos sin Trusted Types policy.
      this.#policy = null;
      console.warn('[DomUtils] Trusted Types policy blocked by host CSP:', err);
    }

    return this.#policy;
  }

  /**
   * Inserta HTML de forma segura cumpliendo con las políticas de seguridad (CSP).
   * @param {HTMLElement} container - El contenedor donde se insertará el HTML.
   * @param {string} htmlContent - La cadena de texto HTML a renderizar.
   */
  static setHTML(container, htmlContent) {
    if (!container) return;
    const html = String(htmlContent ?? '');
    const policy = this.#getTrustedPolicy();

    if (policy) {
      try {
        container.innerHTML = policy.createHTML(html);
        return;
      } catch (err) {
        console.warn('[DomUtils] TrustedHTML assignment failed, using fragment fallback:', err);
      }
    }

    // Fallback sin innerHTML (Trusted Types estricto): DOMParser inerte + saneo básico.
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    this.sanitizeTree_(doc.body);
    container.replaceChildren(...doc.body.childNodes);
  }

  /**
   * Quita nodos ejecutables y atributos peligrosos de un árbol ya parseado.
   * @param {Element} root
   */
  static sanitizeTree_(root) {
    root.querySelectorAll('script, iframe, object, embed, frame, frameset, base, meta, link[rel="import"]')
      .forEach((n) => n.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.replace(/[\u0000- ]/g, '').toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name)
          && /^(javascript|vbscript|data:text\/html)/.test(value)) el.removeAttribute(attr.name);
      }
    }
  }

  // ── Recursos de la extensión ──────────────────────────────────────────
  // El MAIN world no tiene `chrome.runtime`: el content script envía la URL
  // base (`assetsBaseUrl`) en `GAS_TransferData`.

  static #assetsBaseUrl = '';

  /**
   * Fija la URL base de los recursos web-accesibles de la extensión.
   * @param {string} url Base `chrome-extension://<id>/` enviada por el content script.
   */
  static setAssetsBaseUrl(url) {
    const value = typeof url === 'string' ? url : '';
    this.#assetsBaseUrl = /^chrome-extension:\/\/[^/]+\/$/.test(value) ? value : '';
  }

  /**
   * URL absoluta de un recurso de la extensión ('' si no hay base).
   * @param {string} path Ruta relativa a la raíz de la extensión.
   * @returns {string}
   */
  static assetUrl(path) {
    if (!this.#assetsBaseUrl) return '';
    return this.#assetsBaseUrl + String(path || '').replace(/^\/+/, '');
  }

  // ── i18n ──────────────────────────────────────────────────────────────
  // El idioma lo elige el usuario en el popup (opción `ui-language`). El
  // content script envía el diccionario en `GAS_TransferData` solo si no es
  // inglés; con inglés `t()` devuelve el fallback y no hay coste extra.

  static #i18nLang = 'en';
  static #i18nMessages = null;

  /**
   * Fija el diccionario activo. Se llama una vez al recibir los datos del
   * content script, antes de inyectar la UI.
   * @param {{lang?:string, messages?:Object<string,string>}|null} i18n
   */
  static setI18n(i18n) {
    this.#i18nLang     = i18n?.lang === 'es' ? 'es' : 'en';
    this.#i18nMessages = (i18n?.messages && typeof i18n.messages === 'object') ? i18n.messages : null;
  }

  /** Idioma activo de la UI inyectada ('en' | 'es'). */
  static lang() {
    return this.#i18nLang;
  }

  /**
   * Traduce `key` o devuelve `fallback` (el texto en inglés escrito en el
   * código). Sustituye `$1`, `$2`… por los argumentos extra.
   * @param {string} key
   * @param {string} fallback
   * @param {...(string|number)} subs
   * @returns {string}
   */
  static t(key, fallback = '', ...subs) {
    let text = this.#i18nMessages?.[key] ?? fallback;
    for (let i = 0; i < subs.length; i++) {
      text = text.split(`$${i + 1}`).join(String(subs[i]));
    }
    return text;
  }

  /**
   * Traduce atributos declarativos dentro de `root` (plantillas HTML):
   * `data-i18n` (textContent), `data-i18n-title`, `data-i18n-aria-label`,
   * `data-i18n-placeholder`. El texto existente actúa como fallback.
   * @param {ParentNode} root
   */
  static applyI18n(root) {
    if (!root || !this.#i18nMessages) return;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = this.t(el.dataset.i18n, el.textContent);
    });
    const ATTRS = [
      ['data-i18n-title', 'title'],
      ['data-i18n-aria-label', 'aria-label'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-tt', 'data-tt'],   // tooltip nativo de la toolbar de GAS
    ];
    for (const [keyAttr, target] of ATTRS) {
      root.querySelectorAll(`[${keyAttr}]`).forEach((el) => {
        el.setAttribute(target, this.t(el.getAttribute(keyAttr), el.getAttribute(target) || ''));
      });
    }
  }

  /**
   * Escapa texto para interpolarlo de forma segura dentro de HTML.
   * Usar siempre que un valor externo (nombres de archivo, respuestas de
   * GitHub/LLM, input del usuario) termine en `setHTML`.
   * @param {*} value
   * @returns {string}
   */
  static escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Petición request/response sobre el bridge de CustomEvents
   * (MAIN world ↔ content script). Registra un listener por llamada que
   * se elimina siempre (respuesta, timeout o abort), así no quedan
   * listeners ni promesas colgadas.
   *
   * El `detail` de la respuesta debe ser JSON con el mismo `requestId`.
   *
   * @param {string} eventName       Evento a despachar (ej. 'GAS_GH_API_CALL').
   * @param {string} responseEvent   Evento de respuesta (ej. 'GAS_GH_API_RESULT').
   * @param {object} [payload]
   * @param {{timeoutMs?:number, signal?:AbortSignal, requestId?:string, onDispatch?:(requestId:string)=>void}} [opts]
   * @returns {Promise<object|null>} El `detail` parseado completo, o `null` en timeout.
   */
  static bridgeRequest(eventName, responseEvent, payload = {}, opts = {}) {
    const { timeoutMs = 15000, signal = null } = opts;
    const requestId = opts.requestId
      || `br_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return new Promise((resolve, reject) => {
      let timerId = 0;

      const cleanup_ = () => {
        clearTimeout(timerId);
        document.removeEventListener(responseEvent, onResponse_);
        signal?.removeEventListener('abort', onAbort_);
      };
      const onResponse_ = (e) => {
        let detail;
        try { detail = JSON.parse(e.detail); } catch (_) { return; }
        if (detail?.requestId !== requestId) return;
        cleanup_();
        resolve(detail);
      };
      const onAbort_ = () => {
        cleanup_();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      if (signal?.aborted) { onAbort_(); return; }
      document.addEventListener(responseEvent, onResponse_);
      signal?.addEventListener('abort', onAbort_, { once: true });
      if (timeoutMs > 0) {
        timerId = setTimeout(() => { cleanup_(); resolve(null); }, timeoutMs);
      }
      opts.onDispatch?.(requestId);
      document.dispatchEvent(new CustomEvent(eventName, {
        detail: JSON.stringify({ ...payload, requestId }),
      }));
    });
  }

  /**
   * Devuelve una versión con debounce de `fn`. La función resultante
   * expone `.cancel()` para usar en teardown.
   * @param {Function} fn
   * @param {number} waitMs
   * @returns {Function & {cancel: Function}}
   */
  static debounce(fn, waitMs) {
    let timerId = 0;
    const debounced = function (...args) {
      clearTimeout(timerId);
      timerId = setTimeout(() => fn.apply(this, args), waitMs);
    };
    debounced.cancel = () => clearTimeout(timerId);
    return debounced;
  }

  /**
   * Delegación de eventos para optimizar el rendimiento en listas largas.
   * @param {HTMLElement} parent - El contenedor que escuchará el evento.
   * @param {string} eventType - Tipo de evento (ej. 'click').
   * @param {string} selector - El hijo que debe disparar la acción.
   * @param {Function} callback - Acción a realizar.
   */
  static delegate(parent, eventType, selector, callback) {
    parent.addEventListener(eventType, (e) => {
      const target = e.target.closest(selector);
      if (target && parent.contains(target)) {
        callback.call(target, e, target);
      }
    });
  }

  /**
   * Elimina del DOM todos los elementos que tengan la clase `qc-ref` o
   * una clase que comience con `qc-ref--`.
   * Útil para limpieza en disable() sin depender de IDs individuales.
   */
  static removeRefElements() {
    document.querySelectorAll(`.${this.REF_CLASS}`).forEach(el => el.remove());
    document.querySelectorAll(`[class*="${this.REF_CLASS_PREFIX}"]`).forEach(el => el.remove());
  }

  /**
   * Lista canónica de paneles flotantes que solo deben mostrarse uno a la vez.
   * Centralizar el listado evita que cada panel olvide cerrar a un nuevo hermano.
   * @type {string[]}
   */
  static FLOATING_PANEL_TAGS = [
    'gas-current-file',
    'gas-actions-panel',
    'gas-github-panel',
  ];

  /**
   * Cierra todos los paneles flotantes registrados, salvo el indicado.
   * Cada panel debe exponer un método `close()` (todos los componentes
   * de `extension/js/components/` lo cumplen).
   *
   * @param {string} [exceptTag] - Custom element que NO debe cerrarse.
   *                                Si se omite, cierra todos los paneles.
   */
  static closeOtherFloatingPanels(exceptTag) {
    for (const tag of this.FLOATING_PANEL_TAGS) {
      if (tag === exceptTag) continue;
      document.querySelector(tag)?.close?.();
    }
  }
}
