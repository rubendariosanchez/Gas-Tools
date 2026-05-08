"use strict";
/**
 * @fileoverview gas-ai-autocomplete.js
 *
 * Proveedor de autocompletado con IA para Monaco Editor en Google Apps Script IDE.
 *
 * Características:
 *  - Lee la configuración (provider, model, apiKey, systemPrompt, temperature) directamente
 *    desde el componente <gas-chat-panel> para no duplicar estado.
 *  - Trigger automático: al escribir comentarios (//) o al final de una línea con contexto
 *    suficiente (mínimo 3 líneas o 60 caracteres).
 *  - Trigger manual: Ctrl+Shift+Space muestra sugerencias inline.
 *  - Las sugerencias se muestran como "ghost text" inline (decoraciones Monaco).
 *  - Tab acepta la sugerencia; Escape la descarta.
 *  - Debounce de 900ms para no disparar en cada tecla.
 *  - Una sola petición en vuelo a la vez (cancela la anterior si llega una nueva).
 *
 * Integración en GasCustomEditor:
 *   // En init(), después de reloadSnippets():
 *   this._aiAutocomplete = new GasAiAutocomplete(this.editor);
 *   this._aiAutocomplete.enable();
 *
 *   // En disable():
 *   this._aiAutocomplete?.disable();
 *
 *   // En _teardownInjectedUi_():
 *   this._aiAutocomplete?.disable();
 *   this._aiAutocomplete = null;
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

/** Máximo de caracteres de contexto enviados al LLM (evitar tokens excesivos) */
const MAX_CONTEXT_CHARS = 1500;  // reducir de 3000
const MAX_BEFORE_CHARS = 600;    // nuevo límite para "antes" en comentarios
const LOOKAHEAD_LINES = 6;       // líneas después del comentario (≈800 chars)

/** Mínimo de caracteres antes del cursor para disparar autocompletado automático */
const MIN_TRIGGER_CHARS = 60;

/** Debounce en ms antes de enviar la petición */
const DEBOUNCE_MS = 900;

/** Máximo de tokens en la respuesta del LLM */
const MAX_COMPLETION_TOKENS = 200;

/** CSS class para las decoraciones de ghost text */
const GHOST_DECORATION_CLASS = 'gas-ai-ghost-text';

// ─────────────────────────────────────────────────────────────────────────────
// CLASE PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

class GasAiAutocomplete {
  /**
   * @param {object} editor - Instancia activa de Monaco Editor.
   */
  constructor(editor) {
    this._editor = editor;

    /** @type {string[]} IDs de decoraciones de ghost text activas */
    this._decorationIds = [];

    /** @type {string|null} Texto de la sugerencia actualmente mostrada */
    this._pendingSuggestion = null;

    /** @type {number|null} Timer del debounce */
    this._debounceTimer = null;

    /** @type {AbortController|null} Controlador para cancelar fetch en vuelo */
    this._abortController = null;

    /** @type {boolean} Si el proveedor está activo */
    this._enabled = false;

    /** @type {Array} Disposables de Monaco para limpiar en disable() */
    this._disposables = [];

    // Binds para poder remover listeners
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onContentChange = this._onContentChange.bind(this);
    this._onCursorChange = this._onCursorChange.bind(this);
  }

  // ──────────────────────────────────────────
  // CICLO DE VIDA
  // ──────────────────────────────────────────

