"use strict";
/**
 * @fileoverview gas-ai-autocomplete.js
 *
 * Completado inline (ghost text) vía Monaco. La petición al LLM se realiza
 * con debounce real entre llamadas para evitar peticiones innecesarias.
 * Cancelación activa mediante AbortController por cada petición.
 */
console.log('[AIAutocomplete] Script cargado');

class GasAiAutocomplete {

  // ── Constantes de clase ──────────────────────────────────────────────────

  /** Máximo de caracteres de contexto enviados al LLM. */
  static MAX_CONTEXT_CHARS = 1500;

  /** Tiempo máximo de espera para la respuesta del bridge LLM. */
  static BRIDGE_TIMEOUT_MS = 12000;

  /**
   * Tiempo de espera (ms) antes de disparar la petición automática.
   * Evita llamadas al LLM mientras el usuario sigue escribiendo.
   * Solo aplica a triggers automáticos (triggerKind === 1).
   */
  static DEBOUNCE_MS = 450;

  /** IDs de lenguaje de Monaco que este proveedor soporta. */
  static SUPPORTED_LANGUAGES = new Set([
    'javascript',
    'typescript',
    'google apps script',
    'html',
    'xml',
    'handlebars',
    'json',
    'jsonc',
  ]);

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * Crea una nueva instancia del autocompletado AI inline.
   * @param {object} editor            - Instancia activa de Monaco Editor.
   * @param {object} [options]         - Opciones de configuración opcionales.
   * @param {number} [options.debounceMs] - Sobreescribe DEBOUNCE_MS si se indica.
   */
  constructor(editor, options = {}) {
    this._editor   = editor;
    this._enabled  = false;

    this._disposables          = [];
    this._providersRegistered  = false;
    this._keyboardCommandBound = false;

    /**
     * Timer del debounce compartido entre todas las llamadas a
     * `_provideInline_`. Al llegar una nueva llamada se cancela el timer
     * anterior, garantizando que solo la última keystroke dispara la petición.
     * @type {number|null}
     * @private
     */
    this._debounceTimer = null;

    /**
     * Permite sobreescribir el debounce por instancia (útil para ajuste en UI).
     * @type {number}
     * @private
     */
    this._debounceMs = options.debounceMs ?? GasAiAutocomplete.DEBOUNCE_MS;

    /**
     * AbortController de la petición LLM en vuelo.
     * Se cancela si llega una nueva petición antes de que la anterior resuelva,
     * evitando que una respuesta lenta sobreescriba la sugerencia más reciente.
     * @type {AbortController|null}
     * @private
     */
    this._pendingAbort = null;
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  /**
   * Activa el autocompletado AI y registra los providers en Monaco.
   */
  enable() {
    if (this._enabled || !this._editor) return;

    if (typeof window.monaco?.languages?.registerInlineCompletionsProvider !== 'function') {
      console.warn('[AIAutocomplete] Monaco no disponible, reintentando en 500ms…');
      setTimeout(() => this.enable(), 500);
      return;
    }

    this._enabled = true;

    if (!this._providersRegistered) {
      this._providersRegistered = true;
      console.log('[AIAutocomplete] Registrando providers para lenguajes soportados…');

      GasAiAutocomplete.SUPPORTED_LANGUAGES.forEach(lang => {
        try {
          const disposable = window.monaco.languages.registerInlineCompletionsProvider(lang, {
            provideInlineCompletions: (model, position, context, token) =>
              this._provideInline_(model, position, context, token),
            freeInlineCompletions(completions) {
              completions?.dispose?.();
            },
          });
          this._disposables.push(disposable);
        } catch (e) {
          console.warn('[AIAutocomplete] Error registrando provider para', lang, e.message);
        }
      });
    }

    // Ctrl+Shift+Space → fuerza sugerencia inline — se registra una sola vez
    if (this._editor.addCommand && window.monaco?.KeyMod && !this._keyboardCommandBound) {
      this._keyboardCommandBound = true;

      // Crea un shortcut para forzar la sugerencia inline
      this._editor.addCommand(
        window.monaco.KeyMod.CtrlCmd |
        window.monaco.KeyMod.Shift   |
        window.monaco.KeyCode.Space,
        () => this._editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {})
      );
      console.log('[AIAutocomplete] Atajo Ctrl+Shift+Espacio registrado');
    }

    console.log('[AIAutocomplete] Habilitado.');
  }

  /**
   * Desactiva el autocompletado AI y libera todos los recursos.
   * Cancela cualquier petición LLM en vuelo y limpia el debounce.
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;

    this._cancelPending_('disable');

    this._disposables.forEach(d => d?.dispose?.());
    this._disposables = [];

    console.log('[AIAutocomplete] Deshabilitado.');
  }

  /**
   * Cambia el debounce en caliente sin necesidad de recrear la instancia.
   * @param {number} ms - Milisegundos de espera (0 para desactivar).
   */
  setDebounceMs(ms) {
    this._debounceMs = Math.max(0, ms);
    console.log('[AIAutocomplete] Debounce actualizado a', this._debounceMs, 'ms');
  }

