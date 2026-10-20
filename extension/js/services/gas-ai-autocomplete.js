"use strict";

/**
 * @fileoverview Autocompletado AI inline (ghost text) para Monaco Editor en
 * el IDE de Google Apps Script. Diseño inspirado en GitHub Copilot:
 *  - Debounce trailing estricto.
 *  - Prompt FIM (Fill-In-the-Middle) para código.
 *  - Prompt diferenciado para comentarios con detección de idioma.
 *  - Cancelación con AbortController.
 *  - Cache LRU para servir respuestas repetidas sin volver a llamar al LLM.
 *  - Defensas post-LLM contra repetición y "corrección" de texto del usuario.
 *
 * Comunicación con el LLM mediante CustomEvents:
 *   GAS_LLM_REQUEST  → emitido por esta clase.
 *   GAS_LLM_RESPONSE → recibido del bridge en main-functions.js.
 *   GAS_LLM_CANCEL   → emitido al abortar, para cortar el fetch del background.
 * La API key nunca viaja por el DOM: la inyecta el background.
 */

class GasAiAutocomplete {

  // ── Configuración estática ───────────────────────────────────────────────

  /**
   * Tiempo de inactividad (ms) que debe transcurrir desde la última tecla
   * antes de disparar una petición al LLM.
   */
  static DEBOUNCE_MS = 300;

  /** Tiempo máximo (ms) para esperar respuesta del bridge LLM. */
  static BRIDGE_TIMEOUT_MS = 25000;

  /**
   * Tamaño máximo del prefix enviado al LLM (chars). Con poco contexto el
   * modelo "inventa" bloques plausibles que no aplican al archivo.
   */
  static MAX_PREFIX_CHARS = 3000;

  /** Tamaño máximo del suffix enviado al LLM (chars). */
  static MAX_SUFFIX_CHARS = 1500;

  /** Máximo de líneas de una sugerencia en modo bloque. */
  static MAX_BLOCK_LINES = 8;

  /** Líneas vecinas (antes y después) contra las que se detectan duplicados. */
  static DUPLICATE_WINDOW_LINES = 40;

  /** Capacidad del cache LRU de sugerencias. */
  static CACHE_SIZE = 32;

  /** TTL (ms) de las respuestas vacías en cache: evita reintentar en bucle. */
  static EMPTY_CACHE_TTL_MS = 30000;

  /** Intervalo mínimo (ms) entre peticiones de red automáticas. */
  static MIN_REQUEST_INTERVAL_MS = 800;

  /**
   * Máximo de peticiones automáticas por minuto (ventana deslizante).
   * Con 20 el cupo se agotaba al escribir con pausas cortas y las
   * sugerencias se descartaban en silencio.
   */
  static MAX_REQUESTS_PER_MINUTE = 40;

  /**
   * Espera máxima (ms) por rate limit antes de descartar un trigger
   * automático. Esperar más haría aparecer sugerencias "tarde".
   */
  static MAX_RATE_LIMIT_WAIT_MS = 3000;

  /** Límite de tokens de salida para sugerencias de una línea. */
  static MAX_TOKENS_SINGLE = 128;

  /** Límite de tokens de salida para bloques (multi-línea / comentarios de bloque). */
  static MAX_TOKENS_MULTI = 256;

  /** Id de la acción Monaco que fuerza la sugerencia (Ctrl+Shift+Espacio). */
  static TRIGGER_ACTION_ID = 'qc.aiAutocomplete.trigger';

  // Los providers de Monaco son globales: se registran una sola vez y
  // delegan en la instancia activa. Así re-instanciar o re-habilitar no
  // duplica sugerencias.
  static providersRegistered = false;
  static _providerDisposables = [];
  /** @type {GasAiAutocomplete|null} Instancia que atiende los providers. */
  static _activeInstance = null;

  /** Lenguajes Monaco en los que se registra el provider. */
  static SUPPORTED_LANGUAGES = [
    'javascript',
    'typescript',
    'google apps script',
    'css',
    'html',
    'xml',
    'handlebars',
    'json',
    'jsonc',
  ];