  /** Activa el proveedor de autocompletado IA. */
  enable() {
    if (this._enabled || !this._editor) return;
    this._enabled = true;
    this._injectGhostTextStyles_();

    // Escuchar cambios de contenido para trigger automático
    this._disposables.push(
      this._editor.onDidChangeModelContent(() => this._onContentChange())
    );

    // Escuchar cambios de cursor para limpiar sugerencia si el usuario se movió
    this._disposables.push(
      this._editor.onDidChangeCursorPosition(() => this._onCursorChange())
    );

    // Escuchar teclado para Tab (aceptar) y Escape (rechazar)
    this._disposables.push(
      this._editor.onKeyDown((e) => this._onKeyDown(e))
    );

    // Atajo manual: Ctrl+Shift+Space
    if (this._editor.addCommand && window.monaco?.KeyMod) {
      this._editor.addCommand(
        window.monaco.KeyMod.CtrlCmd |
        window.monaco.KeyMod.Shift  |
        window.monaco.KeyCode.Space,
        () => this._triggerManual_()
      );
    }

    console.log('[AIAutocomplete] Habilitado.');
  }

  /** Desactiva el proveedor y limpia todos los recursos. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;

    this._clearSuggestion_();
    this._cancelPendingRequest_();

    this._disposables.forEach(d => d?.dispose?.());
    this._disposables = [];

    console.log('[AIAutocomplete] Deshabilitado.');
  }

  // ──────────────────────────────────────────
  // LECTURA DE CONFIGURACIÓN
  // ──────────────────────────────────────────

  /**
   * Lee la configuración activa desde el componente <gas-chat-panel>.
   * Devuelve null si el panel no existe o no tiene API key configurada.
   *
   * @returns {{ provider, model, apiKey, systemPrompt, temperature }|null}
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
      console.warn(`[AIAutocomplete] Sin API key para "${provider}". Configúrala en el chat.`);
      return null;
    }

    // Leer settings del proveedor activo
    const provSettings = (cfg.providerSettings || {})[provider] || {};
    const temperature  = provSettings.temperature ?? 0.2;

    // System prompt especializado para completado de código (más conciso que el del chat)
    const baseSystemPrompt = provSettings.systemPrompt ||
      'You are an expert Google Apps Script developer.';

    const systemPrompt = `${baseSystemPrompt}

You are completing code inline. Rules:
- Return ONLY the code completion, nothing else.
- No markdown, no backticks, no explanations.
- Complete the current line or add the next logical lines (max 5 lines).
- Respect the existing indentation exactly.
- If nothing useful can be suggested, return an empty string.`;

    return { provider, model, apiKey, systemPrompt, temperature };
  }

  // ──────────────────────────────────────────
  // TRIGGERS
  // ──────────────────────────────────────────

  /** Trigger automático con debounce al cambiar contenido. */
  _onContentChange() {
    if (!this._enabled) return;

    // Limpiar sugerencia anterior mientras el usuario sigue escribiendo
    this._clearSuggestion_();
    this._cancelPendingRequest_();

    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      if (this._shouldTrigger_()) {
        this._requestCompletion_();
      }
    }, DEBOUNCE_MS);
  }

  /** Limpia la sugerencia si el cursor se mueve a una posición diferente. */
  _onCursorChange() {
    if (this._pendingSuggestion) {
      this._clearSuggestion_();
    }
  }

  /** Trigger manual inmediato sin respetar el mínimo de caracteres. */
  _triggerManual_() {
    this._clearSuggestion_();
    this._cancelPendingRequest_();
    this._requestCompletion_(true);
  }

  /**
   * Determina si el contexto actual justifica lanzar una petición automática.
   * Criterios:
   *  - La línea actual termina con un comentario //... (intención de explicar código)
   *  - O hay suficiente texto antes del cursor (MIN_TRIGGER_CHARS)
   *  - Y no hay texto después del cursor en la misma línea (no interrumpir edición)
   *
   * @returns {boolean}
   */
  _shouldTrigger_() {
    const model    = this._editor.getModel();
    const position = this._editor.getPosition();
    if (!model || !position) return false;

    const lineContent     = model.getLineContent(position.lineNumber);
    const textAfterCursor = lineContent.slice(position.column - 1).trim();

    // No interrumpir si hay texto a la derecha del cursor
    if (textAfterCursor.length > 0) return false;

    const textBeforeCursor = lineContent.slice(0, position.column - 1);

    // Trigger en comentario: mínimo // + 2 caracteres escritos
    if (/\/\/\s*.{2,}$/.test(textBeforeCursor)) return true;

    // Trigger por volumen de contexto
    const fullContext = this._buildContext_(model, position);
    return fullContext.length >= MIN_TRIGGER_CHARS;
  }

  // ──────────────────────────────────────────
  // CONTEXTO
  // ──────────────────────────────────────────

  /**
   * Construye el fragmento de código enviado al LLM como contexto.
   * Incluye hasta MAX_CONTEXT_CHARS caracteres ANTES del cursor.
   *
   * @param {object} model    - Modelo Monaco activo.
   * @param {object} position - Posición actual del cursor.
   * @returns {string}
   */
  _buildContext_(model, position) {
    const fullText = model.getValue();
    const offset   = model.getOffsetAt(position);

    // Texto antes del cursor (contexto base)
    const contextBefore = fullText.slice(0, offset);

    // Detectar si la línea actual es un comentario de línea
    const currentLine      = model.getLineContent(position.lineNumber);
    const textBeforeCursor = currentLine.slice(0, position.column - 1);
    const isCommentLine    = /\/\//.test(textBeforeCursor);

    // Si estamos en un comentario, añadir hasta 5 líneas siguientes como contexto
    // para que el LLM sepa qué está siendo comentado
    let contextAfter = '';
    if (isCommentLine) {
        const totalLines  = model.getLineCount();
        const lookahead   = Math.min(position.lineNumber + 5, totalLines);
        const afterLines  = [];
        for (let i = position.lineNumber + 1; i <= lookahead; i++) {
            afterLines.push(model.getLineContent(i));
        }
        if (afterLines.length) {
            contextAfter = '\n// [following code for context]:\n' + afterLines.join('\n');
        }
    }

    const raw = contextBefore + contextAfter;

    return raw.length > MAX_CONTEXT_CHARS
        ? '...\n' + raw.slice(-MAX_CONTEXT_CHARS)
        : raw;
  }

  // ──────────────────────────────────────────
  // PETICIÓN AL LLM
  // ──────────────────────────────────────────

  // ──────────────────────────────────────────