  // ── Inline completions ───────────────────────────────────────────────────

  /**
   * Retorna una respuesta vacía válida para Monaco.
   * Se usa como valor de retorno temprano en cualquier salida anticipada.
   * Monaco acepta `items: []` sin necesidad de range.
   *
   * @returns {{ items: [], dispose: function }}
   * @private
   */
  _empty_() {
    return { items: [], dispose() {} };
  }

  /**
   * Proveedor principal de completados inline para Monaco.
   *
   * Flujo:
   *  1. Debounce real: cancela timers anteriores y espera `_debounceMs`.
   *  2. Cancela cualquier petición LLM anterior aún en vuelo.
   *  3. Valida posición, lenguaje y configuración.
   *  4. Construye prompt y envía al bridge.
   *  5. Retorna la sugerencia o `_empty_()` ante cualquier error/cancelación.
   *
   * @param {object} model    - Modelo del editor Monaco.
   * @param {object} position - Posición del cursor { lineNumber, column }.
   * @param {object} context  - Contexto del trigger (triggerKind, etc.).
   * @param {object} token    - Token de cancelación de Monaco.
   * @returns {Promise<object>} Sugerencias inline para Monaco.
   * @private
   */
  async _provideInline_(model, position, context, token) {
    const empty = this._empty_();

    if (!this._enabled) return empty;

    // ── Debounce real ──────────────────────────────────────────────────────
    // Para triggers automáticos (el usuario escribe) esperamos `_debounceMs`
    // antes de procesar. Si llega una nueva llamada antes de que el timer
    // venza, se cancela el anterior y se reinicia el conteo.
    // Los triggers explícitos (Ctrl+Shift+Space, triggerKind !== 1) saltan
    // el debounce para responder de inmediato.
    if (context?.triggerKind === 1) {
      if (this._debounceTimer !== null) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }

      await new Promise(resolve => {
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = null;
          resolve();
        }, this._debounceMs);
      });

      // Monaco puede haber cancelado la petición durante la espera
      if (token?.isCancellationRequested) return empty;
    }

    // ── Cancelar petición LLM anterior aún en vuelo ────────────────────────
    this._cancelPending_('new-request');

    // ── Validaciones tempranas ─────────────────────────────────────────────
    const rawLangId  = String(model.getLanguageId() || '').toLowerCase();
    const languageId = this._normalizeLanguageId_(rawLangId);

    const lineText         = model.getLineContent(position.lineNumber);
    const charBeforeCursor = position.column >= 2 ? lineText.charAt(position.column - 2) : '';

    const textBeforeInLine = lineText.substring(0, position.column - 1);
    const commentInfo      = this._detectComment_(textBeforeInLine, languageId);
    const isCommentTrigger = !!commentInfo;
    const commentText      = isCommentTrigger ? commentInfo.text : '';

    if (!this._shouldOfferAtPosition_(languageId, position.column, charBeforeCursor)) {
      return empty;
    }

    // ── Construcción de contexto ───────────────────────────────────────────
    const offset    = model.getOffsetAt(position);
    const fullText  = model.getValue();
    const rawBefore = fullText.slice(0, offset);
    const rawAfter  = fullText.slice(offset);

    const lookaheadLines = rawAfter.split('\n').slice(0, 5).join('\n');
    const hasCodeAfter   = lookaheadLines.trim().length > 0;

    // Leer configuración del panel de chat
    const config = this._readChatConfig_();
    if (!config) return empty;

    // Limitar contexto para no saturar el prompt
    const contextBefore = rawBefore.length > GasAiAutocomplete.MAX_CONTEXT_CHARS
      ? '…\n' + rawBefore.slice(-GasAiAutocomplete.MAX_CONTEXT_CHARS)
      : rawBefore;

    const userPrompt = this._buildPrompt_({
      isCommentTrigger,
      commentText,
      commentType:   commentInfo?.type || 'line',
      contextBefore,
      hasCodeAfter,
      lookaheadLines,
      languageId,
    });

    // ── Preparar petición ──────────────────────────────────────────────────
    // AbortController propio de esta petición, guardado en la instancia
    // para que una llamada posterior pueda cancelarla.
    const abortCtrl    = new AbortController();
    this._pendingAbort = abortCtrl;

    // Enlazar también con el token de cancelación de Monaco
    let cancelReg = null;
    if (typeof token?.onCancellationRequested === 'function') {
      cancelReg = token.onCancellationRequested(() => abortCtrl.abort());
    }

    try {
      const requestId = `ai-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      console.log("%c[AIAutocomplete] Enviando petición al LLM", "color: #7c3aed; font-weight: bold;", {
        language: languageId,
        isComment: isCommentTrigger,
        system: config.systemPrompt,
        user: userPrompt
      });

      const completion = await this._bridgeRequest_({
        requestId,
        provider:     config.provider,
        apiKey:       config.apiKey,
        model:        config.model,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user',   content: userPrompt          },
        ],
        temperature: config.temperature,
        signal:      abortCtrl.signal,
        // Contexto adicional para el bridge
        languageId,
        isCommentTrigger,
      });

      if (!this._enabled) return empty;

      const text = (completion || '').trim();
      if (!text) return empty;

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

    } catch (err) {
      if (err?.name === 'AbortError' || err?.message === 'aborted') return empty;
      console.warn('[AIAutocomplete] Error en petición:', err?.message || err);
      return empty;

    } finally {
      cancelReg?.dispose?.();
      // Limpiar referencia solo si sigue siendo la petición activa
      if (this._pendingAbort === abortCtrl) {
        this._pendingAbort = null;
      }
    }
  }

  // ── Utilidades internas ──────────────────────────────────────────────────

  /**
   * Cancela la petición LLM en vuelo (si existe) y limpia el debounce timer.
   * @param {string} [reason=''] - Motivo del cancelado (solo para logs).
   * @private
   */
  _cancelPending_(reason = '') {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._pendingAbort) {
      this._pendingAbort.abort();
      this._pendingAbort = null;
      if (reason) console.log(`[AIAutocomplete] Petición cancelada (${reason})`);
    }
  }

  /**
   * Normaliza el ID de lenguaje de Monaco a uno soportado.
   * @param {string} rawId - ID de lenguaje original.
   * @returns {string} ID normalizado.
   * @private
   */
  _normalizeLanguageId_(rawId) {
    if (rawId === 'xml' || rawId === 'handlebars') return 'html';
    return rawId;
  }

  /**
   * Detecta si el texto proporcionado termina en un comentario abierto.
   * Soporta //, /* y <!-- según el lenguaje.
   * @param {string} text       - Texto de la línea hasta el cursor.
   * @param {string} languageId - ID de lenguaje normalizado.
   * @returns {{ type: string, text: string }|null}
   * @private
   */
  _detectComment_(text, languageId) {
    // Comentario de línea estándar (JS, TS, GAS…)
    const lineMatch = text.match(/\/\/\s*(.*)$/);
    if (lineMatch) return { type: 'line', text: lineMatch[1] };

    // Comentario de bloque /* … (no cerrado en la misma línea)
    const blockStart = text.lastIndexOf('/*');
    if (blockStart !== -1 && text.indexOf('*/', blockStart) === -1) {
      return { type: 'block', text: text.substring(blockStart + 2).trim() };
    }

    // Comentario HTML <!-- … (solo en lenguajes markup)
    if (languageId === 'html' || languageId === 'xml') {
      const htmlStart = text.lastIndexOf('<!--');
      if (htmlStart !== -1 && text.indexOf('-->', htmlStart) === -1) {
        return { type: 'html', text: text.substring(htmlStart + 4).trim() };
      }
    }

    return null;
  }

  /**
   * Determina si se debe ofrecer autocompletado en la posición actual.
   * @param {string} languageId - ID de lenguaje normalizado.
   * @param {number} column     - Columna del cursor.
   * @param {string} ch         - Carácter justo antes del cursor.
   * @returns {boolean}
   * @private
   */
  _shouldOfferAtPosition_(languageId, column, ch) {
    if (column < 1) return false;

    // Al inicio de línea solo aplica en lenguajes de marcado/datos
    if (column === 1) {
      return ['html', 'json', 'jsonc', 'xml'].includes(languageId);
    }

    if (ch === '\n' || ch === '\r') return false;

    if (languageId === 'json' || languageId === 'jsonc') {
      return /[\s\w."'\-:,/[\]{}]/.test(ch);
    }

    if (languageId === 'html' || languageId === 'xml') {
      return /[\s\w.<>=/"'`*\-:!?#_@$%&;,()[\]{}]/.test(ch);
    }

    return /[\s\w."'`.,;:!?()[\]{}<>+*/%&|^~=@#$\\]/.test(ch) || ch === '-';
  }

  // ── Construcción de prompt ───────────────────────────────────────────────

  /**
   * Construye el prompt de usuario enviado al LLM.
   * @param {object} opts                  - Parámetros del contexto actual.
   * @param {boolean} opts.isCommentTrigger - Si el trigger fue un comentario.
   * @param {string}  opts.commentText      - Texto del comentario detectado.
   * @param {string}  opts.commentType      - Tipo: 'line' | 'block' | 'html'.
   * @param {string}  opts.contextBefore    - Código anterior al cursor (truncado).
   * @param {boolean} opts.hasCodeAfter     - Si hay código tras el cursor.
   * @param {string}  opts.lookaheadLines   - Primeras líneas tras el cursor.
   * @param {string}  opts.languageId       - ID de lenguaje normalizado.
   * @returns {string} Prompt final.
   * @private
   */
  _buildPrompt_(opts) {
    const {
      isCommentTrigger, commentText, commentType,
      contextBefore, hasCodeAfter, lookaheadLines, languageId,
    } = opts;

    const languageLabel = {
      javascript:           'JavaScript',
      typescript:           'TypeScript',
      html:                 'HTML',
      json:                 'JSON',
      jsonc:                'JSON with Comments',
      'google apps script': 'Google Apps Script',
    }[languageId] || languageId;

    if (isCommentTrigger) {
      const commentPrefix =
        commentType === 'block' ? '/*' :
        commentType === 'html'  ? '<!--' : '//';

      return (
`You are an expert ${languageLabel} developer.
The developer typed a comment and needs the implementation.

CONTEXT BEFORE:
${contextBefore}

COMMENT TO IMPLEMENT:
${commentPrefix} ${commentText}

CONTEXT AFTER (Lookahead):
${hasCodeAfter ? lookaheadLines : '(None)'}

TASK:
Generate the code that follows the comment.
- Return ONLY the code.
- Match the indentation of the context.
- Do NOT repeat the comment itself.`
      );
    }

    return (
`Complete the following ${languageLabel} code.
- Return ONLY the missing part to complete the current line or logic.
- Do NOT include markdown fences or explanations.

CODE TO COMPLETE:
${contextBefore}`
    );
  }

  // ── Lectura de configuración ─────────────────────────────────────────────

  /**
   * Lee la configuración del LLM desde el panel de chat en el DOM.
   * @returns {object|null} Configuración del LLM o null si falta información.
   * @private
   */
  _readChatConfig_() {
    const panel = document.querySelector('gas-chat-panel');
    if (!panel?._config) {
      console.warn('[AIAutocomplete] <gas-chat-panel> no encontrado o sin _config.');
      return null;
    }

    const cfg      = panel._config;
    const provider = cfg.provider || 'gemini';
    const model    = cfg.model    || '';
    const apiKey   = cfg.apiKeys?.[provider] || '';

    if (!apiKey) {
      console.warn(`[AIAutocomplete] Sin API key para "${provider}".`);
      return null;
    }

    const provSettings = (cfg.providerSettings || {})[provider] || {};
    const temperature  = provSettings.temperature ?? 0.2;
    const baseSystem   = provSettings.systemPrompt
      || 'You are an expert Google Apps Script developer.';

    const systemPrompt =
`${baseSystem}
You are completing code inline. Rules:
- Return ONLY the code completion, nothing else.
- No markdown, no backticks, no explanations.
- Complete the current line or add the next logical lines (max 6 lines).
- Respect the existing indentation exactly.
- If nothing useful can be suggested, return an empty string.`;

    return { provider, model, apiKey, systemPrompt, temperature };
  }

  // ── Bridge con timeout ───────────────────────────────────────────────────

  /**
   * Envía la solicitud al LLM a través del bridge de eventos del DOM.
   * Incluye timeout propio para no depender solo del AbortSignal externo.
   *
   * @param {object}      opts           - Opciones de la petición.
   * @param {string}      opts.requestId  - ID único de la petición.
   * @param {string}      opts.provider   - Proveedor LLM (gemini, openai…).
   * @param {string}      opts.apiKey     - API key del proveedor.
   * @param {string}      opts.model      - ID del modelo.
   * @param {Array}       opts.messages   - Historial { role, content }.
   * @param {number}      opts.temperature - Temperatura de generación.
   * @param {AbortSignal} opts.signal     - Señal de cancelación.
   * @returns {Promise<string>} Texto generado por el LLM.
   * @private
   */
  _bridgeRequest_(opts) {
    const { requestId, signal, ...payload } = opts;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('LLM bridge timeout'));
      }, GasAiAutocomplete.BRIDGE_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeoutId);
        document.removeEventListener('GAS_LLM_RESPONSE', onResponse);
        signal.removeEventListener('abort', onAbort);
      };

      const onResponse = (e) => {
        let data;
        try { data = JSON.parse(e.detail); } catch (_) { return; }
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
        detail: JSON.stringify({ requestId, ...payload }),
      }));
    });
  }
}

// ── Export ───────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasAiAutocomplete };
} else {
  window.GasAiAutocomplete = GasAiAutocomplete;
}