  /**
   * @param {object} editor                  Instancia activa de Monaco Editor.
   * @param {object} [options]
   * @param {number} [options.debounceMs]    Sobrescribe DEBOUNCE_MS por instancia.
   */
  constructor(editor, options = {}) {
    this._editor      = editor;
    this._enabled     = false;
    // Disposables ligados al editor actual (listener de contenido, acción).
    this._editorDisposables = [];
    this._debounceMs  = options.debounceMs ?? GasAiAutocomplete.DEBOUNCE_MS;

    // Rate limit: timestamp de la última petición de red y ventana de 60 s.
    this._lastRequestAt = 0;
    this._requestTimes  = [];

    // Timer del debounce activo.
    this._timer = null;
    // Resolver de la promesa pendiente del debounce (para cancelar limpiamente).
    this._pendingResolve = null;
    // AbortController de la petición LLM en vuelo.
    this._abortCtrl = null;

    // Cache LRU clave→sugerencia. La clave combina prefix+suffix recortados,
    // así una llamada idéntica se sirve sin volver a contactar al LLM.
    this._cache = new Map();

    // Última sugerencia mostrada al usuario (para detectar aceptación).
    this._lastShown = '';
    // Timestamp de la última aceptación (ms). Se usa para un cooldown que
    // suprime el re-trigger automático que Monaco emite tras insertar.
    this._lastAcceptedAt = 0;

    // Contador de peticiones (solo informativo).
    this._reqCount = 0;

    // Timestamp del último cambio de contenido del editor (ms). Lo usa el
    // debounce para verificar inactividad real antes de disparar.
    this._lastInputAt = 0;

    // Config LLM pública (sin API keys) cacheada desde el background vía
    // `GAS_LLM_GET_CONFIG`. null hasta la primera carga.
    this._llmConfig = null;
    // Secuencia de cargas: descarta respuestas viejas si llegan desordenadas.
    this._configLoadSeq = 0;
    // Listener de `GAS_LLM_CONFIG_UPDATED` (se quita en disable()).
    this._onLlmConfigUpdated = null;
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  /**
   * Registra el provider de inline completions en Monaco para los lenguajes
   * soportados, instala el atajo Ctrl+Shift+Espacio y empieza a escuchar
   * cambios para detectar aceptaciones e inactividad.
   */
  enable() {
    if (this._enabled || !this._editor) return;

    if (typeof window.monaco?.languages?.registerInlineCompletionsProvider !== 'function') {
      // Monaco aún no está disponible: reintentar en breve (un solo timer).
      clearTimeout(this._enableRetryTimer);
      this._enableRetryTimer = setTimeout(() => this.enable(), 500);
      return;
    }

    this._enabled = true;
    GasAiAutocomplete._activeInstance = this;
    GasAiAutocomplete._registerProviders_();
    this._attachEditor_();
    this._bindConfigUpdates_();
    this._loadConfig_();
  }

  /**
   * Desactiva el autocompletado: cancela peticiones en vuelo, libera los
   * listeners del editor, los providers globales (si esta instancia era la
   * activa) y limpia el cache.
   */
  disable() {
    clearTimeout(this._enableRetryTimer);
    if (!this._enabled) return;
    this._enabled = false;
    this._cancel_();
    this._detachEditor_();
    this._unbindConfigUpdates_();
    if (GasAiAutocomplete._activeInstance === this) {
      GasAiAutocomplete._activeInstance = null;
      GasAiAutocomplete._disposeProviders_();
    }
    this._cache.clear();
  }

  /** Teardown completo de la instancia (alias de `disable`). */
  dispose() {
    this.disable();
  }

  /**
   * Cambia el editor Monaco al que está atado el autocompletado. Idempotente:
   * si es el mismo editor no hace nada. Libera los listeners del editor
   * anterior y, si está habilitado, se engancha al nuevo.
   * @param {object} editor
   */
  setEditor(editor) {
    if (!editor || editor === this._editor) return;
    this._cancel_();
    this._detachEditor_();
    this._editor     = editor;
    this._lastShown  = '';
    if (this._enabled) this._attachEditor_();
  }

  /**
   * Registra los inline completion providers una sola vez (Monaco es
   * global). El callback consulta la instancia activa en cada llamada.
   * @private
   */
  static _registerProviders_() {
    if (GasAiAutocomplete.providersRegistered) return;
    GasAiAutocomplete.providersRegistered = true;

    GasAiAutocomplete.SUPPORTED_LANGUAGES.forEach(lang => {
      try {
        const d = window.monaco.languages.registerInlineCompletionsProvider(lang, {
          provideInlineCompletions: (model, position, context, token) => {
            const inst = GasAiAutocomplete._activeInstance;
            // Sin sugerencias en los modelos de la vista previa de cambios.
            if (!inst || model?.uri?.scheme === 'gas-preview' || model?.uri?.scheme === 'gas-ghdiff') return { items: [], dispose() {} };
            return inst._provideInline_(model, position, context, token);
          },
          freeInlineCompletions(c) { c?.dispose?.(); },
        });
        if (d) GasAiAutocomplete._providerDisposables.push(d);
      } catch (_) { /* lenguaje no registrable: ignorar */ }
    });
  }

  /**
   * Libera los providers globales y resetea el flag de registro.
   * @private
   */
  static _disposeProviders_() {
    GasAiAutocomplete._providerDisposables.forEach(d => {
      try { d?.dispose?.(); } catch (_) { /* ignorar */ }
    });
    GasAiAutocomplete._providerDisposables = [];
    GasAiAutocomplete.providersRegistered  = false;
  }

  /**
   * Engancha atajo y listener de contenido al editor actual. Siempre libera
   * los previos para no apilar listeners al re-habilitar.
   * @private
   */
  _attachEditor_() {
    this._detachEditor_();
    const editor = this._editor;
    if (!editor) return;

    // Atajo Ctrl+Shift+Espacio: fuerza la sugerencia ignorando el debounce.
    // `addAction` devuelve un disposable (a diferencia de `addCommand`).
    if (typeof editor.addAction === 'function' && window.monaco?.KeyMod) {
      try {
        const d = editor.addAction({
          id:          GasAiAutocomplete.TRIGGER_ACTION_ID,
          label:       'AI: Trigger inline suggestion',
          keybindings: [
            window.monaco.KeyMod.CtrlCmd | window.monaco.KeyMod.Shift | window.monaco.KeyCode.Space,
          ],
          run: (ed) => ed.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {}),
        });
        if (d) this._editorDisposables.push(d);
      } catch (_) { /* acción ya registrada en este editor: ignorar */ }
    }

    // Listener único para dos cosas: registrar timestamp de actividad y
    // detectar aceptación (inserción literal del texto que mostrábamos).
    if (typeof editor.onDidChangeModelContent === 'function') {
      const d = editor.onDidChangeModelContent((ev) => {
        this._lastInputAt = Date.now();
        if (!this._lastShown) return;
        const accepted = ev?.changes?.some(c => c.text === this._lastShown);
        if (accepted) {
          this._lastAcceptedAt = Date.now();
          this._lastShown      = '';
        }
      });
      if (d) this._editorDisposables.push(d);
    }
  }

  /**
   * Libera los disposables ligados al editor actual.
   * @private
   */
  _detachEditor_() {
    this._editorDisposables.forEach(d => {
      try { d?.dispose?.(); } catch (_) { /* ignorar */ }
    });
    this._editorDisposables = [];
  }

  /**
   * Ajusta el debounce en caliente sin recrear la instancia.
   * @param {number} ms Milisegundos (0 desactiva el debounce).
   */
  setDebounceMs(ms) {
    this._debounceMs = Math.max(0, ms);
  }

  // ── Provider Monaco ──────────────────────────────────────────────────────

  /**
   * Punto de entrada del provider Monaco. Distingue triggers automáticos
   * (al teclear, aplica debounce) de explícitos (Ctrl+Shift+Espacio,
   * dispara de inmediato). Maneja también el cooldown post-aceptación.
   *
   * @param {object} model
   * @param {object} position
   * @param {object} context
   * @param {object} token
   * @returns {Promise<{items: Array, dispose: Function}>}
   * @private
   */
  async _provideInline_(model, position, context, token) {
    const empty = { items: [], dispose() {} };
    if (!this._enabled) return empty;

    // Monaco trigger kinds: 0 = Automatic (al teclear), 1 = Explicit.
    const isExplicit = context?.triggerKind === 1;

    // Cooldown post-aceptación: tras insertar la sugerencia, Monaco re-dispara
    // el provider de inmediato. Ignoramos esa llamada fantasma.
    if (!isExplicit && Date.now() - this._lastAcceptedAt < 600) {
      return empty;
    }

    // El provider es global: si el modelo no es el del editor atado, la
    // posición del editor no aplica y no sugerimos.
    const editorModel = this._editor?.getModel?.() || null;
    if (editorModel && editorModel !== model) return empty;

    if (isExplicit) {
      this._cancel_();
      return (await this._request_(model, position, token, true)) || empty;
    }

    const result = await this._debounce_(() => {
      // La posición y el modelo pueden haber cambiado durante el debounce;
      // los recapturamos del editor actual para enviar el contexto exacto.
      const mdl = this._editor?.getModel?.() || model;
      if (mdl !== model) return null;
      const pos = this._editor?.getPosition?.() || position;
      return this._request_(mdl, pos, token, false);
    });

    return result || empty;
  }

  /**
   * Rate limit para triggers automáticos. Devuelve los ms a esperar para
   * respetar el intervalo mínimo y el cupo por minuto (siempre ≥ 0).
   * Antes devolvía -1 al agotar el cupo y la petición se descartaba sin
   * aviso; ahora el debounce espera a que se libere un hueco.
   * @returns {number}
   * @private
   */
  _rateLimitWait_() {
    const now = Date.now();
    this._requestTimes = this._requestTimes.filter(t => now - t < 60000);
    const intervalWait = Math.max(0, this._lastRequestAt + GasAiAutocomplete.MIN_REQUEST_INTERVAL_MS - now);
    if (this._requestTimes.length < GasAiAutocomplete.MAX_REQUESTS_PER_MINUTE) return intervalWait;
    const quotaWait = this._requestTimes[0] + 60000 - now;
    return Math.max(intervalWait, quotaWait);
  }

