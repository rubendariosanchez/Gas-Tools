"use strict";
/**
 * @fileoverview gas-ai-autocomplete.js
 *
 * Completado inline (ghost text) vía Monaco. La petición al LLM se realiza
 * con debounce real entre llamadas para evitar peticiones innecesarias.
 * Cancelación activa mediante AbortController por cada petición.
 *
 * Mejoras aplicadas:
 * - El prompt de código incluye lookahead para sugerencias coherentes.
 * - Prompts de comentario diferenciados según tipo y contexto embebido.
 * - System prompt dinámico según lenguaje activo.
 * - Contexto alrededor del cursor (líneas previas) para mejor inferencia.
 * - Corrección del mensaje de retorno en prompts de comentario vacío.
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
   * Solo aplica a triggers automáticos (triggerKind === 1).
   * 800 ms es un punto razonable para "el usuario paró de escribir":
   * suficiente para ráfagas de tecleo y suficientemente corto para
   * sentirse responsivo cuando se hace una pausa intencional.
   */
  static DEBOUNCE_MS = 800;

  /**
   * Mínimo de caracteres nuevos en el prefijo de la línea actual desde la
   * última petición real. Si el usuario solo añadió 1-2 letras dentro de
   * una palabra, NO disparamos otra petición — esperamos a que cruce un
   * límite de palabra (espacio, salto, signo de puntuación) o que añada
   * un fragmento sustancial.
   */
  static MIN_NEW_CHARS = 3;

  /**
   * Líneas del lookahead enviadas al LLM para contexto posterior al cursor.
   * Ayuda a generar sugerencias coherentes con el código que sigue.
   */
  static MAX_LOOKAHEAD_LINES = 8;

  /**
   * Líneas de contexto previas al bloque de comentario que se incluyen
   * en el prompt para dar al LLM información semántica adicional.
   */
  static COMMENT_CONTEXT_LINES = 6;

  /** IDs de lenguaje de Monaco que este proveedor soporta. */
  static SUPPORTED_LANGUAGES = new Set([
    'javascript',
    'typescript',
    'google apps script',
    'css',
    'html',
    'xml',
    'handlebars',
    'json',
    'jsonc',
  ]);

  // ── Constructor ──────────────────────────────────────────────────────────

  /**
   * Crea una nueva instancia del autocompletado AI inline.
   * @param {object} editor               - Instancia activa de Monaco Editor.
   * @param {object} [options]            - Opciones de configuración opcionales.
   * @param {number} [options.debounceMs] - Sobreescribe DEBOUNCE_MS si se indica.
   */
  constructor(editor, options = {}) {
    this._editor  = editor;
    this._enabled = false;

    this._disposables         = [];
    this._providersRegistered = false;
    this._keyboardCommandBound = false;
    /** @type {boolean} @private */
    this._acceptListenerBound = false;

    /**
     * Timer del debounce. Solo uno vive a la vez; cada nueva tecla lo reinicia.
     * Cuando vence, ejecuta `_pendingRequest_` si aún existe.
     * @type {number|null}
     * @private
     */
    this._debounceTimer = null;

    /**
     * Milisegundos de espera del debounce. Configurable por instancia.
     * @type {number}
     * @private
     */
    this._debounceMs = options.debounceMs ?? GasAiAutocomplete.DEBOUNCE_MS;

    /**
     * Función que ejecuta la petición LLM pendiente tras vencer el debounce.
     * Se sobreescribe con cada llamada al provider; la antigua se descarta.
     * @type {Function|null}
     * @private
     */
    this._pendingRequest = null;

    /**
     * Resolver de la promesa devuelta por `_scheduleRequest_` para la petición
     * actualmente en espera. Cuando llega una petición más nueva, este resolver
     * se invoca con `null` para que la promesa antigua no quede colgada.
     * @type {Function|null}
     * @private
     */
    this._pendingResolve = null;

    /**
     * AbortController de la petición LLM actualmente en vuelo.
     * Se cancela si llega una nueva petición antes de que la anterior resuelva.
     * @type {AbortController|null}
     * @private
     */
    this._pendingAbort = null;

    /**
     * Marca de tiempo de la última sugerencia aceptada (ms).
     * Suprime el re-trigger inmediato que Monaco dispara tras insertar texto.
     * @type {number}
     * @private
     */
    this._lastAcceptedAt = 0;

    /**
     * Texto de la última sugerencia mostrada al usuario. Se usa para
     * distinguir entre una keystroke normal (que NO debe activar el cooldown)
     * y una aceptación real (insertar exactamente el texto sugerido).
     * @type {string}
     * @private
     */
    this._lastSuggestion = '';

    /**
     * Snapshot del prefijo de la línea actual + lineNumber + offset, en el
     * momento en que se lanzó la última petición real al LLM. Se usa para
     * decidir si la siguiente keystroke ha cambiado lo suficiente como para
     * justificar una nueva petición. Sin esto, escribir letra por letra
     * dispara una petición por cada letra una vez vencido el debounce.
     * @type {{ uri:string, lineNumber:number, prefix:string }|null}
     * @private
     */
    this._lastFiredContext = null;

    /**
     * Contador incremental de peticiones al LLM. Solo para logs y diagnóstico.
     * @type {number}
     * @private
     */
    this._requestCount = 0;
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
      this._editor.addCommand(
        window.monaco.KeyMod.CtrlCmd |
        window.monaco.KeyMod.Shift   |
        window.monaco.KeyCode.Space,
        () => this._editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {})
      );
      console.log('[AIAutocomplete] Atajo Ctrl+Shift+Espacio registrado');
    }

    // Detecta cuando el usuario acepta una sugerencia inline para suprimir
    // el re-trigger inmediato que Monaco lanza justo después de insertar.
    // Solo consideramos "aceptación" cuando el cambio inserta exactamente el
    // texto que estaba mostrándose como sugerencia; cualquier otro cambio
    // (keystroke normal, paste, edición) no debe activar el cooldown.
    if (!this._acceptListenerBound) {
      this._acceptListenerBound = true;
      this._editor.onDidChangeModelContent((ev) => {
        if (!this._lastSuggestion) return;
        const inserted = ev?.changes?.some(c => c.text === this._lastSuggestion);
        if (inserted) {
          this._lastAcceptedAt   = Date.now();
          this._lastSuggestion   = '';
          // Tras una aceptación el contexto cambia drásticamente; reset.
          this._lastFiredContext = null;
        }
      });

      // Reseteamos el contexto al cambiar de modelo (archivo). Sin esto, el
      // guard de cambio menor podría saltar peticiones legítimas en el
      // archivo nuevo si la línea actual coincide en número con la anterior.
      if (this._editor.onDidChangeModel) {
        this._editor.onDidChangeModel(() => {
          this._lastFiredContext = null;
        });
      }
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
   * @returns {{ items: Array, dispose: Function }}
   * @private
   */
  _empty_() {
    return { items: [], dispose() {} };
  }

  /**
   * Programa la ejecución de una función tras el debounce.
   *
   * Cada llamada cancela el timer anterior y cancela la petición LLM en vuelo,
   * garantizando que solo la última keystroke dispara la petición al LLM.
   * Retorna una Promise que resuelve con el resultado de `fn` cuando el timer
   * vence, o con `null` si fue cancelada por una llamada más reciente.
   *
   * @param {Function} fn - Función async a ejecutar tras el debounce.
   * @returns {Promise<*>} Resultado de `fn`, o `null` si fue descartada.
   * @private
   */
  _scheduleRequest_(fn) {
    // Cancelar timer y resolver la promesa anterior (si aún hay una colgada),
    // para que Monaco no acumule completados pendientes mientras el usuario teclea.
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._pendingResolve) {
      this._pendingResolve(null);
      this._pendingResolve = null;
    }
    this._cancelLlmRequest_('debounce-reset');

    // Sin debounce: ejecutar de inmediato
    if (this._debounceMs <= 0) return fn();

    return new Promise(resolve => {
      // Guardar la función pendiente y su resolver. Si llega otra llamada
      // antes de que el timer venza, esta referencia se sobreescribe y la
      // promesa anterior resuelve con null en la rama de cancelación.
      this._pendingRequest = fn;
      this._pendingResolve = resolve;

      this._debounceTimer = setTimeout(async () => {
        this._debounceTimer = null;

        // Solo ejecutar si esta sigue siendo la petición más reciente
        if (this._pendingRequest !== fn) {
          resolve(null);
          return;
        }
        this._pendingRequest = null;
        this._pendingResolve = null;
        try {
          resolve(await fn());
        } catch (err) {
          resolve(null);
        }
      }, this._debounceMs);
    });
  }

  /**
   * Cancela únicamente la petición LLM en vuelo (AbortController).
   * No toca el debounce timer — para eso está `_cancelPending_`.
   * @param {string} [reason=''] - Motivo del cancelado (solo para logs).
   * @private
   */
  _cancelLlmRequest_(reason = '') {
    if (this._pendingAbort) {
      this._pendingAbort.abort();
      this._pendingAbort = null;
      if (reason) console.log(`[AIAutocomplete] LLM request cancelado (${reason})`);
    }
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

    // Cooldown post-aceptación: Monaco re-dispara el provider inmediatamente
    // después de insertar el texto aceptado. Ignoramos esa llamada fantasma
    // si ocurrió dentro de los últimos 600 ms desde la última aceptación.
    if (context?.triggerKind === 1 && Date.now() - this._lastAcceptedAt < 600) {
      return empty;
    }

    // Triggers automáticos (el usuario escribe): aplicar debounce externo.
    // Capturamos la posición FRESCA dentro del callback del debounce, no aquí,
    // porque entre "ahora" y "cuando vence el debounce" el usuario puede haber
    // tecleado más caracteres y la posición original quedaría obsoleta.
    if (context?.triggerKind === 1) {
      const result = await this._scheduleRequest_(() => {
        const freshPosition = this._editor?.getPosition?.() || position;
        const freshModel    = this._editor?.getModel?.() || model;
        return this._doRequest_(freshModel, freshPosition, token);
      });
      // null significa que esta llamada fue descartada por una más reciente
      return result ?? empty;
    }

    // Trigger explícito: cancelar cualquier petición anterior y disparar ya
    this._cancelLlmRequest_('explicit-trigger');
    return this._doRequest_(model, position, token);
  }

  /**
   * Ejecuta la lógica real de completado inline: valida contexto, construye
   * el prompt y consulta al LLM. Separado de `_provideInline_` para que el
   * debounce pueda envolverlo limpiamente sin repetir código.
   *
   * @param {object} model    - Modelo del editor Monaco.
   * @param {object} position - Posición del cursor { lineNumber, column }.
   * @param {object} token    - Token de cancelación de Monaco.
   * @returns {Promise<object>} Sugerencias inline para Monaco.
   * @private
   */
  async _doRequest_(model, position, token) {
    const empty = this._empty_();
    if (!this._enabled) return empty;
    if (token?.isCancellationRequested) return empty;

    // ── Resolución de lenguaje ─────────────────────────────────────────────
    const rawLangId  = String(model.getLanguageId() || '').toLowerCase();
    const baseLangId = this._normalizeLanguageId_(rawLangId);

    const offset   = model.getOffsetAt(position);
    const fullText = model.getValue();
    const rawBefore = fullText.slice(0, offset);
    const rawAfter  = fullText.slice(offset);

    // Detecta si el cursor está dentro de <script> o <style>
    const embedded   = this._detectEmbeddedHtmlLanguage_(rawBefore, rawAfter, baseLangId);
    const languageId = embedded.languageId;

    // ── Detección de comentario ────────────────────────────────────────────
    const commentInfo      = this._detectComment_(rawBefore, languageId);
    const isCommentTrigger = !!commentInfo;
    const commentText      = isCommentTrigger ? commentInfo.text : '';

    // Líneas anteriores al comentario (o al cursor) para contexto semántico
    const nearbyContext = this._extractNearbyContext_(rawBefore, isCommentTrigger);

    const lineText         = model.getLineContent(position.lineNumber);
    const charBeforeCursor = position.column >= 2 ? lineText.charAt(position.column - 2) : '';

    if (!this._shouldOfferAtPosition_(languageId, position.column, charBeforeCursor, isCommentTrigger)) {
      return empty;
    }

    // Separar la línea actual en prefijo (hasta el cursor) y sufijo (resto).
    // Esto permite al LLM saber exactamente qué ya escribió el usuario en esa
    // línea y evitar que la sugerencia repita el texto ya presente.
    const currentLinePrefix = lineText.slice(0, position.column - 1);
    const currentLineSuffix = lineText.slice(position.column - 1);

    // Guard: en código (no comentario) y sin contexto previo significativo,
    // exigir un mínimo de prefijo para evitar peticiones espúreas con
    // un solo carácter o solo espacios en blanco.
    const linesBeforeCurrent = rawBefore.split('\n').slice(0, -1).join('\n');
    if (
      !isCommentTrigger &&
      currentLinePrefix.trim().length < 2 &&
      linesBeforeCurrent.trim().length === 0
    ) {
      return empty;
    }

    // Guard: si desde la última petición real solo se añadieron pocos chars
    // dentro de la misma palabra, no disparamos otra. Espera a un límite
    // (espacio, puntuación, salto) o a un cambio sustancial.
    if (this._shouldSkipForMinorChange_(model, position, currentLinePrefix, isCommentTrigger)) {
      return empty;
    }

    // Lookahead: resto de línea actual + líneas siguientes
    const allAfter       = currentLineSuffix + (rawAfter.startsWith('\n') ? rawAfter : (currentLineSuffix ? '' : rawAfter));
    const lookaheadLines = rawAfter
      .split('\n')
      .slice(0, GasAiAutocomplete.MAX_LOOKAHEAD_LINES)
      .join('\n');
    const hasCodeAfter = lookaheadLines.trim().length > 0;

    // Leer configuración del panel de chat
    const config = this._readChatConfig_(languageId);
    if (!config) return empty;

    const userPrompt = this._buildPrompt_({
      isCommentTrigger,
      commentText,
      commentType:       commentInfo?.type || 'line',
      commentPrefix:     commentInfo?.prefix || '//',
      contextBefore:     linesBeforeCurrent.length > GasAiAutocomplete.MAX_CONTEXT_CHARS
        ? '...\n' + linesBeforeCurrent.slice(-GasAiAutocomplete.MAX_CONTEXT_CHARS)
        : linesBeforeCurrent,
      currentLinePrefix,
      currentLineSuffix,
      nearbyContext,
      hasCodeAfter,
      lookaheadLines,
      languageId,
      embeddedContext:   embedded.context,
    });

    // ── Preparar petición ──────────────────────────────────────────────────
    // Cancelar petición LLM anterior si aún estaba en vuelo
    this._cancelLlmRequest_('new-request');

    const abortCtrl    = new AbortController();
    this._pendingAbort = abortCtrl;

    let cancelReg = null;
    if (typeof token?.onCancellationRequested === 'function') {
      cancelReg = token.onCancellationRequested(() => abortCtrl.abort());
    }

    const reqNum   = ++this._requestCount;
    const reqStart = performance.now();

    // Registramos el contexto de esta petición ANTES de despacharla. Si el
    // usuario teclea unos pocos chars más mientras esperamos, el guard
    // _shouldSkipForMinorChange_ podrá descartar la siguiente petición.
    this._lastFiredContext = {
      uri:        String(model?.uri?.toString?.() || ''),
      lineNumber: position.lineNumber,
      prefix:     currentLinePrefix,
    };

    try {
      const requestId = `ai-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      this._logRequest_(reqNum, {
        languageId,
        isCommentTrigger,
        embeddedContext: embedded.context,
        systemPrompt:    config.systemPrompt,
        userPrompt,
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
        temperature:  config.temperature,
        endpointUrl:  config.endpointUrl,
        signal:       abortCtrl.signal,
        languageId,
        isCommentTrigger,
      });

      if (!this._enabled) return empty;

      const elapsed = Math.round(performance.now() - reqStart);
      let text = (completion || '').trim();

      if (!text) {
        this._logResult_(reqNum, elapsed, null);
        return empty;
      }

      text = this._sanitizeCompletionText_(text, isCommentTrigger);

      // Defensa anti-repetición: aunque el prompt lo prohíbe, los modelos a
      // veces incluyen el prefijo o el sufijo de la línea actual. Lo recortamos
      // para no insertar contenido duplicado en el editor.
      text = this._stripLineOverlap_(text, currentLinePrefix, currentLineSuffix);

      // Red de seguridad para comentarios: si el modelo devolvió código en
      // lugar de texto natural, descartamos la sugerencia. Inserta basura.
      if (isCommentTrigger && this._looksLikeCode_(text)) {
        console.warn('[AIAutocomplete] Sugerencia descartada: contiene código en un comentario.');
        this._logResult_(reqNum, elapsed, null);
        return empty;
      }

      if (!text) {
        this._logResult_(reqNum, elapsed, null);
        return empty;
      }

      this._logResult_(reqNum, elapsed, text);

      // Guardamos la sugerencia para que el listener de aceptación pueda
      // distinguirla de cualquier otro cambio de contenido.
      this._lastSuggestion = text;

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
      const elapsed = Math.round(performance.now() - reqStart);
      this._logError_(reqNum, elapsed, err);
      return empty;
    } finally {
      cancelReg?.dispose?.();
      if (this._pendingAbort === abortCtrl) this._pendingAbort = null;
    }
  }

  // ── Utilidades internas ──────────────────────────────────────────────────

  /**
   * Limpia el texto de completado eliminando fences Markdown, comillas
   * exteriores y marcadores de comentario duplicados.
   *
   * @param {string}  text             - Texto recibido del LLM.
   * @param {boolean} isCommentTrigger - Si la sugerencia es para un comentario.
   * @returns {string} Texto limpio listo para insertar.
   * @private
   */
  _sanitizeCompletionText_(text, isCommentTrigger = false) {
    // Elimina fences Markdown (```lang ... ```)
    let sanitized = text.replace(/^```[a-zA-Z0-9-]*\n?|\n?```$/g, '').trim();

    // Quita comillas exteriores simples o dobles
    if (
      (sanitized.startsWith('"') && sanitized.endsWith('"')) ||
      (sanitized.startsWith("'") && sanitized.endsWith("'"))
    ) {
      sanitized = sanitized.slice(1, -1).trim();
    }

    // Limpia triple-comilla (""" o ''')
    sanitized = sanitized.replace(/^"""|"""$/g, '').replace(/^'''|'''$/g, '').trim();

    // Para comentarios: el LLM a veces repite el marcador (// , /* , <!--)
    // aunque se le pidió texto puro; se elimina si aparece al inicio.
    // También recortamos el cierre del bloque (*/, -->) si lo añade.
    if (isCommentTrigger) {
      sanitized = sanitized.replace(/^(\/\/\s*|\/\*\s*|<!--\s*)/, '').trim();
      sanitized = sanitized.replace(/\s*(\*\/|-->)\s*$/, '').trim();
    }

    return sanitized;
  }

  /**
   * Detecta si una sugerencia para comentario contiene código en lugar de
   * texto natural. Sirve como red de seguridad cuando el modelo ignora la
   * instrucción del prompt y devuelve CSS, HTML o JS dentro del comentario.
   *
   * Heurística simple: si el texto contiene patrones típicos de código
   * (llaves de bloque, selectores CSS, etiquetas HTML, declaraciones JS),
   * lo consideramos no apto para insertar.
   *
   * @param {string} text - Texto sugerido.
   * @returns {boolean} true si el texto parece código.
   * @private
   */
  _looksLikeCode_(text) {
    if (!text) return false;
    // Marcadores fuertes: llaves de bloque, etiquetas HTML, selectores CSS,
    // declaraciones de función, asignaciones con punto y coma, etc.
    const codePatterns = [
      /[{}]/,                       // llaves
      /<\/?[a-z][\w-]*[^>]*>/i,     // etiquetas HTML
      /^\s*[.#@][\w-]+\s*[,{]/m,    // selectores CSS
      /;\s*$/m,                     // sentencia con ; al final de línea
      /\b(function|const|let|var|return|if|for|while|class)\b/,
    ];
    return codePatterns.some(rx => rx.test(text));
  }

  /**
   * Recorta del texto sugerido cualquier solapamiento con el prefijo o sufijo
   * de la línea actual. Esto evita que la sugerencia repita lo que el usuario
   * ya escribió ANTES del cursor o lo que hay DESPUÉS, lo cual produciría
   * inserciones duplicadas en el editor.
   *
   * Estrategia:
   *  - Prefijo: si `text` empieza con `prefix` (después de trim del prefix),
   *    o si comparte un sufijo no trivial con el prefix, recortamos.
   *  - Sufijo: si `text` termina con `suffix` (después de trim del suffix),
   *    recortamos esa cola.
   *
   * @param {string} text   - Texto sugerido por el LLM.
   * @param {string} prefix - Texto de la línea actual antes del cursor.
   * @param {string} suffix - Texto de la línea actual después del cursor.
   * @returns {string} Texto recortado.
   * @private
   */
  _stripLineOverlap_(text, prefix, suffix) {
    if (!text) return text;

    // ── PREFIX: caso directo ─────────────────────────────────────────────
    const trimmedPrefix = prefix.trimStart();
    if (trimmedPrefix && text.startsWith(trimmedPrefix)) {
      text = text.slice(trimmedPrefix.length);
    } else if (prefix && text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }

    // ── PREFIX: solapamiento parcial al inicio ───────────────────────────
    // Caso típico: prefix = "function fo" y text = "oo() { }". Buscamos el
    // mayor sufijo de prefix que sea prefijo de text (mínimo 3 chars para
    // evitar falsos positivos con caracteres comunes).
    if (prefix && text) {
      const max = Math.min(prefix.length, text.length, 60);
      for (let n = max; n >= 3; n--) {
        if (prefix.endsWith(text.slice(0, n))) {
          text = text.slice(n);
          break;
        }
      }
    }

    // ── SUFFIX: si la sugerencia termina exactamente con el sufijo ──────
    if (suffix && text.endsWith(suffix)) {
      text = text.slice(0, text.length - suffix.length);
    }

    return text;
  }

  // ── Logging ─────────────────────────────────────────────────────────────

  /**
   * Abre un console.group colapsado con los datos de la petición saliente.
   * El grupo queda abierto; `_logResult_` o `_logError_` lo cierran.
   *
   * @param {number} num  - Número de petición.
   * @param {object} opts - Datos a mostrar.
   * @private
   */
  _logRequest_(num, opts) {
    const { languageId, isCommentTrigger, embeddedContext, systemPrompt, userPrompt } = opts;
    const kind = isCommentTrigger ? '💬 comment' : '⌨️  code';
    const lang = embeddedContext && embeddedContext !== 'root'
      ? `${languageId} (in <${embeddedContext}>)`
      : languageId;

    console.groupCollapsed(
      `%c[AIAutocomplete] %c#${num} %c${kind}  %c${lang}`,
      'color:#6366f1; font-weight:bold',
      'color:#f59e0b; font-weight:bold',
      'color:#10b981',
      'color:#94a3b8',
    );
    console.log('%cSystem prompt', 'color:#94a3b8; font-style:italic', systemPrompt);
    console.log('%cUser prompt',   'color:#94a3b8; font-style:italic', userPrompt);
    // El grupo se cierra en _logResult_ o _logError_
  }

  /**
   * Registra el resultado exitoso y cierra el grupo del log.
   * @param {number}      num     - Número de petición.
   * @param {number}      elapsed - Milisegundos transcurridos.
   * @param {string|null} text    - Texto sugerido, o null si vino vacío.
   * @private
   */
  _logResult_(num, elapsed, text) {
    if (text) {
      console.log('%cSugerencia', 'color:#10b981; font-weight:bold', JSON.stringify(text));
    } else {
      console.log('%cSin sugerencia', 'color:#94a3b8');
    }
    console.log(`%c⏱ ${elapsed} ms`, 'color:#94a3b8');
    console.groupEnd();
  }

  /**
   * Registra un error y cierra el grupo del log.
   * @param {number} num     - Número de petición.
   * @param {number} elapsed - Milisegundos transcurridos.
   * @param {Error}  err     - Error capturado.
   * @private
   */
  _logError_(num, elapsed, err) {
    console.warn('%c✖ Error', 'color:#ef4444; font-weight:bold', err?.message || err);
    console.log(`%c⏱ ${elapsed} ms`, 'color:#94a3b8');
    console.groupEnd();
  }

  /**
   * Cancela todo: el timer de debounce, la función pendiente y la petición LLM
   * en vuelo. Se usa en `disable()` para limpiar completamente el estado.
   * @param {string} [reason=''] - Motivo del cancelado (solo para logs).
   * @private
   */
  _cancelPending_(reason = '') {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._pendingResolve) {
      this._pendingResolve(null);
      this._pendingResolve = null;
    }
    this._pendingRequest = null;
    this._cancelLlmRequest_(reason);
  }

  /**
   * Normaliza el ID de lenguaje de Monaco a uno soportado.
   * @param {string} rawId - ID de lenguaje original.
   * @returns {string} ID normalizado.
   * @private
   */
  _normalizeLanguageId_(rawId) {
    if (rawId === 'xml' || rawId === 'handlebars') return 'html';
    if (rawId === 'js' || rawId === 'javascript' || rawId === 'typescript') return 'google apps script';
    return rawId;
  }

  /**
   * Detecta si el cursor está dentro de un bloque HTML `<script>` o `<style>`
   * para ajustar el lenguaje y los prompts de comentario correctamente.
   *
   * @param {string} rawBefore  - Texto anterior al cursor.
   * @param {string} rawAfter   - Texto posterior al cursor.
   * @param {string} baseLangId - ID de lenguaje normalizado.
   * @returns {{ languageId: string, context: string }}
   * @private
   */
  _detectEmbeddedHtmlLanguage_(rawBefore, rawAfter, baseLangId) {
    if (baseLangId !== 'html' && baseLangId !== 'xml') {
      return { languageId: baseLangId, context: 'root' };
    }

    const lower = rawBefore.toLowerCase();

    const lastScriptOpen  = lower.lastIndexOf('<script');
    const lastScriptClose = lower.lastIndexOf('</script>');
    if (lastScriptOpen !== -1 && lastScriptOpen > lastScriptClose) {
      return { languageId: 'javascript', context: 'script' };
    }

    const lastStyleOpen  = lower.lastIndexOf('<style');
    const lastStyleClose = lower.lastIndexOf('</style>');
    if (lastStyleOpen !== -1 && lastStyleOpen > lastStyleClose) {
      return { languageId: 'css', context: 'style' };
    }

    return { languageId: baseLangId, context: 'html' };
  }

  /**
   * Detecta si el texto anterior al cursor termina en un comentario abierto.
   * Soporta //, /* ... *\/ y <!-- ... --> según el lenguaje.
   *
   * @param {string} rawBefore  - Texto hasta el cursor.
   * @param {string} languageId - ID de lenguaje normalizado.
   * @returns {{ type: string, text: string, prefix: string }|null}
   * @private
   */
  _detectComment_(rawBefore, languageId) {
    const lines       = rawBefore.split('\n');
    const currentLine = lines[lines.length - 1] || '';

    // Comentario de línea: // texto
    const lineMatch = currentLine.match(/\/\/\s*(.*)$/);
    if (lineMatch) return { type: 'line', text: lineMatch[1].trim(), prefix: '//' };

    // Comentario de bloque: /* … (sin cerrar)
    const blockStart = rawBefore.lastIndexOf('/*');
    const blockEnd   = rawBefore.lastIndexOf('*/');
    if (blockStart !== -1 && blockStart > blockEnd) {
      const blockText = rawBefore.slice(blockStart + 2).replace(/(^|\n)\s*\* ?/g, '$1');
      return { type: 'block', text: blockText.trim(), prefix: '/*' };
    }

    // Comentario HTML: <!-- … (sin cerrar)
    if (languageId === 'html' || languageId === 'xml') {
      const htmlStart = rawBefore.lastIndexOf('<!--');
      const htmlEnd   = rawBefore.lastIndexOf('-->');
      if (htmlStart !== -1 && htmlStart > htmlEnd) {
        const htmlText = rawBefore.slice(htmlStart + 4);
        return { type: 'html', text: htmlText.trim(), prefix: '<!--' };
      }
    }

    return null;
  }

  /**
   * Extrae las últimas N líneas de contexto previas al cursor (o al bloque
   * de comentario) para proporcionar información semántica al LLM.
   *
   * @param {string}  rawBefore        - Texto hasta el cursor.
   * @param {boolean} isCommentTrigger - Si se está completando un comentario.
   * @returns {string} Líneas de contexto cercano.
   * @private
   */
  _extractNearbyContext_(rawBefore, isCommentTrigger) {
    const lines  = rawBefore.split('\n');
    const count  = GasAiAutocomplete.COMMENT_CONTEXT_LINES;
    // Para comentarios, buscamos las líneas no-comentario inmediatamente previas
    if (isCommentTrigger) {
      const nonComment = lines
        .slice(0, -1)                  // excluir la línea del comentario
        .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .slice(-count);
      return nonComment.join('\n');
    }
    return lines.slice(-count).join('\n');
  }

  /**
   * Determina si se debe ofrecer autocompletado en la posición actual.
   *
   * @param {string}  languageId       - ID de lenguaje normalizado.
   * @param {number}  column           - Columna del cursor.
   * @param {string}  ch               - Carácter justo antes del cursor.
   * @param {boolean} isCommentTrigger - Si se está dentro de un comentario.
   * @returns {boolean}
   * @private
   */
  _shouldOfferAtPosition_(languageId, column, ch, isCommentTrigger = false) {
    if (column < 1) return false;

    // Al inicio de línea solo sugerimos dentro de comentarios o lenguajes de marcado
    if (column === 1) {
      return isCommentTrigger || ['html', 'json', 'jsonc', 'xml'].includes(languageId);
    }

    if (ch === '\n' || ch === '\r') return false;

    if (languageId === 'json' || languageId === 'jsonc') {
      return /[\s\w."'\-:,/\[\]{}]/.test(ch);
    }

    if (languageId === 'html' || languageId === 'xml') {
      return /[\s\w.<>=/"'`*\-:!?#_@$%&;,()\[\]{}]/.test(ch);
    }

    return /[\s\w."'`.,;:!?()\[\]{}<>+*/%&|^~=@#$\\]/.test(ch) || ch === '-';
  }

  /**
   * Decide si la petición actual debe descartarse por ser un cambio menor
   * respecto a la última petición real que enviamos al LLM.
   *
   * Reglas (todas deben cumplirse para SALTAR la petición):
   *  - Estamos en el mismo archivo y misma línea que la última petición.
   *  - El nuevo prefijo es una extensión del anterior (no un retroceso ni
   *    una edición intermedia).
   *  - Los caracteres añadidos son menos de MIN_NEW_CHARS.
   *  - Ninguno de los caracteres añadidos es un límite (espacio, salto,
   *    puntuación, llaves, etc.). Cruzar un límite SIEMPRE pide nueva
   *    petición porque el contexto semántico cambió.
   *
   * @param {object}  model            - Modelo Monaco activo.
   * @param {object}  position         - Posición del cursor.
   * @param {string}  currentPrefix    - Prefijo actual de la línea.
   * @param {boolean} isCommentTrigger - Si estamos completando un comentario.
   * @returns {boolean} true si debemos saltar esta petición.
   * @private
   */
  _shouldSkipForMinorChange_(model, position, currentPrefix, isCommentTrigger) {
    const last = this._lastFiredContext;
    if (!last) return false;

    const sameUri  = last.uri === String(model?.uri?.toString?.() || '');
    const sameLine = last.lineNumber === position.lineNumber;
    if (!sameUri || !sameLine) return false;

    // El usuario no está extendiendo el prefijo (movió el cursor, borró, etc.)
    if (!currentPrefix.startsWith(last.prefix)) return false;

    const added = currentPrefix.slice(last.prefix.length);
    if (!added) return false;

    // Si los nuevos caracteres incluyen un límite semántico, sí pedimos
    // nueva sugerencia. Así "Este es " (espacio) o "foo." (punto) sí
    // disparan, pero "Este e" → "Este es" no.
    const BOUNDARY = isCommentTrigger
      ? /[\s.,;:!?\n\r]/
      : /[\s.,;:!?(){}\[\]<>=+\-*/%&|^~@#$\\\n\r]/;
    if (BOUNDARY.test(added)) return false;

    // Cambio menor dentro de la misma palabra: saltamos.
    return added.length < GasAiAutocomplete.MIN_NEW_CHARS;
  }

  // ── Construcción de prompt ───────────────────────────────────────────────

  /**
   * Construye el prompt de usuario para el LLM con secciones claramente
   * etiquetadas: código previo, línea actual y lookahead.
   *
   * Los prompts están en inglés para maximizar la calidad de inferencia del
   * modelo. Los comentarios sugeridos para insertar siguen siendo en español.
   *
   * @param {object}  opts                    - Parámetros del contexto actual.
   * @param {boolean} opts.isCommentTrigger   - Si el trigger fue un comentario.
   * @param {string}  opts.commentText        - Texto ya escrito del comentario.
   * @param {string}  opts.commentType        - 'line' | 'block' | 'html'.
   * @param {string}  opts.commentPrefix      - Marcador: '//', '/*', '<!--'.
   * @param {string}  opts.contextBefore      - Líneas previas a la línea actual.
   * @param {string}  opts.currentLinePrefix  - Texto en la línea actual hasta el cursor.
   * @param {string}  opts.currentLineSuffix  - Texto en la línea actual desde el cursor.
   * @param {string}  opts.nearbyContext      - Líneas de código cercanas al comentario.
   * @param {boolean} opts.hasCodeAfter       - Si hay código tras el cursor.
   * @param {string}  opts.lookaheadLines     - Primeras líneas tras el cursor.
   * @param {string}  opts.languageId         - ID de lenguaje normalizado.
   * @param {string}  opts.embeddedContext    - 'script' | 'style' | 'html' | 'root'.
   * @returns {string} Prompt final.
   * @private
   */
  _buildPrompt_(opts) {
    const {
      isCommentTrigger, commentText, commentType, commentPrefix,
      contextBefore, currentLinePrefix, currentLineSuffix,
      nearbyContext, hasCodeAfter, lookaheadLines, languageId, embeddedContext,
    } = opts;

    // Etiqueta legible del lenguaje
    const languageLabel = {
      javascript:           'JavaScript',
      typescript:           'TypeScript',
      css:                  'CSS',
      html:                 'HTML',
      json:                 'JSON',
      jsonc:                'JSON with comments',
      'google apps script': 'Google Apps Script',
    }[languageId] || languageId;

    // Instrucción adicional cuando el cursor está dentro de <script> o <style>
    const embeddedHint =
      embeddedContext === 'script'
        ? `The cursor is inside an HTML <script> tag. Complete only ${languageLabel} script content.`
      : embeddedContext === 'style'
        ? 'The cursor is inside an HTML <style> tag. Complete only CSS content.'
        : '';

    // ── Prompt para comentarios ────────────────────────────────────────────
    // Para comentarios NO incluimos "CODE AFTER CURSOR": el modelo tiende a
    // replicarlo en la sugerencia y termina insertando código completo en
    // lugar del texto del comentario. El contexto adyacente (líneas previas
    // no-comentario) ya da suficiente pista semántica.
    if (isCommentTrigger) {
      // Hint de estilo SÓLO para comentarios JSDoc reales (JS/TS/GAS).
      // En CSS y HTML no existen JSDoc; mencionarlo confunde al modelo.
      const isJsLike = languageId === 'javascript'
                    || languageId === 'typescript'
                    || languageId === 'google apps script';

      const commentStyleHint =
        commentType === 'block' && isJsLike
          ? 'This is a JSDoc-style block comment (/** ... */). Suggest a short, useful description in Spanish. May span multiple lines.'
        : commentType === 'block'
          ? `This is a multi-line ${languageLabel} comment. Suggest a short, descriptive text in Spanish.`
        : commentType === 'html'
          ? 'This is an HTML comment (<!-- ... -->). Suggest a short descriptive text in Spanish.'
          : 'This is a single-line comment. Suggest a short, useful description in Spanish.';

      // Contexto de código próximo al comentario (líneas no-comentario)
      const adjacentCode = nearbyContext.trim()
        ? `=== ADJACENT CODE (for semantic context) ===\n${nearbyContext}\n===`
        : '';

      // Bloque de contexto reducido para comentarios: NO incluimos lookahead.
      const commentContextBlock = [
        '=== CODE BEFORE THE COMMENT ===',
        contextBefore || '(empty)',
        '=== CURRENT LINE (cursor at end of PREFIX) ===',
        `PREFIX: ${currentLinePrefix || '(empty)'}`,
        '===',
      ].join('\n');

      if (!commentText) {
        // El usuario solo escribió el marcador (// , /* , <!--) sin texto aún
        return (
`You are completing a ${languageLabel} comment. The user opened a comment marker but has not typed any text yet.
${embeddedHint}
${commentStyleHint}

${adjacentCode}

${commentContextBlock}

Task: suggest the comment TEXT (in Spanish) that best describes the adjacent code or context.
Rules:
- Output ONLY natural-language text in Spanish that fits inside a comment.
- DO NOT output any code (no CSS rules, no HTML tags, no JS statements, no selectors, no braces).
- DO NOT include the comment markers ${commentPrefix} or */.
- DO NOT include backticks, quotes, or any explanation.
- If nothing useful can be inferred, return an empty string.`
        );
      }

      // El usuario escribió texto parcial del comentario
      return (
`You are completing a ${languageLabel} comment. The user has started typing the comment text.
${embeddedHint}
${commentStyleHint}

${adjacentCode}

${commentContextBlock}

Comment so far: "${commentPrefix} ${commentText}"

Task: continue the comment TEXT (in Spanish). Return ONLY the missing characters that come right after "${commentText}".
Rules:
- Output ONLY natural-language text in Spanish.
- DO NOT output any code (no CSS rules, no HTML tags, no JS statements, no selectors, no braces).
- DO NOT repeat "${commentPrefix}" or any part of "${commentText}".
- DO NOT include the closing marker (*/, -->) or backticks.
- If the comment is already complete, return an empty string.`
      );
    }

    // Bloque de contexto estructurado para CÓDIGO — separar "antes",
    // "línea actual" y "después" evita que el LLM repita el texto ya escrito.
    const contextBlock = [
      '=== CODE BEFORE CURRENT LINE ===',
      contextBefore || '(empty)',
      '=== CURRENT LINE (cursor at end of PREFIX) ===',
      `PREFIX: ${currentLinePrefix || '(empty)'}`,
      `SUFFIX: ${currentLineSuffix || '(empty)'}`,
      '=== CODE AFTER CURSOR ===',
      hasCodeAfter ? lookaheadLines : '(none)',
      '===',
    ].join('\n');

    // ── Prompt para código ─────────────────────────────────────────────────
    return (
`You are an inline code completion engine for ${languageLabel}.
${embeddedHint}

${contextBlock}

Task: produce ONLY the code that should be inserted at the cursor position (after PREFIX, before SUFFIX on the current line).
Rules:
- Do NOT repeat any part of PREFIX or SUFFIX — your output is inserted literally between them.
- Do NOT include backticks, markdown, explanations, or comments unless they are part of the natural completion.
- Match the surrounding code style and indentation.
- If the code is already complete or nothing meaningful can be added, return an empty string.`
    );
  }

    // ── Lectura de configuración ─────────────────────────────────────────────

  /**
   * Lee la configuración del LLM desde el panel de chat en el DOM.
   * El system prompt se adapta al lenguaje activo para mejorar la relevancia
   * de las sugerencias.
   *
   * @param {string} [languageId='google apps script'] - Lenguaje activo en el editor.
   * @returns {object|null} Configuración del LLM o null si falta información.
   * @private
   */
  _readChatConfig_(languageId = 'google apps script') {
    const panel = document.querySelector('gas-chat-panel');
    if (!panel?._config) {
      console.warn('[AIAutocomplete] <gas-chat-panel> no encontrado o sin _config.');
      return null;
    }

    const cfg      = panel._config;
    const provider = cfg.provider || 'gemini';
    const model    = cfg.model    || '';
    const apiKey   = cfg.apiKeys?.[provider] || '';

    if (!apiKey && provider !== 'custom') {
      console.warn(`[AIAutocomplete] Sin API key para "${provider}".`);
      return null;
    }

    const provSettings = (cfg.providerSettings || {})[provider] || {};
    // Para autocompletado conviene una temperatura baja (sugerencias más
    // deterministas). Si el usuario configuró una temperatura específica para
    // el chat la respetamos, pero la limitamos a 0.3 como techo.
    const temperature  = Math.min(provSettings.temperature ?? 0.2, 0.3);
    const endpointUrl  = provSettings.endpointUrl || '';

    // System prompt: el autocomplete SIEMPRE usa su propio default por lenguaje.
    // El system prompt configurado en el panel de chat está orientado a
    // conversación (puede ser muy específico de GAS) y confunde al modelo
    // cuando se está completando código en otro lenguaje (CSS, HTML, etc.).
    const baseSystem = this._defaultSystemPrompt_(languageId);

    // Instrucciones de formato estrictas, independientes del base
    const systemPrompt =
`${baseSystem}
Strict output rules:
- Return ONLY the requested text (code or comment text), nothing else.
- No Markdown fences, no backticks, no wrapping quotes.
- No preamble, no explanation, no apology.
- If there is nothing useful to suggest, return an empty string.`;

    return { provider, model, apiKey, systemPrompt, temperature, endpointUrl };
  }

  /**
   * Devuelve un system prompt base ajustado al lenguaje activo en el editor.
   * Esto ayuda al LLM a generar sugerencias más precisas y contextuales.
   *
   * @param {string} languageId - ID de lenguaje normalizado.
   * @returns {string} System prompt base.
   * @private
   */
  _defaultSystemPrompt_(languageId) {
    const prompts = {
      'google apps script':
        'You are an expert Google Apps Script and JavaScript ES6+ developer. ' +
        'You know the Google Workspace API deeply (Sheets, Docs, Drive, Gmail, etc.) ' +
        'and the best practices of the GAS execution environment.',
      css:
        'You are an expert in modern CSS (Flexbox, Grid, custom properties, animations). ' +
        'You produce clean, efficient code compatible with major browsers.',
      html:
        'You are an expert in semantic and accessible HTML5. ' +
        'You produce clean markup following W3C standards and accessibility best practices.',
      json:
        'You are an expert in JSON structures. ' +
        'You complete objects and arrays strictly following valid JSON syntax.',
    };
    return prompts[languageId] || 'You are an expert software developer.';
  }

  // ── Bridge con timeout ───────────────────────────────────────────────────

  /**
   * Envía la solicitud al LLM a través del bridge de eventos del DOM.
   * Incluye timeout propio para no depender solo del AbortSignal externo.
   *
   * @param {object}      opts              - Opciones de la petición.
   * @param {string}      opts.requestId    - ID único de la petición.
   * @param {string}      opts.provider     - Proveedor LLM (gemini, openai…).
   * @param {string}      opts.apiKey       - API key del proveedor.
   * @param {string}      opts.model        - ID del modelo.
   * @param {Array}       opts.messages     - Historial { role, content }.
   * @param {number}      opts.temperature  - Temperatura de generación.
   * @param {string}      opts.endpointUrl  - URL del endpoint (para custom).
   * @param {AbortSignal} opts.signal       - Señal de cancelación.
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