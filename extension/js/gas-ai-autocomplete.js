"use strict";
/**
 * @fileoverview gas-ai-autocomplete.js
 *
 * Proveedor de autocompletado con IA para Monaco Editor en Google Apps Script IDE.
 *
 * Estrategia de renderizado:
 *  - Usa monaco.languages.registerInlineCompletionsProvider — la misma API que
 *    GitHub Copilot. El texto sugerido aparece inline en gris (ghost text nativo).
 *  - Tab acepta la sugerencia; Escape la descarta (comportamiento nativo de Monaco).
 *  - El fetch al LLM va por el bridge GAS_LLM_REQUEST → mainFunctions → background.
 *
 * Integración en GasCustomEditor:
 *   this._aiAutocomplete = new GasAiAutocomplete(this.editor);
 *   this._aiAutocomplete.enable();
 *   // En disable() y _teardownInjectedUi_():
 *   this._aiAutocomplete?.disable();
 *   this._aiAutocomplete = null;
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CONTEXT_CHARS = 1500;
const MIN_TRIGGER_CHARS = 60;
const LOOKAHEAD_LINES   = 8;

// ─────────────────────────────────────────────────────────────────────────────
// CLASE PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
class GasAiAutocomplete {
  /**
   * @param {object} editor - Instancia activa de Monaco Editor.
   */
  constructor(editor) {
    this._editor = editor;
    console.log("[AIAutocomplete] editor", editor);

    /** @type {boolean} */
    this._enabled = false;

    /** @type {Array} Disposables de Monaco para limpiar en disable() */
    this._disposables = [];

    /** @type {AbortController|null} */
    this._abortController = null;
  }

  // ──────────────────────────────────────────
  // CICLO DE VIDA
  // ──────────────────────────────────────────

  enable() {
    console.log("[AIAutocomplete] this._editor", this._editor);
    if (this._enabled || !this._editor) return;
    this._enabled = true;

    // Verificar que la API esté disponible en esta build de Monaco
    if (typeof window.monaco?.languages?.registerInlineCompletionsProvider !== 'function') {
      console.warn('[AIAutocomplete] registerInlineCompletionsProvider no disponible en esta build de Monaco.');
      return;
    }

    // Registrar para los lenguajes usados en GAS
    const languages = ['javascript', 'typescript', 'google apps script', 'html', 'json'];
    languages.forEach(lang => {
      try {
        const disposable = window.monaco.languages.registerInlineCompletionsProvider(lang, {
          /**
           * Monaco llama a este método cuando el usuario pausa al escribir.
           * Retornar una Promise es válido — Monaco la espera.
           *
           * @param {object} model
           * @param {object} position
           * @param {object} context
           * @param {CancellationToken} token
           * @returns {Promise<InlineCompletions>}
           */
          provideInlineCompletions: (model, position, context, token) => {
            return this._provideInline_(model, position, context, token);
          },

          /**
           * Llamado por Monaco cuando descarta una sugerencia.
           * Necesario para liberar recursos.
           */
          freeInlineCompletions(completions) {
            completions?.dispose?.();
          },
        });
        this._disposables.push(disposable);
      } catch (e) {
        console.warn('[AIAutocomplete] Error registrando inline provider para', lang, e.message);
      }
    });

    // Atajo manual: Ctrl+Shift+Space → forzar trigger de inline completions
    if (this._editor.addCommand && window.monaco?.KeyMod) {
      this._editor.addCommand(
        window.monaco.KeyMod.CtrlCmd |
        window.monaco.KeyMod.Shift   |
        window.monaco.KeyCode.Space,
        () => {
          // Trigger de inline suggestions (acción interna de Monaco)
          this._editor.trigger('keyboard', 'editor.action.inlineSuggest.trigger', {});
        }
      );
    }

    console.log('[AIAutocomplete] Habilitado (inline completions provider).');
  }

  /**
   * Desactiva el proveedor y limpia todos los recursos.
   */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._cancelPendingRequest_();
    this._disposables.forEach(d => d?.dispose?.());
    this._disposables = [];
    console.log('[AIAutocomplete] Deshabilitado.');
  }

  // ──────────────────────────────────────────
  // INLINE COMPLETIONS PROVIDER
  // ──────────────────────────────────────────

  /**
   * Implementación de provideInlineCompletions.
   * Retorna un objeto { items, dispose } con el ghost text a mostrar.
   *
   * @param {object} model
   * @param {object} position
   * @param {object} context
   * @param {object} token - CancellationToken de Monaco
   * @returns {Promise<{ items: Array, dispose: Function }>}
   */
  async _provideInline_(model, position, context, token) {
    if (!this._enabled) return { items: [], dispose() {} };

    // ── Detectar modo comentario ─────────────────────────────────
    const currentLine      = model.getLineContent(position.lineNumber);
    const textBeforeCursor = currentLine.slice(0, position.column - 1);

    // Validar que sea un comentario dependiendo del lenguaje
    const languageId = model.getLanguageId();
    const isJsComment = /\/\/\s*.{2,}$/.test(textBeforeCursor);
    const isHtmlComment = /<!--\s*.{2,}$/.test(textBeforeCursor);
    const isCommentTrigger = languageId === 'html' ? isHtmlComment : isJsComment;

    // ── Contexto antes del cursor ────────────────────────────────
    const fullText  = model.getValue();
    const offset    = model.getOffsetAt(position);
    const rawBefore = fullText.slice(0, offset);

    // No disparar si no hay suficiente contexto (comentarios lo saltean)
    if (!isCommentTrigger && rawBefore.length < MIN_TRIGGER_CHARS) {
      return { items: [], dispose() {} };
    }

    // Helper para construir la respuesta inline en el formato que Monaco espera
    const buildResult = (completion) => {
      // Validamos que la completion no esté vacía
      if (!completion || completion.trim() === '') {
        return { items: [], dispose() {} };
      }

      // Rango donde se insertará el texto: desde la posición actual del cursor
      const range = new window.monaco.Range(
        position.lineNumber, position.column,
        position.lineNumber, position.column
      );

      return {
        items: [{
          insertText: completion,
          // range indica dónde se "reemplaza" — al ser punto a punto, solo inserta
          range,
          // completeBracketPairs: false evita que Monaco añada paréntesis extra
          completeBracketPairs: false,
        }],
        // dispose es requerido por la interfaz InlineCompletions
        dispose() {},
      };
    };

    // ── Config del LLM ───────────────────────────────────────────
    const config = this._readChatConfig_();
    if (!config) {
      console.warn('[AIAutocomplete] Sin config — mostrando fallback');
      return buildResult();
    }

    // ── Lookahead para comentarios ───────────────────────────────
    let lookaheadLines = '';
    if (isCommentTrigger) {
      const totalLines = model.getLineCount();
      const limit      = Math.min(position.lineNumber + LOOKAHEAD_LINES, totalLines);
      const lines      = [];
      for (let i = position.lineNumber + 1; i <= limit; i++) {
        const line = model.getLineContent(i).trimEnd();
        if (lines.length > 0 &&
            /^(function |class |async function |\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\()/.test(line)) {
          break;
        }
        lines.push(line);
      }
      lookaheadLines = lines.join('\n');
    }

    // Calcular el contexto antes del cursor
    const contextBefore = rawBefore.length > MAX_CONTEXT_CHARS
      ? '...\n' + rawBefore.slice(-MAX_CONTEXT_CHARS)
      : rawBefore;
    const hasCodeAfter  = lookaheadLines.trim().length > 0;
    const commentText = isCommentTrigger
      ? (
          languageId === 'html'
            ? textBeforeCursor.replace(/^.*<!--\s*/, '').trim()
            : textBeforeCursor.replace(/^.*\/\/\s*/, '').trim()
        )
      : '';

    // ── Construir prompt ─────────────────────────────────────────
    const { provider, model: modelId, apiKey, systemPrompt, temperature } = config;

    // Construimos el prompt
    const userPrompt = this._buildPrompt_({
      isCommentTrigger, commentText, contextBefore, hasCodeAfter, lookaheadLines, languageId,
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ];

    // ── Llamar al LLM vía bridge ─────────────────────────────────
    let raw = '';
    try {
      this._cancelPendingRequest_();
      this._abortController = new AbortController();

      // Respetar el CancellationToken de Monaco: si cancela, abortamos
      token?.onCancellationRequested?.(() => {
        this._abortController?.abort();
      });

      const requestId = `ai-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      raw = await this._bridgeRequest_({
        requestId, provider, apiKey,
        model: modelId, messages, temperature,
        signal: this._abortController.signal,
      });

    } catch (err) {
      if (err?.name !== 'AbortError' && err?.message !== 'aborted') {
        console.warn('[AIAutocomplete] Error LLM — usando fallback:', err.message);
        return buildResult();
      }
      // AbortError (Monaco canceló o el usuario siguió escribiendo): silencioso
      return { items: [], dispose() {} };
    }

    // LLM respondió vacío: fallback
    if (!raw?.trim()) {
      console.warn('[AIAutocomplete] Respuesta vacía — usando fallback');
      return buildResult();
    }

    // ── Post-proceso ─────────────────────────────────────────────
    let completion = raw.trim();

    if (isCommentTrigger && hasCodeAfter) {
      // CASE A: completar texto del comentario — quitar "//" si el LLM los añadió
      const firstLine     = completion.split('\n')[0];
      const looksLikeCode = /^[\s]*(const|let|var|if|for|while|return|function|class|async\s+function|\w+\s*[=({\[])/.test(firstLine);
      if (!looksLikeCode) {
        completion = completion.replace(/^\/\/+\s*/, '');
      }
    }
    // CASE B y modo código: sin cambios

    console.log('[AIAutocomplete] Sugerencia inline lista:', completion.slice(0, 60));
    return buildResult(completion);
  }

  // ──────────────────────────────────────────
  // CONSTRUCCIÓN DE PROMPT
  // ──────────────────────────────────────────

  _buildPrompt_(opts) {
    const { isCommentTrigger, commentText, contextBefore, hasCodeAfter, lookaheadLines, languageId } = opts;

    // Detectar si es HTML, JavaScript o TypeScript
    const languageLabel = {
      javascript: 'JavaScript',
      typescript: 'TypeScript',
      html: 'HTML',
      json: 'JSON',
    }[languageId] || languageId;

    if (isCommentTrigger) {
      return (
`You are completing ${languageLabel} code.

The developer typed this comment (cursor is at the end of it):
// ${commentText}

Code BEFORE the comment:
\`\`\`javascript
${contextBefore}
\`\`\`

Code AFTER the comment line (the lines that follow in the file):
\`\`\`javascript
${hasCodeAfter ? lookaheadLines : '(none — comment is at the end or before empty lines)'}
\`\`\`

${hasCodeAfter
  ? `TASK (CASE A): Code already exists after the comment. Complete the comment text to describe it accurately.
Return ONLY the words that complete the comment. Do NOT include "//". Do NOT repeat text already typed.
Example: developer typed "// get all", next line is sheet.getDataRange().getValues() → return: "rows from the active sheet"`
  : `TASK (CASE B): No code after the comment. Generate the implementation for what the comment describes.
Return ONLY the code lines with correct indentation. Sub-comments inside the code may use //.
Do NOT repeat the comment line itself.`}

Absolute rules:
- No markdown fences.
- No explanations or preamble.
- Max 6 lines.
- Respect the existing indentation exactly.`
      );
    }

    return (
`Complete the following ${languageLabel} code. Return only the completion (no markdown, no explanations, max 6 lines):

${contextBefore}`
    );
  }

  // ──────────────────────────────────────────
  // LECTURA DE CONFIGURACIÓN
  // ──────────────────────────────────────────

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
    const baseSystem   = provSettings.systemPrompt || 'You are an expert Google Apps Script developer.';
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

  // ──────────────────────────────────────────
  // BRIDGE (MAIN → content script → background)
  // ──────────────────────────────────────────

  _bridgeRequest_(opts) {
    const { requestId, signal, ...payload } = opts;

    return new Promise((resolve, reject) => {
      const onResponse = (e) => {
        let data;
        try { data = JSON.parse(e.detail); } catch (_) { return; }
        if (data.requestId !== requestId) return;

        document.removeEventListener('GAS_LLM_RESPONSE', onResponse);
        signal.removeEventListener('abort', onAbort);

        if (data.ok) resolve(data.content || '');
        else reject(new Error(data.error || 'LLM error'));
      };

      const onAbort = () => {
        document.removeEventListener('GAS_LLM_RESPONSE', onResponse);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };

      document.addEventListener('GAS_LLM_RESPONSE', onResponse);
      signal.addEventListener('abort', onAbort, { once: true });

      document.dispatchEvent(new CustomEvent('GAS_LLM_REQUEST', {
        detail: JSON.stringify({ requestId, ...payload }),
      }));
    });
  }

  // ──────────────────────────────────────────
  // UTILIDADES
  // ──────────────────────────────────────────

  _cancelPendingRequest_() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTAR
// ─────────────────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GasAiAutocomplete };
} else {
  window.GasAiAutocomplete = GasAiAutocomplete;
}