  /**
   * Log de diagnóstico (solo con la opción "Debug mode" del popup).
   * @param {string} message
   * @param {...*} args
   * @private
   */
  _log_(message, ...args) {
    if (typeof DomUtils !== 'undefined' && typeof DomUtils.debug === 'function') {
      DomUtils.debug('AI Autocomplete', message, ...args);
    }
  }

  /**
   * Avisa en consola de errores reales del LLM (permiso, key, red). Se
   * muestra siempre, pero cada mensaje distinto como mucho una vez por
   * minuto para no inundar la consola mientras se escribe.
   * @param {Error} err
   * @private
   */
  _warnError_(err) {
    const msg = String(err?.message || err);
    const now = Date.now();
    this._warnedAt = this._warnedAt || new Map();
    if (now - (this._warnedAt.get(msg) || 0) < 60000) return;
    this._warnedAt.set(msg, now);
    const hint = err?.permissionOrigin
      ? ` → Concede acceso a ${err.permissionOrigin} en el popup: AI Context → Provider access.`
      : '';
    console.warn(`[GASTools] AI Autocomplete: ${msg}${hint}`);
  }

  /**
   * Trailing debounce estricto. Cada llamada cancela el timer anterior y
   * la petición LLM en vuelo. Cuando el timer vence, verifica que hayan
   * pasado realmente `_debounceMs` ms desde el último cambio del editor;
   * si no, reprograma con el tiempo restante.
   *
   * @param {Function} fn Función a ejecutar tras la inactividad.
   * @returns {Promise<*>} Resultado de `fn`, o `null` si fue cancelada.
   * @private
   */
  _debounce_(fn) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._pendingResolve) { this._pendingResolve(null); this._pendingResolve = null; }
    this._abort_();

    if (this._debounceMs <= 0) return fn();

    return new Promise(resolve => {
      this._pendingResolve = resolve;

      const tick = () => {
        const elapsed   = Date.now() - this._lastInputAt;
        // Además de la inactividad, respetamos el intervalo mínimo entre
        // peticiones de red (el cupo por minuto lo valida `_request_`).
        const rateWait  = this._rateLimitWait_();
        if (rateWait > GasAiAutocomplete.MAX_RATE_LIMIT_WAIT_MS) {
          this._log_(`Omitido: cupo de ${GasAiAutocomplete.MAX_REQUESTS_PER_MINUTE} peticiones/min agotado (libre en ${Math.ceil(rateWait / 1000)} s). Ctrl+Shift+Espacio lo ignora.`);
          this._timer = null;
          this._pendingResolve = null;
          resolve(null);
          return;
        }
        const remaining = Math.max(this._debounceMs - elapsed, rateWait);
        if (remaining > 0) {
          this._timer = setTimeout(tick, remaining);
          return;
        }
        this._timer          = null;
        this._pendingResolve = null;
        Promise.resolve()
          .then(() => fn())
          .then(r => resolve(r), () => resolve(null));
      };

      this._timer = setTimeout(tick, this._debounceMs);
    });
  }

  /**
   * Construye el contexto FIM, consulta el cache y, en caso de miss,
   * envía la petición al LLM. Aplica sanitize y strip overlap antes de
   * devolver la sugerencia a Monaco.
   *
   * @param {object} model
   * @param {object} position
   * @param {object} token
   * @param {boolean} [isExplicit=false] Trigger manual (omite guards de contexto y rate limit).
   * @returns {Promise<object|null>}
   * @private
   */
  async _request_(model, position, token, isExplicit = false) {
    if (!this._enabled || token?.isCancellationRequested) return null;

    const ctx = this._buildContext_(model, position, isExplicit);
    if (!ctx) return null;

    const cacheKey = this._cacheKey_(ctx.prefix, ctx.suffix, `${ctx.language}|${ctx.mode}`);
    const cached   = this._cacheGet_(cacheKey);
    if (cached !== undefined) {
      this._log_(cached ? 'Sugerencia desde cache.' : 'Cache: esta posición ya respondió vacío (se reintenta en 30 s o con Ctrl+Shift+Espacio).');
      if (!cached) return null;
      this._lastShown = cached;
      return this._toCompletion_(cached, position);
    }

    const config = this._readConfig_(ctx.language);
    if (!config) {
      this._log_('Omitido: falta configurar proveedor/API key en el chat (Settings).');
      return null;
    }

    // Rate limit solo para triggers automáticos (el debounce ya esperó; esto
    // cubre carreras entre peticiones casi simultáneas).
    if (!isExplicit && this._rateLimitWait_() > 50) {
      this._log_('Omitido por rate limit.');
      return null;
    }

    const prompt = this._buildPrompt_(ctx);
    this._reqCount++;
    this._lastRequestAt = Date.now();
    this._requestTimes.push(this._lastRequestAt);

    this._abort_();
    const ctrl = new AbortController();
    this._abortCtrl = ctrl;
    const signal = ctrl.signal;

    let cancelReg = null;
    if (typeof token?.onCancellationRequested === 'function') {
      cancelReg = token.onCancellationRequested(() => ctrl.abort());
    }

    const maxTokens = this._maxTokensFor_(ctx);
    this._log_(`Petición (${isExplicit ? 'manual' : 'auto'}) modo=${ctx.mode} maxTokens=${maxTokens} prefix=${ctx.prefix.length} suffix=${ctx.suffix.length}`);
    if (typeof DomUtils !== 'undefined' && DomUtils.isDebug?.()) this._log_('Prompt:', prompt);

    try {
      const raw = await this._callBridge_({
        provider:    config.provider,
        model:       config.model,
        endpointUrl: config.endpointUrl,
        temperature: config.temperature,
        maxTokens,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user',   content: prompt              },
        ],
        signal,
      });

      let text = this._sanitize_(raw, ctx.isComment);
      // En comentarios la repetición puede abarcar varias líneas del bloque,
      // por eso usamos `comment.text` como referencia. En código basta con
      // la línea actual.
      const overlapPrefix = ctx.isComment && ctx.comment?.text
        ? ctx.comment.text
        : ctx.linePrefix;
      text = this._stripOverlap_(text, overlapPrefix, ctx.lineSuffix);
      if (!ctx.isComment) text = this._postProcessCode_(text, ctx);

      this._cacheSet_(cacheKey, text);

      if (!text) {
        this._log_(raw
          ? 'Respuesta descartada por los filtros (repetía o redefinía código existente).'
          : 'El modelo respondió vacío (no ve nada que completar).', { raw });
        return null;
      }
      this._log_('Sugerencia:', text);
      this._lastShown = text;
      return this._toCompletion_(text, position);

    } catch (err) {
      // AbortError: el usuario siguió escribiendo (normal). El resto son
      // errores reales (permiso, key, red, timeout) y se avisan.
      if (err?.name === 'AbortError') this._log_('Cancelada: el usuario siguió escribiendo.');
      else this._warnError_(err);
      return null;
    } finally {
      cancelReg?.dispose?.();
      // Solo limpiamos si no lo reemplazó una petición más nueva.
      if (this._abortCtrl === ctrl) this._abortCtrl = null;
    }
  }

  /**
   * Límite de tokens de salida según el contexto: bloques (comentario de
   * bloque, línea vacía o tras `{`/`(`/`[`/`=>`) admiten más que una línea.
   * @param {object} ctx
   * @returns {number}
   * @private
   */
  _maxTokensFor_(ctx) {
    const multi = ctx.isComment
      ? ctx.comment?.type !== 'line'
      : ctx.mode === 'block';
    return multi ? GasAiAutocomplete.MAX_TOKENS_MULTI : GasAiAutocomplete.MAX_TOKENS_SINGLE;
  }

  /**
   * Decide cuánto puede sugerir el modelo en esta posición:
   *  - `inline`: hay código en la línea → solo terminar la línea actual.
   *  - `block`:  bloque vacío recién abierto (`{` arriba y `}` debajo) o
   *              trigger manual → varias líneas (hasta MAX_BLOCK_LINES).
   *  - `line`:   línea vacía entre código existente → como mucho UNA línea.
   *              Es el caso en el que el modelo tendía a inventar bloques
   *              enteros que ya existían más abajo.
   *
   * @param {string} linePrefix
   * @param {string} prevLine  Línea no vacía anterior.
   * @param {string} nextLine  Línea no vacía siguiente.
   * @param {boolean} isExplicit
   * @returns {'inline'|'line'|'block'}
   * @private
   */
  _completionMode_(linePrefix, prevLine, nextLine, isExplicit) {
    const lp = linePrefix || '';
    const OPENER_RE   = /(?:[{([]|=>)\s*$/;
    const closesBelow = /^\s*[})\]]/.test(nextLine || '');
    if (lp.trim()) {
      // Código en la línea: solo es bloque si acaba en apertura y el cierre
      // está justo después (`{|}` autocerrado o `}` en la línea siguiente).
      return OPENER_RE.test(lp) && closesBelow ? 'block' : 'inline';
    }
    if (isExplicit) return 'block';
    return OPENER_RE.test(prevLine || '') && closesBelow ? 'block' : 'line';
  }

  /**
   * Post-procesado de sugerencias de código (puro, testeable):
   *  1. Limita líneas según el modo (`inline`/`line` → 1, `block` → N).
   *  2. Corta donde un cierre `}`/`)`/`]` excede lo abierto por la propia
   *     sugerencia: ese cierre ya existe en el suffix.
   *  3. Corta en la primera línea que ya existe cerca del cursor
   *     (el modelo repite código de arriba o de abajo).
   *  4. Descarta la sugerencia si su primera línea define un nombre que ya
   *     está definido en el contexto (`accent:` cuando `accent:` ya existe).
   *  5. Ajusta la indentación de las líneas siguientes a la del cursor.
   *
   * @param {string} text
   * @param {{mode:string, linePrefix:string, prefix:string, suffix:string}} ctx
   * @returns {string}
   * @private
   */
  _postProcessCode_(text, ctx) {
    if (!text) return '';
    let lines = String(text).replace(/\r\n?/g, '\n').split('\n');

    // 1. Límite de líneas por modo.
    const maxLines = ctx.mode === 'block' ? GasAiAutocomplete.MAX_BLOCK_LINES : 1;
    lines = lines.slice(0, maxLines);

    // Si el cursor está en una línea solo con indentación, la primera línea
    // no debe traer su propia indentación (se duplicaría).
    const cursorAtIndent = !(ctx.linePrefix || '').trim();
    if (cursorAtIndent) lines[0] = lines[0].replace(/^\s+/, '');

    // 2. Balance de brackets: cortar donde se cierra más de lo abierto.
    if (ctx.mode === 'block') {
      let depth = 0;
      for (let i = 0; i < lines.length; i++) {
        const code = this._stripStringsAndComments_(lines[i]);
        let overflow = false;
        for (const ch of code) {
          if ('{(['.includes(ch)) depth++;
          else if ('})]'.includes(ch)) { depth--; if (depth < 0) { overflow = true; break; } }
        }
        if (overflow) { lines = lines.slice(0, i); break; }
      }
    }

    // 3. Duplicados con el código cercano.
    const nearby = this._nearbyLineSet_(ctx.prefix, ctx.suffix, ctx.linePrefix);
    const dupIdx = lines.findIndex((l) => nearby.has(this._normalizeLine_(l)));
    if (dupIdx !== -1) lines = lines.slice(0, dupIdx);

    // 4. Definición ya existente.
    const firstName = this._definedName_(lines[0] || '', ctx.linePrefix);
    if (firstName && this._isAlreadyDefined_(firstName, ctx.prefix, ctx.suffix)) return '';

    // 5. Indentación de las líneas 2..n relativa a la del cursor.
    if (lines.length > 1) {
      const baseIndent = (ctx.linePrefix || '').match(/^\s*/)[0];
      const rest = lines.slice(1);
      const minIndent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), Infinity);
      const strip = Number.isFinite(minIndent) ? minIndent : 0;
      // Las líneas que abren bloque añaden un nivel a las siguientes; aquí
      // preservamos la indentación relativa que trae el modelo.
      lines = [lines[0], ...rest.map((l) => (l.trim() ? baseIndent + l.slice(strip) : ''))];
    }

    const out = lines.join('\n').replace(/\s+$/, '');
    return out.trim() ? out : '';
  }

  /** Normaliza una línea para comparar duplicados (sin espacios ni `;`/`,` final). */
  _normalizeLine_(line) {
    return String(line || '').trim().replace(/\s+/g, ' ').replace(/[;,]$/, '');
  }

  /**
   * Conjunto de líneas normalizadas (≥ 6 chars) alrededor del cursor:
   * las últimas N del prefix (sin la línea actual) y las primeras N del suffix.
   * @private
   */
  _nearbyLineSet_(prefix, suffix, linePrefix) {
    const N = GasAiAutocomplete.DUPLICATE_WINDOW_LINES;
    const before = String(prefix || '').slice(0, prefix.length - (linePrefix || '').length).split('\n').slice(-N);
    const after  = String(suffix || '').split('\n').slice(0, N);
    const set = new Set();
    for (const l of [...before, ...after]) {
      const n = this._normalizeLine_(l);
      if (n.length >= 6) set.add(n);
    }
    return set;
  }

  /**
   * Nombre que define una línea de código: `const x`, `let x`, `var x`,
   * `function x`, `class x`, `x:` (propiedad) o `x(...) {` (método).
   * Solo cuando la línea empieza una declaración (cursor al inicio).
   * @private
   */
  _definedName_(firstLine, linePrefix) {
    if ((linePrefix || '').trim()) return null;
    const m = String(firstLine).match(
      /^\s*(?:(?:export\s+)?(?:const|let|var|function\*?|class|async\s+function)\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*:(?!:)|([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/
    );
    return m ? (m[1] || m[2] || m[3]) : null;
  }

  /** `true` si `name` ya se define (declaración, propiedad o método) en el contexto. */
  _isAlreadyDefined_(name, prefix, suffix) {
    const esc = name.replace(/[$]/g, '\\$');
    const re = new RegExp(
      `(?:\\b(?:const|let|var|function\\*?|class)\\s+${esc}\\b)|(?:^|[\\s{,])${esc}\\s*:(?!:)|(?:^\\s*${esc}\\s*\\([^)]*\\)\\s*\\{)`,
      'm'
    );
    const strip_ = (s) => String(s || '').split('\n').map((l) => this._stripStringsAndComments_(l)).join('\n');
    return re.test(strip_(prefix)) || re.test(strip_(suffix));
  }

  /** Quita strings y comentarios de una línea (aproximado, suficiente para brackets/nombres). */
  _stripStringsAndComments_(line) {
    return String(line || '')
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*?\*\//g, '')
      .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
  }

  /**
   * Empaqueta el texto sugerido en el formato que espera Monaco para
   * inline completions.
   * @param {string} text
   * @param {object} position
   * @returns {object}
   * @private
   */
  _toCompletion_(text, position) {
    return {
      items: [{
        insertText: text,
        range: new window.monaco.Range(
          position.lineNumber, position.column,
          position.lineNumber, position.column,
        ),
        completeBracketPairs: false,
      }],
      dispose() {},
    };
  }

  // ── Contexto ─────────────────────────────────────────────────────────────

  /**
   * Captura todo el contexto necesario alrededor del cursor: prefix, suffix,
   * línea actual, lenguaje real (HTML embebido en `<script>`/`<style>`),
   * y comentario abierto si aplica. También aplica los guards mínimos y
   * descarta posiciones triviales (después de cierres, archivo vacío).
   *
   * @param {object} model
   * @param {object} position
   * @param {boolean} [isExplicit=false] Trigger manual: relaja los guards de contexto mínimo.
   * @returns {object|null} Contexto FIM o `null` si no se debe sugerir.
   * @private
   */
  _buildContext_(model, position, isExplicit = false) {
    const fullText = model.getValue();
    const offset   = model.getOffsetAt(position);
    const before   = fullText.slice(0, offset);
    const after    = fullText.slice(offset);

    const rawLang  = String(model.getLanguageId() || '').toLowerCase();
    const baseLang = this._normalizeLang_(rawLang);
    const embedded = this._detectEmbedded_(before, after, baseLang);
    const language = embedded.language;

    const lineText   = model.getLineContent(position.lineNumber);
    const linePrefix = lineText.slice(0, position.column - 1);
    const lineSuffix = lineText.slice(position.column - 1);

    // Guard: no sugerir si el cursor está justo después de un cierre evidente.
    const trimmedLinePrefix = linePrefix.trimEnd();
    if (
      trimmedLinePrefix.endsWith('*/')  ||
      trimmedLinePrefix.endsWith('-->') ||
      trimmedLinePrefix.endsWith('}}')
    ) {
      this._log_('Omitido: cursor justo después de un cierre (*/, -->, }}).');
      return null;
    }

    const comment   = this._detectComment_(before, language);
    const isComment = !!comment;

    // Guard: en código real, sin nada antes y línea vacía, no hay nada útil.
    if (!isComment) {
      const onlyWhitespaceLine = linePrefix.trim().length === 0;
      const noPriorContext     = before.replace(linePrefix, '').trim().length === 0;
      if (onlyWhitespaceLine && noPriorContext) { this._log_('Omitido: archivo vacío.'); return null; }

      // Contexto mínimo para triggers automáticos (evita peticiones inútiles):
      //  - menos de 3 caracteres de código antes del cursor;
      //  - línea actual vacía y línea anterior también vacía;
      //  - cursor pegado a una palabra a la derecha (edición a mitad de token).
      if (!isExplicit) {
        if (before.trim().length < 3) { this._log_('Omitido: muy poco código antes del cursor.'); return null; }
        if (onlyWhitespaceLine) {
          const prevLine = position.lineNumber > 1
            ? model.getLineContent(position.lineNumber - 1)
            : '';
          if (prevLine.trim().length === 0) { this._log_('Omitido: línea vacía tras otra línea vacía.'); return null; }
        }
        if (/^\w/.test(lineSuffix)) { this._log_('Omitido: cursor a mitad de palabra.'); return null; }
      }
    }

    // Recortes para mantener el prompt en un tamaño razonable.
    const prefix = before.length > GasAiAutocomplete.MAX_PREFIX_CHARS
      ? before.slice(-GasAiAutocomplete.MAX_PREFIX_CHARS)
      : before;
    const suffix = after.length > GasAiAutocomplete.MAX_SUFFIX_CHARS
      ? after.slice(0, GasAiAutocomplete.MAX_SUFFIX_CHARS)
      : after;

    // Líneas no vacías vecinas: deciden si estamos rellenando un bloque vacío
    // o insertando entre código existente (ver `_completionMode_`).
    const prevLine = before.slice(0, before.length - linePrefix.length)
      .split('\n').reverse().find((l) => l.trim()) || '';
    const nextLine = after.slice(lineSuffix.length)
      .split('\n').find((l) => l.trim()) || '';
    // Lo que sigue al cursor: el resto de la línea si tiene algo, si no la
    // siguiente línea no vacía.
    const following = lineSuffix.trim() ? lineSuffix : nextLine;
    const mode = isComment ? 'comment' : this._completionMode_(linePrefix, prevLine, following, isExplicit);

    // Línea vacía justo antes de un comentario/JSDoc existente (separación
    // de secciones, como en la captura del bug): el trigger automático no
    // aporta nada y el modelo tiende a inventar. Sigue disponible con
    // Ctrl+Shift+Espacio.
    if (!isExplicit && mode === 'line' && !linePrefix.trim() && /^\s*(?:\/\*\*|\/\/|\*)/.test(nextLine)) {
      this._log_('Omitido: línea vacía antes de un comentario existente (usa Ctrl+Shift+Espacio).');
      return null;
    }

    let fileName = '';
    try { fileName = window.gasFileMap?.get?.(String(model.uri)) || ''; } catch (_) { /* opcional */ }

    return {
      prefix, suffix, linePrefix, lineSuffix,
      language, embedded: embedded.context,
      isComment, comment,
      prevLine, nextLine, mode, fileName,
    };
  }

  /**
   * Normaliza el id de lenguaje de Monaco al usado por el prompt.
   * `xml`/`handlebars` se tratan como HTML; `js`/`javascript`/`typescript`
   * como Google Apps Script (porque ese es el contexto del IDE).
   * @param {string} raw
   * @returns {string}
   * @private
   */
  _normalizeLang_(raw) {
    if (raw === 'xml' || raw === 'handlebars') return 'html';
    if (raw === 'js'  || raw === 'javascript' || raw === 'typescript') return 'google apps script';
    return raw;
  }

  /**
   * Detecta si el cursor está dentro de un bloque HTML `<script>` o `<style>`
   * para cambiar el lenguaje activo de cara al prompt.
   * @param {string} before
   * @param {string} after
   * @param {string} baseLang
   * @returns {{language:string, context:string}}
   * @private
   */
  _detectEmbedded_(before, after, baseLang) {
    if (baseLang !== 'html') return { language: baseLang, context: 'root' };
    const lower = before.toLowerCase();

    const sOpen  = lower.lastIndexOf('<script');
    const sClose = lower.lastIndexOf('</script>');
    if (sOpen !== -1 && sOpen > sClose) return { language: 'javascript', context: 'script' };

    const stOpen  = lower.lastIndexOf('<style');
    const stClose = lower.lastIndexOf('</style>');
    if (stOpen !== -1 && stOpen > stClose) return { language: 'css', context: 'style' };

    return { language: 'html', context: 'html' };
  }

  /**
   * Detecta si el prefix termina dentro de un comentario abierto
   * (línea, bloque o HTML) y devuelve el texto ya escrito en él.
   * @param {string} before
   * @param {string} language
   * @returns {{type:string, text:string, prefix:string}|null}
   * @private
   */
  _detectComment_(before, language) {
    const lines = before.split('\n');
    const last  = lines[lines.length - 1] || '';

    const m = last.match(/(^|\s)\/\/\s?(.*)$/);
    if (m) return { type: 'line', text: m[2], prefix: '//' };

    const bOpen  = before.lastIndexOf('/*');
    const bClose = before.lastIndexOf('*/');
    if (bOpen !== -1 && bOpen > bClose) {
      const text = before.slice(bOpen + 2).replace(/(^|\n)\s*\* ?/g, '$1');
      return { type: 'block', text: text.trim(), prefix: '/*' };
    }

    if (language === 'html') {
      const hOpen  = before.lastIndexOf('<!--');
      const hClose = before.lastIndexOf('-->');
      if (hOpen !== -1 && hOpen > hClose) {
        return { type: 'html', text: before.slice(hOpen + 4).trim(), prefix: '<!--' };
      }
    }

    return null;
  }

  // ── Prompts ──────────────────────────────────────────────────────────────

  /**
   * Selecciona el prompt apropiado según si el cursor está en un comentario
   * o en código. Para código usa formato FIM con delimitadores explícitos.
   * @param {object} ctx
   * @returns {string}
   * @private
   */
  _buildPrompt_(ctx) {
    const langLabel    = this._languageLabel_(ctx.language);
    const embeddedHint = this._embeddedHint_(ctx.embedded, langLabel);

    if (ctx.isComment) {
      return this._buildCommentPrompt_(ctx, langLabel, embeddedHint);
    }

    const scope = {
      inline: 'Complete ONLY the rest of the current line. Never add a new line.',
      line:   'Insert AT MOST one new line of code at <CURSOR>.',
      block:  `Insert the missing code at <CURSOR> (at most ${GasAiAutocomplete.MAX_BLOCK_LINES} lines).`,
    }[ctx.mode] || 'Complete the code at <CURSOR>.';

    return [
      `Inline ${langLabel} completion${ctx.fileName ? ` in file "${ctx.fileName}"` : ''}.${embeddedHint ? ' ' + embeddedHint : ''}`,
      scope,
      `Rules:`,
      `- Everything after <CURSOR> ALREADY EXISTS in the file. Never repeat, rewrite or move it.`,
      `- Only write code that is clearly implied by the surrounding code. Never invent configuration values, data, colors, messages or names that do not appear in the context.`,
      `- If nothing is clearly missing at <CURSOR>, return an empty string.`,
      `- Keep the existing style and indentation. Output raw code only: no fences, no markdown, no explanations.`,
      ``,
      `<CODE>`,
      `${ctx.prefix}<CURSOR>${ctx.suffix}`,
      `</CODE>`,
    ].join('\n');
  }

  /**
   * Construye el prompt de comentarios. Estrategia:
   *  - Sin lookahead cuando el usuario ya escribió texto (no se distrae).
   *  - Lookahead corto cuando abrió el comentario sin texto, para que el
   *    modelo pueda describir el código que viene.
   *  - Idioma: lo deduce del texto del usuario; si falta, de los comentarios
   *    cercanos del archivo; si tampoco, default inglés.
   *  - Refuerzos contra reescritura/corrección del texto del usuario.
   *
   * @param {object} ctx
   * @param {string} langLabel
   * @param {string} embeddedHint
   * @returns {string}
   * @private
   */
  _buildCommentPrompt_(ctx, langLabel, embeddedHint) {
    const { comment, prefix, linePrefix } = ctx;
    const closer = comment.type === 'block' ? '*/' : comment.type === 'html' ? '-->' : '';

    const adjacent       = prefix.split('\n').slice(-8, -1).join('\n');
    const sampleComments = this._sampleNearbyComments_(prefix, comment.text);
    const subjectAhead   = comment.text ? '' : this._peekFollowing_(ctx.suffix, 4);

    const sections = [];
    if (adjacent.trim()) {
      sections.push(`-- code before --\n${adjacent}`);
    }
    if (subjectAhead) {
      sections.push(`-- code after the comment (this is what the comment likely describes) --\n${subjectAhead}`);
    }
    if (sampleComments) {
      sections.push(`-- sample comments from this file (use the same language) --\n${sampleComments}`);
    }
    sections.push(`-- current line up to cursor --\n${linePrefix || '(empty)'}`);

    const langRule = comment.text
      ? 'Match the language already used by the user.'
      : sampleComments
        ? 'Match the language of the sample comments.'
        : 'Use English.';

    const taskLine = comment.text
      ? `Continue the comment text strictly AFTER "${comment.text}". Output only the missing characters.`
      : `Write a short, useful comment text describing the code that follows.`;

    const joinHint = comment.text && !/\s$/.test(linePrefix)
      ? ' Start your output with a single space if a new word begins.'
      : '';

    const userTextRule = comment.text
      ? `Treat the user's text as authoritative — never rewrite, rephrase, or correct their typos. Never repeat any word the user already typed. Pick up exactly where they stopped.`
      : '';

    return [
      `You write inline completions for ${langLabel} comments.${embeddedHint ? ' ' + embeddedHint : ''}`,
      langRule,
      ``,
      sections.join('\n\n'),
      ``,
      `Task: ${taskLine}${joinHint}`,
      userTextRule,
      `Rules: natural-language text only (no code, no markers ${comment.prefix}${closer ? '/' + closer : ''}, no quotes/backticks). Empty string if nothing useful.`,
    ].filter(Boolean).join('\n');
  }

  /**
   * Toma hasta 3 comentarios reales del prefix para que el LLM pueda
   * detectar el idioma del archivo. Excluye la última línea (donde está
   * el comentario en curso) y cualquier línea que contenga el texto que
   * el usuario está escribiendo.
   *
   * @param {string} prefix
   * @param {string} [excludeText] Texto del comentario actual a descartar.
   * @returns {string} Bloque listo para inyectar en el prompt.
   * @private
   */
  _sampleNearbyComments_(prefix, excludeText = '') {
    const out     = [];
    const lines   = prefix.split('\n');
    const exclude = excludeText.trim();
    for (let i = lines.length - 2; i >= 0 && out.length < 3; i--) {
      const m = lines[i].match(/(?:\/\/|\/\*\*?|\*|<!--)\s*(.{6,})$/);
      if (!m) continue;
      const text = m[1].replace(/\s*(\*\/|-->)\s*$/, '').trim();
      if (text.length < 6) continue;
      if (exclude && (text.includes(exclude) || exclude.includes(text))) continue;
      out.unshift(text.slice(0, 80));
    }
    return out.join('\n');
  }

  /**
   * Extrae las primeras `maxLines` líneas no vacías del suffix. Se usa
   * cuando el usuario abrió un comentario sin texto: la sugerencia debe
   * describir el código que viene después.
   * @param {string} suffix
   * @param {number} [maxLines=4]
   * @returns {string}
   * @private
   */
  _peekFollowing_(suffix, maxLines = 4) {
    if (!suffix) return '';
    const out = [];
    for (const ln of suffix.split('\n')) {
      if (out.length >= maxLines) break;
      if (ln.trim().length === 0) continue;
      out.push(ln);
    }
    return out.join('\n');
  }

  /**
   * Etiqueta legible del lenguaje para usar en los prompts.
   * @param {string} languageId
   * @returns {string}
   * @private
   */
  _languageLabel_(languageId) {
    return ({
      javascript:           'JavaScript',
      typescript:           'TypeScript',
      'google apps script': 'Google Apps Script',
      css:                  'CSS',
      html:                 'HTML',
      json:                 'JSON',
      jsonc:                'JSON with comments',
    })[languageId] || languageId;
  }

  /**
   * Hint que se añade al prompt cuando el cursor está dentro de un bloque
   * embebido (`<script>` o `<style>`).
   * @param {string} ctx        Identificador del contexto embebido.
   * @param {string} langLabel  Etiqueta del lenguaje activo.
   * @returns {string}
   * @private
   */
  _embeddedHint_(ctx, langLabel) {
    if (ctx === 'script') return `The cursor is inside an HTML <script> tag, so the active language is ${langLabel}.`;
    if (ctx === 'style')  return 'The cursor is inside an HTML <style> tag, so the active language is CSS.';
    return '';
  }

  // ── Configuración ────────────────────────────────────────────────────────

  /**
   * Pide la config LLM pública al background (vía content script) y la
   * guarda en `_llmConfig`. Si falla o expira, se conserva la anterior.
   * @private
   */
  async _loadConfig_() {
    const seq = ++this._configLoadSeq;
    try {
      const res = await DomUtils.bridgeRequest(
        'GAS_LLM_GET_CONFIG', 'GAS_LLM_CONFIG_RESULT', {}, { timeoutMs: 10000 }
      );
      if (seq !== this._configLoadSeq || !this._enabled) return;
      if (res?.data && typeof res.data === 'object') {
        this._llmConfig = res.data;
        this._cache.clear();
      } else {
        this._log_('No se pudo cargar la config LLM (timeout o respuesta vacía).');
      }
    } catch (err) {
      this._log_('Error cargando la config LLM:', err);
    }
  }

  /**
   * Escucha `GAS_LLM_CONFIG_UPDATED` (lo despacha el content script cuando
   * cambia la config desde el Side Panel/popup) y vuelve a pedirla.
   * @private
   */
  _bindConfigUpdates_() {
    if (this._onLlmConfigUpdated) return;
    this._onLlmConfigUpdated = () => this._loadConfig_();
    document.addEventListener('GAS_LLM_CONFIG_UPDATED', this._onLlmConfigUpdated);
  }

  /** Quita el listener de `GAS_LLM_CONFIG_UPDATED`. @private */
  _unbindConfigUpdates_() {
    if (!this._onLlmConfigUpdated) return;
    document.removeEventListener('GAS_LLM_CONFIG_UPDATED', this._onLlmConfigUpdated);
    this._onLlmConfigUpdated = null;
    // Invalida cualquier carga en vuelo.
    this._configLoadSeq++;
  }

  /**
   * Arma la configuración de la petición desde la config LLM cacheada
   * (`_llmConfig`). El system prompt se arma aquí con un default por
   * lenguaje + reglas estrictas, en lugar de heredar el prompt del chat
   * (que está orientado a conversación).
   *
   * @param {string} languageId
   * @returns {object|null} null si la config aún no está cargada o falta la API key.
   * @private
   */
  _readConfig_(languageId) {
    const cfg = this._llmConfig;
    if (!cfg) return null;

    const provider = cfg.provider || 'gemini';
    const model    = cfg.model    || '';

    // La API key vive solo en el background; la config expone únicamente
    // qué providers la tienen configurada. `custom` puede no requerirla.
    if (provider !== 'custom' && !cfg.apiKeysSet?.[provider]) return null;

    const provSettings = (cfg.providerSettings || {})[provider] || {};
    // Completar código debe ser determinista: temperatura 0 (independiente
    // de la que use el chat). Más temperatura = más "invención".
    const temperature  = 0;
    const endpointUrl  = provSettings.endpointUrl || '';

    const systemPrompt =
`${this._defaultSystemPrompt_(languageId)}
Return ONLY the requested text. No fences, no quotes, no explanation. Empty string is valid. Match the language of the surrounding context (default English).`;

    return { provider, model, endpointUrl, temperature, systemPrompt };
  }

  /**
   * System prompt base por lenguaje. Conciso a propósito: menos tokens en
   * el system prompt = respuesta más rápida del modelo.
   * @param {string} languageId
   * @returns {string}
   * @private
   */
  _defaultSystemPrompt_(languageId) {
    return ({
      'google apps script': 'You are an expert Google Apps Script developer.',
      javascript:           'You are an expert JavaScript developer.',
      typescript:           'You are an expert TypeScript developer.',
      css:                  'You are an expert CSS author.',
      html:                 'You are an expert in semantic, accessible HTML5.',
      json:                 'You produce strictly valid JSON.',
      jsonc:                'You produce JSON with comments (JSONC).',
    })[languageId] || 'You are an expert software developer.';
  }

  // ── Bridge LLM ───────────────────────────────────────────────────────────

  /**
   * Despacha la petición al background (vía `DomUtils.bridgeRequest`) y
   * espera la respuesta correlacionada por `requestId`. Al abortar (señal
   * o token de Monaco) o al vencer el timeout, emite `GAS_LLM_CANCEL` para
   * que el background corte el fetch en vuelo.
   *
   * @param {object} payload Cuerpo de `GAS_LLM_REQUEST` (sin apiKey) + `signal`.
   * @param {AbortSignal} payload.signal
   * @returns {Promise<string>}
   * @private
   */
  async _callBridge_(payload) {
    const { signal, ...body } = payload;
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sendCancel = () => {
      document.dispatchEvent(new CustomEvent('GAS_LLM_CANCEL', {
        detail: JSON.stringify({ requestId }),
      }));
    };

    let data;
    try {
      data = await DomUtils.bridgeRequest('GAS_LLM_REQUEST', 'GAS_LLM_RESPONSE', body, {
        timeoutMs: GasAiAutocomplete.BRIDGE_TIMEOUT_MS,
        signal,
        requestId,
      });
    } catch (err) {
      if (err?.name === 'AbortError') sendCancel();
      throw err;
    }

    if (!data) {
      sendCancel();
      throw new Error('LLM bridge timeout');
    }
    if (!data.ok) {
      const err = new Error(data.error || 'LLM error');
      if (data.permissionOrigin) err.permissionOrigin = data.permissionOrigin;
      if (data.aborted) err.name = 'AbortError';
      throw err;
    }
    return data.content || '';
  }

  // ── Post-procesado ───────────────────────────────────────────────────────

  /**
   * Limpia ruido típico de respuestas LLM:
   *  - Recorta saltos de línea al borde (no espacios significativos).
   *  - Quita fences Markdown (```lang ... ```).
   *  - Quita comillas exteriores que envuelven toda la respuesta.
   *  - Para comentarios, elimina marcadores duplicados al inicio y cierres
   *    de bloque al final.
   *
   * No se hace `trim()` general porque un espacio inicial puede ser
   * significativo cuando el prefix de la línea termina en una letra y el
   * modelo lo añade para empalmar correctamente.
   *
   * @param {string} text
   * @param {boolean} isComment
   * @returns {string}
   * @private
   */
  _sanitize_(text, isComment) {
    let s = String(text || '');
    s = s.replace(/^[\r\n]+|[\r\n]+$/g, '');
    s = s.replace(/^```[a-zA-Z0-9-]*\r?\n?/, '').replace(/\r?\n?```$/, '');

    const trimmed = s.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      s = trimmed.slice(1, -1);
    }

    if (isComment) {
      s = s.replace(/^(\/\/\s*|\/\*\s*|<!--\s*)/, '');
      s = s.replace(/\s*(\*\/|-->)\s*$/, '');
    }
    return s;
  }

  /**
   * Recorta solapamientos del texto sugerido con el prefix o el suffix.
   * Pasa por tres etapas:
   *  1. Recorte exacto si el texto empieza con el prefix completo.
   *  2. Solapamiento de N caracteres entre fin del prefix e inicio del texto.
   *  3. Solapamiento fuzzy por palabras (ver `_stripFuzzyPrefix_`).
   *  4. Recorte al final si el texto termina con el suffix.
   *
   * @param {string} text
   * @param {string} prefix
   * @param {string} suffix
   * @returns {string}
   * @private
   */
  _stripOverlap_(text, prefix, suffix) {
    if (!text) return text;
    if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);

    if (prefix && text) {
      const max = Math.min(prefix.length, text.length, 60);
      for (let n = max; n >= 3; n--) {
        if (prefix.endsWith(text.slice(0, n))) { text = text.slice(n); break; }
      }
    }

    text = this._stripFuzzyPrefix_(text, prefix);

    if (suffix && text.endsWith(suffix)) text = text.slice(0, -suffix.length);
    return text;
  }

  /**
   * Recorta del inicio del texto las palabras que coinciden (incluso con
   * pequeños errores de tipeo) con las últimas palabras del prefix. Útil
   * cuando el modelo "corrige" o reescribe lo que el usuario tipeó en
   * lugar de continuar.
   *
   * Compara hasta 6 palabras finales del prefix contra las primeras de
   * `text` usando Levenshtein normalizado. Match si distancia ≤ 0.34.
   *
   * @param {string} text
   * @param {string} prefix
   * @returns {string}
   * @private
   */
  _stripFuzzyPrefix_(text, prefix) {
    const tail = prefix.match(/\S+/g) || [];
    if (!tail.length || !text) return text;

    // Tokenizamos `text` preservando espacios para reconstruir luego.
    const tokens = [];
    const re = /(\s+|\S+)/g;
    let m;
    while ((m = re.exec(text)) !== null) tokens.push(m[1]);

    const MAX_WORDS = Math.min(6, tail.length);
    let cutTokenIdx = -1;

    for (let k = 1; k <= MAX_WORDS; k++) {
      const tailWords  = tail.slice(-k).map(w => w.toLowerCase());
      const firstWords = [];
      const tokenIdxs  = [];
      for (let i = 0; i < tokens.length && firstWords.length < k; i++) {
        if (/^\s+$/.test(tokens[i])) continue;
        firstWords.push(tokens[i].toLowerCase());
        tokenIdxs.push(i);
      }
      if (firstWords.length < k) break;

      let allMatch = true;
      for (let i = 0; i < k; i++) {
        if (!this._fuzzyEqual_(tailWords[i], firstWords[i])) { allMatch = false; break; }
      }
      if (allMatch) cutTokenIdx = tokenIdxs[k - 1];
    }

    if (cutTokenIdx >= 0) return tokens.slice(cutTokenIdx + 1).join('');
    return text;
  }

  /**
   * Compara dos palabras en minúsculas con tolerancia a typos. Para
   * palabras de 1-2 letras exige coincidencia exacta para evitar falsos
   * positivos.
   * @param {string} a
   * @param {string} b
   * @returns {boolean}
   * @private
   */
  _fuzzyEqual_(a, b) {
    if (a === b) return true;
    if (a.length <= 2 || b.length <= 2) return false;
    const dist = this._levenshtein_(a, b);
    return (dist / Math.max(a.length, b.length)) <= 0.34;
  }

  /**
   * Levenshtein iterativo, O(a.length * b.length). Suficiente para palabras
   * cortas, que es el único uso interno.
   * @param {string} a
   * @param {string} b
   * @returns {number}
   * @private
   */
  _levenshtein_(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[b.length];
  }

  // ── Cache LRU ────────────────────────────────────────────────────────────

  /**
   * Genera la clave del cache. Solo se usan los últimos 200 chars del
   * prefix y los primeros 200 del suffix, así cambios lejanos no invalidan
   * la cache innecesariamente.
   * @param {string} prefix
   * @param {string} suffix
   * @param {string} language
   * @returns {string}
   * @private
   */
  _cacheKey_(prefix, suffix, language) {
    const p = prefix.slice(-200);
    const s = suffix.slice(0, 200);
    return `${language}\u0000${p}\u0000${s}`;
  }

  /**
   * Lee una entrada del cache refrescando su orden LRU. Las respuestas
   * vacías caducan tras `EMPTY_CACHE_TTL_MS`.
   * @param {string} key
   * @returns {string|undefined} Texto (posiblemente vacío) o `undefined` si no hay hit.
   * @private
   */
  _cacheGet_(key) {
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (!entry.text && Date.now() - entry.at > GasAiAutocomplete.EMPTY_CACHE_TTL_MS) {
      this._cache.delete(key);
      return undefined;
    }
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry.text;
  }

  /**
   * Inserta una entrada en el cache respetando la capacidad máxima.
   * También se cachean respuestas vacías (con TTL corto) para no repetir
   * la misma petición inútil en cada pausa.
   * @param {string} key
   * @param {string} value
   * @private
   */
  _cacheSet_(key, value) {
    if (this._cache.has(key)) this._cache.delete(key);
    this._cache.set(key, { text: value || '', at: Date.now() });
    while (this._cache.size > GasAiAutocomplete.CACHE_SIZE) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
  }

  // ── Cancelación ──────────────────────────────────────────────────────────

  /**
   * Aborta solo la petición LLM en vuelo, sin tocar el debounce timer.
   * @private
   */
  _abort_() {
    if (this._abortCtrl) {
      this._abortCtrl.abort();
      this._abortCtrl = null;
    }
  }

  /**
   * Cancela debounce + petición LLM en vuelo. Se usa en `disable()` y al
   * recibir un trigger explícito (que reemplaza al pendiente).
   * @private
   */
  _cancel_() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._pendingResolve) { this._pendingResolve(null); this._pendingResolve = null; }
    this._abort_();
  }
}

// ── Export ─────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasAiAutocomplete };
} else {
  window.GasAiAutocomplete = GasAiAutocomplete;
}
