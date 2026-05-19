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

  /** Tamaño máximo del prefix enviado al LLM (chars). */
  static MAX_PREFIX_CHARS = 1200;

  /** Tamaño máximo del suffix enviado al LLM (chars). */
  static MAX_SUFFIX_CHARS = 400;

  /** Capacidad del cache LRU de sugerencias. */
  static CACHE_SIZE = 32;

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
    this._disposables = [];
    this._debounceMs  = options.debounceMs ?? GasAiAutocomplete.DEBOUNCE_MS;

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
      // Monaco aún no está disponible: reintentar en breve.
      setTimeout(() => this.enable(), 500);
      return;
    }

    this._enabled = true;

    GasAiAutocomplete.SUPPORTED_LANGUAGES.forEach(lang => {
      try {
        const d = window.monaco.languages.registerInlineCompletionsProvider(lang, {
          provideInlineCompletions: (model, position, context, token) =>
            this._provideInline_(model, position, context, token),
          freeInlineCompletions(c) { c?.dispose?.(); },
        });
        this._disposables.push(d);
      } catch (_) { /* lenguaje no registrable: ignorar */ }
    });

    // Atajo Ctrl+Shift+Espacio: fuerza la sugerencia ignorando el debounce.
    if (this._editor.addCommand && window.monaco?.KeyMod) {
      this._editor.addCommand(
        window.monaco.KeyMod.CtrlCmd | window.monaco.KeyMod.Shift | window.monaco.KeyCode.Space,
        () => this._editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {})
      );
    }

    // Listener único para dos cosas: registrar timestamp de actividad y
    // detectar aceptación (inserción literal del texto que mostrábamos).
    this._editor.onDidChangeModelContent((ev) => {
      this._lastInputAt = Date.now();
      if (!this._lastShown) return;
      const accepted = ev?.changes?.some(c => c.text === this._lastShown);
      if (accepted) {
        this._lastAcceptedAt = Date.now();
        this._lastShown      = '';
      }
    });
  }

  /**
   * Desactiva el provider, libera disposables, cancela peticiones en vuelo
   * y limpia el cache.
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._cancel_();
    this._disposables.forEach(d => d?.dispose?.());
    this._disposables = [];
    this._cache.clear();
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

    if (isExplicit) {
      this._cancel_();
      return (await this._request_(model, position, token)) || empty;
    }

    const result = await this._debounce_(() => {
      // La posición y el modelo pueden haber cambiado durante el debounce;
      // los recapturamos para enviar el contexto exacto del momento actual.
      const pos = this._editor?.getPosition?.() || position;
      const mdl = this._editor?.getModel?.()    || model;
      return this._request_(mdl, pos, token);
    });

    return result || empty;
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
        const remaining = this._debounceMs - elapsed;
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
   * @returns {Promise<object|null>}
   * @private
   */
  async _request_(model, position, token) {
    if (!this._enabled || token?.isCancellationRequested) return null;

    const ctx = this._buildContext_(model, position);
    if (!ctx) return null;

    const cacheKey = this._cacheKey_(ctx.prefix, ctx.suffix, ctx.language);
    if (this._cache.has(cacheKey)) {
      const cached = this._cache.get(cacheKey);
      // Refrescar orden LRU.
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, cached);
      if (!cached) return null;
      this._lastShown = cached;
      return this._toCompletion_(cached, position);
    }

    const config = this._readConfig_(ctx.language);
    if (!config) return null;

    const prompt = this._buildPrompt_(ctx);
    this._reqCount++;

    this._abort_();
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;

    let cancelReg = null;
    if (typeof token?.onCancellationRequested === 'function') {
      cancelReg = token.onCancellationRequested(() => this._abortCtrl?.abort());
    }

    try {
      const raw = await this._callBridge_({
        provider:    config.provider,
        apiKey:      config.apiKey,
        model:       config.model,
        endpointUrl: config.endpointUrl,
        temperature: config.temperature,
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

      this._cacheSet_(cacheKey, text);

      if (!text) return null;
      this._lastShown = text;
      return this._toCompletion_(text, position);

    } catch (err) {
      if (err?.name === 'AbortError') return null;
      return null;
    } finally {
      cancelReg?.dispose?.();
      this._abortCtrl = null;
    }
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
   * @returns {object|null} Contexto FIM o `null` si no se debe sugerir.
   * @private
   */
  _buildContext_(model, position) {
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
      return null;
    }

    const comment   = this._detectComment_(before, language);
    const isComment = !!comment;

    // Guard: en código real, sin nada antes y línea vacía, no hay nada útil.
    if (!isComment) {
      const onlyWhitespaceLine = linePrefix.trim().length === 0;
      const noPriorContext     = before.replace(linePrefix, '').trim().length === 0;
      if (onlyWhitespaceLine && noPriorContext) return null;
    }

    // Recortes para mantener el prompt en un tamaño razonable.
    const prefix = before.length > GasAiAutocomplete.MAX_PREFIX_CHARS
      ? before.slice(-GasAiAutocomplete.MAX_PREFIX_CHARS)
      : before;
    const suffix = after.length > GasAiAutocomplete.MAX_SUFFIX_CHARS
      ? after.slice(0, GasAiAutocomplete.MAX_SUFFIX_CHARS)
      : after;

    return {
      prefix, suffix, linePrefix, lineSuffix,
      language, embedded: embedded.context,
      isComment, comment,
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

    return [
      `Inline ${langLabel} completion.${embeddedHint ? ' ' + embeddedHint : ''}`,
      `Output only the code that goes between <PREFIX> and <SUFFIX>. Do not repeat any character of either side. No fences, no markdown.`,
      ``,
      `<PREFIX>${ctx.prefix}</PREFIX>`,
      `<SUFFIX>${ctx.suffix}</SUFFIX>`,
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
   * Lee la configuración LLM desde `<gas-chat-panel>`. El system prompt se
   * arma aquí con un default por lenguaje + reglas estrictas, en lugar de
   * heredar el prompt del chat (que está orientado a conversación).
   *
   * @param {string} languageId
   * @returns {object|null}
   * @private
   */
  _readConfig_(languageId) {
    const panel = document.querySelector('gas-chat-panel');
    if (!panel?._config) return null;

    const cfg      = panel._config;
    const provider = cfg.provider || 'gemini';
    const model    = cfg.model    || '';
    const apiKey   = cfg.apiKeys?.[provider] || '';

    if (!apiKey && provider !== 'custom') return null;

    const provSettings = (cfg.providerSettings || {})[provider] || {};
    // Limitamos la temperatura a 0.3: queremos completados deterministas.
    const temperature  = Math.min(provSettings.temperature ?? 0.2, 0.3);
    const endpointUrl  = provSettings.endpointUrl || '';

    const systemPrompt =
`${this._defaultSystemPrompt_(languageId)}
Return ONLY the requested text. No fences, no quotes, no explanation. Empty string is valid. Match the language of the surrounding context (default English).`;

    return { provider, model, apiKey, endpointUrl, temperature, systemPrompt };
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
   * Despacha la petición al background mediante CustomEvent y espera la
   * respuesta correlacionada por `requestId`. Soporta cancelación vía
   * AbortSignal y timeout duro.
   *
   * @param {object} payload
   * @param {AbortSignal} payload.signal
   * @returns {Promise<string>}
   * @private
   */
  _callBridge_(payload) {
    const { signal, ...body } = payload;
    return new Promise((resolve, reject) => {
      const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        document.removeEventListener('GAS_LLM_RESPONSE', onResponse);
        signal.removeEventListener('abort', onAbort);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('LLM bridge timeout'));
      }, GasAiAutocomplete.BRIDGE_TIMEOUT_MS);

      const onResponse = (e) => {
        let data;
        try { data = JSON.parse(e.detail); } catch { return; }
        if (data.requestId !== requestId) return;
        cleanup();
        if (data.ok) resolve(data.content || '');
        else reject(new Error(data.error || 'LLM error'));
      };

      const onAbort = () => {
        cleanup();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };

      document.addEventListener('GAS_LLM_RESPONSE', onResponse);
      signal.addEventListener('abort', onAbort, { once: true });
      document.dispatchEvent(new CustomEvent('GAS_LLM_REQUEST', {
        detail: JSON.stringify({ requestId, ...body }),
      }));
    });
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
   * Inserta una entrada en el cache respetando la capacidad máxima.
   * No se cachean respuestas vacías para no devolver `null` silencioso
   * la próxima vez que se pida lo mismo.
   * @param {string} key
   * @param {string} value
   * @private
   */
  _cacheSet_(key, value) {
    if (!value) return;
    if (this._cache.has(key)) this._cache.delete(key);
    this._cache.set(key, value);
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