// PETICIÓN AL LLM  (vía bridge GAS_LLM_REQUEST)
// ──────────────────────────────────────────

/**
 * Envía el contexto al LLM configurado a través del bridge de eventos
 * (GAS_LLM_REQUEST → mainFunctions.js → background → llmProviders.js)
 * para no exponer la API key en el contexto MAIN.
 *
 * @param {boolean} [manual=false]
 */
async _requestCompletion_(manual = false) {
  const config = this._readChatConfig_();
  if (!config) return;

  const model    = this._editor.getModel();
  const position = this._editor.getPosition();
  if (!model || !position) return;

  const context = this._buildContext_(model, position);
  const shouldSkipMinChars = isCommentTrigger || manual;
  if (!shouldSkipMinChars && context.length < MIN_TRIGGER_CHARS) return;

  this._cancelPendingRequest_();
  this._abortController = new AbortController();
  const signal = this._abortController.signal;

  const { provider, model: modelId, apiKey, systemPrompt, temperature } = config;

  // ── Detectar modo comentario ─────────────────────────────────
  const currentLine      = model.getLineContent(position.lineNumber);
  const textBeforeCursor = currentLine.slice(0, position.column - 1);
  const isCommentTrigger = /\/\/\s*.{2,}$/.test(textBeforeCursor);
  const commentText      = isCommentTrigger
    ? textBeforeCursor.replace(/^.*\/\/\s*/, '').trim()
    : '';

  // ── Leer líneas siguientes al cursor (lookahead limpio) ───────
  // Separado del contexto general para usarlas explícitamente en el prompt
  let lookaheadLines = '';
  if (isCommentTrigger) {
    const totalLines = model.getLineCount();
    const limit      = Math.min(position.lineNumber + 8, totalLines);
    const lines      = [];
    for (let i = position.lineNumber + 1; i <= limit; i++) {
      const line = model.getLineContent(i).trimEnd();
      // Parar si encontramos otra función/clase para no salir del scope
      if (/^(function |class |async function |\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\()/.test(line) && lines.length > 0) break;
      lines.push(line);
    }
    lookaheadLines = lines.join('\n');
  }

  // ── Construir el contexto "antes" sin el lookahead ────────────
  // _buildContext_ ya los mezcla, pero para el prompt los queremos separados
  const fullText     = model.getValue();
  const offset       = model.getOffsetAt(position);
  const contextBefore = fullText.slice(0, offset);
  const cleanBefore  = contextBefore.length > MAX_CONTEXT_CHARS
    ? '...\n' + contextBefore.slice(-MAX_CONTEXT_CHARS)
    : contextBefore;

  // ── Prompt según modo ─────────────────────────────────────────
  let userPrompt;

  if (isCommentTrigger) {
    userPrompt =
`You are completing code in a Google Apps Script file.

The developer is writing a comment. Here is what they have typed so far:
  // ${commentText}

Code BEFORE the comment (for context):
\`\`\`javascript
${cleanBefore}
\`\`\`

Code AFTER the comment line (the lines that follow — this is what the comment describes):
\`\`\`javascript
${lookaheadLines || '(empty — no code below yet)'}
\`\`\`

Your task — choose ONE of these two cases:

CASE A — The comment text is incomplete:
  The code after the comment already exists. Read it and complete the comment text to describe it accurately.
  Return ONLY the missing words to finish the comment. Do NOT include "//". Do NOT repeat the text already written.
  Example: if the developer typed "// get all" and the next line is \`sheet.getDataRange().getValues()\`, return: "rows from the active sheet"

CASE B — The comment is complete and there is no code after it (or empty lines only):
  Generate the implementation code for what the comment describes.
  Return ONLY the code lines (with correct indentation). Include // or /** */ if you need sub-comments inside the code.
  Do NOT repeat the comment line itself.

Rules for both cases:
- No markdown fences (\`\`\`).
- No explanations or preamble.
- Max 6 lines.
- Respect the existing indentation.`;

  } else {
    userPrompt =
`Complete the following Google Apps Script code. Return only the completion text (no markdown, no explanations, max 6 lines):

${context}`;
  }

  const requestId = `ai-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const messages  = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt   },
  ];

  try {
    this._showLoadingIndicator_();
    const raw = await this._bridgeRequest_({
      requestId, provider, apiKey,
      model: modelId, messages, temperature, signal,
    });
    this._clearLoadingIndicator_();

    if (!raw?.trim()) return;

    // ── Post-proceso para modo comentario ─────────────────────
    let completion = raw.trim();
    if (isCommentTrigger) {
      const firstLine = completion.split('\n')[0];
      const looksLikeCode = /^[\s]*[a-zA-Z_$][\w$]*\s*[=({\[]/.test(firstLine) ||
                            /^[\s]*(const|let|var|if|for|while|return|function|class)\b/.test(firstLine);

      if (!looksLikeCode) {
        // CASE A: es texto de comentario — asegurarnos de que NO tenga // al inicio
        // (el usuario ya tiene "// texto" en el editor; solo añadimos las palabras finales)
        completion = completion.replace(/^\/\/\s*/, '');
      }
      // CASE B: es código — se inserta tal cual en la línea siguiente (ya tiene su propia indentación)
    }

    this._showSuggestion_(completion);
  } catch (err) {
    this._clearLoadingIndicator_();
    if (err?.name !== 'AbortError' && err?.message !== 'aborted') {
      console.warn('[AIAutocomplete] Error en petición LLM:', err.message);
    }
  }
}

/**
 * Despacha GAS_LLM_REQUEST y espera GAS_LLM_RESPONSE con el mismo requestId.
 * Si la señal se aborta antes de la respuesta, rechaza la Promise.
 *
 * @param {{ requestId, provider, apiKey, model, messages, temperature, signal }} opts
 * @returns {Promise<string>}
 */
_bridgeRequest_(opts) {
  const { requestId, signal, ...payload } = opts;

  return new Promise((resolve, reject) => {
    // Manejador de respuesta: filtra por requestId para ignorar respuestas ajenas
    const onResponse = (e) => {
      let data;
      try { data = JSON.parse(e.detail); } catch (_) { return; }
      if (data.requestId !== requestId) return;

      document.removeEventListener('GAS_LLM_RESPONSE', onResponse);
      signal.removeEventListener('abort', onAbort);

      if (data.ok) {
        resolve(data.content || '');
      } else {
        reject(new Error(data.error || 'LLM error'));
      }
    };

    // Si el AbortController dispara antes de la respuesta, limpiamos y rechazamos
    const onAbort = () => {
      document.removeEventListener('GAS_LLM_RESPONSE', onResponse);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };

    document.addEventListener('GAS_LLM_RESPONSE', onResponse);
    signal.addEventListener('abort', onAbort, { once: true });

    // Disparar la petición al bridge
    document.dispatchEvent(new CustomEvent('GAS_LLM_REQUEST', {
      detail: JSON.stringify({ requestId, ...payload }),
    }));
  });
}

  // ──────────────────────────────────────────
  // GHOST TEXT (sugerencia inline)
  // ──────────────────────────────────────────

  /**
   * Muestra el texto de sugerencia como decoración inline ("ghost text") en Monaco.
   * El texto aparece en la posición actual del cursor con estilo CSS atenuado.
   *
   * @param {string} text - Texto de la sugerencia a mostrar.
   */
  _showSuggestion_(text) {
    if (!this._editor || !text) return;

    const position = this._editor.getPosition();
    if (!position) return;

    // Guardar posición del cursor al momento de mostrar la sugerencia
    this._suggestionPosition = { ...position };
    this._pendingSuggestion  = text;

    // Preparar líneas del ghost text
    const lines    = text.split('\n');
    const firstLine = lines[0];
    const restLines = lines.slice(1);

    // Construcción de decoraciones
    const afterContent = restLines.length
      ? restLines.map(l => ({ content: l || ' ' }))
      : undefined;

    const decorationOptions = {
      description: 'gas-ai-autocomplete',
      after: {
        content:         firstLine || ' ',
        inlineClassName: GHOST_DECORATION_CLASS,
      },
    };

    if (afterContent) {
      decorationOptions.afterLines = afterContent.map(l => ({
        content: l.content,
        inlineClassName: GHOST_DECORATION_CLASS,
      }));
    }

    const range = new window.monaco.Range(
      position.lineNumber, position.column,
      position.lineNumber, position.column
    );

    // Aplicar decoraciones y guardar sus IDs para poder limpiarlas
    const newIds = this._editor.deltaDecorations(this._decorationIds, [
      { range, options: decorationOptions },
    ]);
    this._decorationIds = newIds;

    console.log('[AIAutocomplete] Sugerencia mostrada:', firstLine.slice(0, 40) + '...');
  }

  /** Elimina todas las decoraciones de ghost text del editor. */
  _clearSuggestion_() {
    if (this._decorationIds.length) {
      this._editor?.deltaDecorations(this._decorationIds, []);
      this._decorationIds = [];
    }
    this._pendingSuggestion  = null;
    this._suggestionPosition = null;
  }

  /**
   * Acepta la sugerencia activa: inserta el texto en el editor
   * en la posición donde fue generada.
   */
  _acceptSuggestion_() {
    if (!this._pendingSuggestion || !this._suggestionPosition) return;

    const text     = this._pendingSuggestion;
    const position = this._suggestionPosition;

    this._clearSuggestion_();

    this._editor.executeEdits('gas-ai-autocomplete', [{
      range: new window.monaco.Range(
        position.lineNumber, position.column,
        position.lineNumber, position.column
      ),
      text,
      forceMoveMarkers: true,
    }]);

    // Mover cursor al final del texto insertado
    const lines      = text.split('\n');
    const lastLine   = lines[lines.length - 1];
    const newLineNum = position.lineNumber + lines.length - 1;
    const newCol     = lines.length > 1
      ? lastLine.length + 1
      : position.column + lastLine.length;

    this._editor.setPosition({ lineNumber: newLineNum, column: newCol });
    this._editor.focus();

    console.log('[AIAutocomplete] Sugerencia aceptada.');
  }

  // ──────────────────────────────────────────
  // INDICADOR DE CARGA
  // ──────────────────────────────────────────

  /** Muestra un indicador "..." mientras se espera respuesta del LLM. */
  _showLoadingIndicator_() {
    const position = this._editor?.getPosition();
    if (!position) return;

    const newIds = this._editor.deltaDecorations(this._decorationIds, [{
      range: new window.monaco.Range(
        position.lineNumber, position.column,
        position.lineNumber, position.column
      ),
      options: {
        description: 'gas-ai-loading',
        after: {
          content:         ' ⋯',
          inlineClassName: `${GHOST_DECORATION_CLASS} ${GHOST_DECORATION_CLASS}--loading`,
        },
      },
    }]);
    this._decorationIds = newIds;
  }

  /** Elimina el indicador de carga (llama a _clearSuggestion_ sin tocar _pendingSuggestion). */
  _clearLoadingIndicator_() {
    if (this._decorationIds.length) {
      this._editor?.deltaDecorations(this._decorationIds, []);
      this._decorationIds = [];
    }
  }

  // ──────────────────────────────────────────
  // TECLADO
  // ──────────────────────────────────────────

  /**
   * Intercepta Tab (aceptar) y Escape (descartar) cuando hay una sugerencia activa.
   * @param {IKeyboardEvent} e - Evento de teclado de Monaco.
   */
  _onKeyDown(e) {
    if (!this._pendingSuggestion) return;

    if (e.keyCode === window.monaco?.KeyCode?.Tab) {
      e.preventDefault();
      e.stopPropagation();
      this._acceptSuggestion_();
      return;
    }

    if (e.keyCode === window.monaco?.KeyCode?.Escape) {
      e.preventDefault();
      e.stopPropagation();
      this._clearSuggestion_();
      this._cancelPendingRequest_();
    }
  }

  // ──────────────────────────────────────────
  // UTILIDADES
  // ──────────────────────────────────────────

  /** Cancela cualquier petición fetch en vuelo y limpia el debounce. */
  _cancelPendingRequest_() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;

    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Inyecta los estilos CSS para el ghost text en el documento principal.
   * Se ejecuta una sola vez gracias al ID del elemento <style>.
   */
  _injectGhostTextStyles_() {
    const STYLE_ID = 'gas-ai-autocomplete-styles';
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* Ghost text: sugerencia IA inline en Monaco */
      .${GHOST_DECORATION_CLASS} {
        opacity: 0.38;
        color: #a8c4e0 !important;
        font-style: italic;
        pointer-events: none;
        user-select: none;
      }

      /* Indicador de carga parpadeante */
      .${GHOST_DECORATION_CLASS}--loading {
        animation: gas-ai-blink 1s ease-in-out infinite;
        opacity: 0.5;
      }

      @keyframes gas-ai-blink {
        0%, 100% { opacity: 0.5; }
        50%       { opacity: 0.15; }
      }

      /* Tema claro: ajustar color del ghost text */
      .monaco-editor.vs .${GHOST_DECORATION_CLASS} {
        color: #6b8db5 !important;
      }
    `;
    document.head.appendChild(style);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTAR (compatible con script tag clásico y módulos ES)
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasAiAutocomplete };
} else {
  window.GasAiAutocomplete = GasAiAutocomplete;
}