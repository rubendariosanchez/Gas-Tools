/**
 * @fileoverview <gas-chat-panel> - Panel de chat con LLM para el IDE de GAS.
 *
 * Características:
 *  - Web Component en Shadow DOM (aislado de estilos del IDE).
 *  - Proveedores soportados: OpenAI, Anthropic, Google Gemini, Kimi, ChatLLM.
 *  - Selector de proveedor/modelo siempre visible en el composer.
 *  - Menú @ para insertar contexto del editor (@selection / @file / @project).
 *  - Renderizado de Markdown (GasMarkdown, services/markdown-render.js) con
 *    botones Copy/Insert/Replace en bloques de código.
 *  - Respuestas en streaming con render progresivo (máx. 1 render por frame).
 *  - Estimación de tokens en el composer y confirmación para peticiones grandes.
 *  - Persistencia de API keys y preferencias en chrome.storage.sync (vía bridge).
 *  - Vive en el Side Panel nativo de Chrome (`<gas-chat-panel mode="sidepanel">`):
 *    ocupa todo el viewport y accede al editor solo vía un adaptador asíncrono
 *    (`setEditorAdapter`), nunca a Monaco directamente.
 *
 * Flujo de comunicación (streaming):
 *   panel → CustomEvent('GAS_LLM_STREAM_START') → bridge → background → fetch LLM
 *   background → CustomEvent('GAS_LLM_STREAM_EVENT') {type: delta|done|error} → panel
 *   panel → CustomEvent('GAS_LLM_CANCEL') → background aborta el stream
 *
 * Persistencia (vía bridge, ya que MAIN world no tiene chrome.runtime):
 *   GAS_LLM_GET_CONFIG / GAS_LLM_CONFIG_RESULT / GAS_LLM_SAVE_CONFIG
 */

// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGO DE PROVEEDORES
// ─────────────────────────────────────────────────────────────────────────────
const GAS_LLM_PROVIDERS = {
  gemini: {
    label: 'Gemini',
    icon: '✦',
    color: '#4285f4',
    models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-3.1-pro', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
    keyHint: 'AIza...',
  },
  openai: {
    label: 'OpenAI',
    icon: '◆',
    color: '#10a37f',
    models: ['gpt-4o-mini', 'gpt-4.1', 'gpt-4o', 'o4-mini'],
    keyHint: 'sk-...',
  },
  anthropic: {
    label: 'Anthropic',
    icon: '◈',
    color: '#d97757',
    models: ['claude-haiku-4-5', 'claude-sonnet-4', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
    keyHint: 'sk-ant-...',
  },
  kimi: {
    label: 'Kimi',
    icon: '◎',
    color: '#06b6d4',
    models: ['kimi-k2.5', 'kimi-k2-turbo-preview', 'kimi-k2.6', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'kimi-k1.5'],
    keyHint: 'sk-...',
  },
  chatllm: {
    label: 'ChatLLM',
    icon: '⬟',
    color: '#a855f7',
    models: [
      'llama-3.3-70b-instruct',
      'qwen-2.5-72b-instruct',
      'mixtral-8x7b-instruct',
    ],
    keyHint: 's2_...',
  },
  nvidia: {
    label: 'Nvidia',
    icon: '◉',
    color: '#76b900',
    models: [
      'qwen/qwen3-coder-480b-a35b-instruct',
      'moonshotai/kimi-k2-instruct',
      'moonshotai/kimi-k2.6',
      'mistralai/devstral-2-123b-instruct-2512',
      'minimaxai/minimax-m2.7',
      'nvidia/nemotron-3-super-120b-a12b',
      'google/gemma-4-31b-it',
      'qwen/qwen2.5-coder-32b-instruct',
      'zai-org/glm-5.1',
      'openai/gpt-oss-120b',
    ],
    keyHint: 'nvapi-...',
  },
  openrouter: {
    label: 'OpenRouter',
    icon: '○',
    color: '#656ee8',
    models: [
      // =========================
      // GRATIS (Coding)
      // =========================
      'inclusionai/ring-2.6-1t:free',
      'openai/gpt-oss-120b:free',
      'openrouter/free',
      'minimax/minimax-m2.5:free',
      'poolside/laguna-xs.2:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'google/gemma-4-31b-it:free',
      'qwen/qwen3-coder:free',
      'meta-llama/llama-3.3-70b-instruct:free',

      // =========================
      // PAGO (Top Coding)
      // =========================
      'moonshotai/kimi-k2.6',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.7',
      'google/gemini-3-flash-preview',
      'x-ai/grok-4.1-fast',
    ],
    keyHint: 'sk-or-v1-...',
  },
  custom: {
    get label() { return DomUtils.t('edChatLocalProvider', 'Local Provider'); },
    icon: '⚙',
    color: '#a0aec0',
    models: [],
    get keyHint() { return DomUtils.t('edChatKeyOptional', 'API Key (Optional)'); },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS PUROS (sin DOM): ventana de contexto y detección de archivo completo
// ─────────────────────────────────────────────────────────────────────────────
const GasChatContext = (() => {
  /** Fracción de la ventana de contexto que puede ocupar la petición (el resto queda para la respuesta). */
  const CONTEXT_FILL_RATIO = 0.85;
  /** Mínimo de líneas significativas iguales (vs. el original) para ofrecer "Preview". */
  const PREVIEW_MIN_EQUAL_RATIO = 0.4;
  /** Mínimo de líneas del bloque (vs. el original) para ofrecer "Preview". */
  const PREVIEW_MIN_LENGTH_RATIO = 0.5;
  /** Marcador de los recortes del archivo activo. */
  const TRUNCATED_MARKER = '[…truncated…]';
  /** Mínimo de caracteres del archivo activo que se conservan al recortar. */
  const MIN_ACTIVE_CHARS = 400;

  /** Normaliza saltos de línea y quita los finales. */
  const normalize_ = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const lineCount_ = (s) => { const t = normalize_(s); return t ? t.split('\n').length : 0; };
  /** Línea con contenido real (ignora vacías y llaves/paréntesis sueltos). */
  const isSignificant_ = (line) => String(line).trim().length > 1;

  /**
   * Indica si un bloque de código parece una versión completa del archivo
   * activo: ≥ 40 % de las líneas significativas del original se conservan
   * y el bloque mide al menos el 50 % del original.
   * @param {string} original Contenido actual del archivo.
   * @param {string} proposed Código del bloque.
   * @param {{diffLines:Function}} lineDiff `GasLineDiff`.
   * @returns {boolean}
   */
  const isFullFileCandidate = (original, proposed, lineDiff) => {
    if (!lineDiff || typeof lineDiff.diffLines !== 'function') return false;
    const a = normalize_(original);
    const b = normalize_(proposed);
    const origLines = lineCount_(a);
    const newLines = lineCount_(b);
    if (!origLines || !newLines || newLines < origLines * PREVIEW_MIN_LENGTH_RATIO) return false;
    const significant = a.split('\n').filter(isSignificant_).length;
    if (!significant) return false;
    let equal = 0;
    for (const op of lineDiff.diffLines(a, b)) {
      if (op.type === 'equal' && isSignificant_(op.text)) equal++;
    }
    return equal >= significant * PREVIEW_MIN_EQUAL_RATIO;
  };

  /** Presupuesto de tokens de la petición para una ventana dada (0 = sin límite). */
  const budgetTokens = (contextWindow) => {
    const n = Number(contextWindow);
    return Number.isFinite(n) && n > 0 ? Math.floor(n * CONTEXT_FILL_RATIO) : 0;
  };

  /**
   * Recorta `text` a `maxChars` (cortando por líneas). Con `focus` (texto
   * presente en `text`, p. ej. la selección) la ventana se centra en él; si
   * no, se conserva el principio. Los cortes se marcan con TRUNCATED_MARKER.
   * @param {string} text
   * @param {number} maxChars
   * @param {string} [focus]
   * @returns {string}
   */
  const truncateAround = (text, maxChars, focus = '') => {
    const src = String(text ?? '');
    const max = Math.max(0, Math.floor(maxChars));
    if (src.length <= max) return src;
    const at = focus && focus.trim() ? src.indexOf(focus) : -1;
    let start = 0;
    if (at >= 0) {
      const center = at + Math.floor(Math.min(focus.length, max) / 2);
      start = Math.max(0, Math.min(src.length - max, center - Math.floor(max / 2)));
      if (start > 0) start = src.indexOf('\n', start) + 1 || start; // inicio de línea
    }
    let end = Math.min(src.length, start + max);
    if (end < src.length) {
      const nl = src.lastIndexOf('\n', end);
      if (nl > start) end = nl;
    }
    const head = start > 0 ? `${TRUNCATED_MARKER}\n` : '';
    const tail = end < src.length ? `\n${TRUNCATED_MARKER}` : '';
    return head + src.slice(start, end) + tail;
  };

  /**
   * Compone el system del modo Agent (motor de bloques) a partir de sus partes.
   * @param {{head:string[], listing:string, files:Array<{label:string,text:string,active?:boolean}>, omitted:string[]}} ctx
   * @returns {string}
   */
  const composeAgentSystem = (ctx) => {
    const blocks = (ctx.files || []).map((f) =>
      `[${f.active ? 'Active file' : 'File'}: ${f.label}]\n\`\`\`\n${f.text}\n\`\`\``);
    const parts = ['--- Agent Mode ---', ...(ctx.head || []), `[Project files]\n${ctx.listing || '(no files)'}`, ...blocks];
    if (ctx.omitted && ctx.omitted.length) {
      parts.push(`[Note: ${ctx.omitted.join(', ')} not included (context limit). Do not assume their contents; ask the user before editing them.]`);
    }
    return parts.filter(Boolean).join('\n\n');
  };

  /**
   * Reduce el system del modo Agent hasta `maxChars`, en este orden:
   * 1) quita el contenido de los archivos no activos, 2) compacta la lista
   * de archivos, 3) recorta el archivo activo alrededor de `focus` o desde
   * el principio.
   * @param {object} ctx Partes (ver composeAgentSystem) + `listingCompact` y `focus`.
   * @param {number} maxChars
   * @returns {{system:string, trimmed:boolean, fits:boolean, steps:string[]}}
   */
  const shrinkAgentContext = (ctx, maxChars) => {
    const cur = { ...ctx, files: [...(ctx.files || [])], omitted: [...(ctx.omitted || [])] };
    const steps = [];
    const fits = () => composeAgentSystem(cur).length <= maxChars;
    if (fits()) return { system: composeAgentSystem(cur), trimmed: false, fits: true, steps };

    const others = cur.files.filter((f) => !f.active);
    if (others.length) {
      cur.omitted.push(...others.map((f) => f.label));
      cur.files = cur.files.filter((f) => f.active);
      steps.push('files');
    }
    if (!fits() && ctx.listingCompact && ctx.listingCompact !== cur.listing) {
      cur.listing = ctx.listingCompact;
      steps.push('listing');
    }
    const active = cur.files.find((f) => f.active);
    if (!fits() && active) {
      const overhead = composeAgentSystem({ ...cur, files: cur.files.map((f) => (f === active ? { ...f, text: '' } : f)) }).length;
      const room = Math.max(MIN_ACTIVE_CHARS, maxChars - overhead - TRUNCATED_MARKER.length * 2 - 2);
      cur.files = cur.files.map((f) => (f === active ? { ...f, text: truncateAround(f.text, room, ctx.focus || '') } : f));
      steps.push('active');
    }
    return { system: composeAgentSystem(cur), trimmed: steps.length > 0, fits: fits(), steps };
  };

  return Object.freeze({
    CONTEXT_FILL_RATIO, TRUNCATED_MARKER,
    isFullFileCandidate, budgetTokens, truncateAround, composeAgentSystem, shrinkAgentContext,
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// WEB COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
class GasChatPanel extends HTMLElement {
  /** Tokens estimados a partir de los cuales se pide confirmación antes de enviar. */
  static TOKEN_CONFIRM_THRESHOLD = 30000;

  /**
   * Tamaño máximo (caracteres) del contenido que inserta `@project`
   * (~20k tokens). Se mantiene el tope histórico de 80k para no encarecer
   * las peticiones; lo que no cabe se lista como omitido.
   */
  static PROJECT_MAX_CHARS = 80000;

  /** Heurística simple de estimación: caracteres por token. */
  static CHARS_PER_TOKEN = 4;

  /** Distancia (px) al fondo bajo la cual se mantiene el auto-scroll. */
  static AUTOSCROLL_THRESHOLD_PX = 48;

  /** System prompt por defecto (también lo usa "Reset to default" en settings). */
  static DEFAULT_SYSTEM_PROMPT =
`You are a senior Google Apps Script (GAS) developer with deep expertise in Google Workspace automation.
Write clean, modern ES6+ code following GAS best practices. Prefer native Workspace services (SpreadsheetApp, DriveApp, GmailApp, etc.) over external APIs.
Include error handling, logging and JSDoc on triggers and custom functions.
Respond in the same language the user writes in, with practical, production-ready code examples.`;

  /** Proveedores con tool calling fiable (motor `tools` en modo Agent). */
  static TOOL_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'openrouter']);

  /** Máximo de vueltas modelo → herramientas por turno del motor `tools`. */
  static TOOLS_MAX_ITERATIONS = 8;

  /** Espera (ms) antes de guardar la conversación en el historial. */
  static SAVE_DEBOUNCE_MS = 800;

  /** Página de ajustes donde se habilita la Apps Script API. */
  static APPS_SCRIPT_API_URL = 'https://script.google.com/home/usersettings';

  /** Rol del motor `tools` (tool calling): el modelo inspecciona con herramientas. */
  static TOOLS_AGENT_ROLE =
`You are an expert Google Apps Script engineer working inside the user's project. Use the tools to inspect files before editing. Propose edits with propose_edit and new files with create_file; nothing is applied until the user accepts. Keep explanations short.
Respond in the same language the user writes in.`;

  /** Rol que se añade al system prompt en modo Agent. */
  static AGENT_ROLE =
`You edit Google Apps Script projects directly from this chat. The user reviews every file you change and accepts or rejects it.
- Express code changes ONLY as edit blocks (format below); never paste whole files in normal code fences when editing.
- Keep the prose short: what you changed and why. No edit blocks when the user is only asking a question.
- Only edit files whose full content is provided below. If you need another file, ask the user to mention it by name.
- SEARCH text must be copied verbatim from the current file content (same whitespace), and be just long enough to be unique.`;

  /**
   * Reglas de anclaje e intención: se añaden a ambos motores del modo Agent
   * y al modo Ask cuando se envía contenido de archivos. Evitan que modelos
   * pequeños inventen código genérico ante peticiones de análisis.
   */
  static GROUNDING_RULES =
`Grounding rules:
- Base every statement strictly on the provided project files. Never invent functions, files or APIs that are not in the project unless the user explicitly asks for new code.
- If the user asks for suggestions, a review, an explanation or a question, answer in prose (bullet points referencing real function names/lines) and do NOT produce edit blocks or code.
- Only propose edits (edit blocks / propose_edit) when the user asks to change, fix, add or refactor code.`;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /**
     * Adaptador asíncrono hacia el editor de GAS de la pestaña activa
     * (isAvailable/getStats/getSelection/getFile/getProject/insertAtCursor/replaceSelection).
     * @type {object|null}
     */
    this._editorAdapter = null;

    /** @type {number} Secuencia para descartar estimaciones de tokens obsoletas. */
    this._estimateSeq = 0;

    /** @type {boolean} Indica que se está recolectando contexto antes de enviar. */
    this._isGatheringContext = false;

    /** @type {Array<{role:'user'|'assistant'|'system', content:string}>} Historial de conversación. */
    this._messages = [];

    /** @type {object} Configuración persistida. */
    this._config = {
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      // Solo booleanos: qué proveedores tienen key guardada en el background.
      // Las keys en claro nunca llegan al MAIN world.
      apiKeysSet: {},
      // Configuración por proveedor: { providerId: { temperature, systemPrompt, customModels } }
      providerSettings: {},
    };

    /** @type {string|null} Proveedor cuya key se eliminará al guardar settings. */
    this._apiKeyRemovalFor = null;

    /** @type {boolean} Evita re-renderizar y duplicar listeners en reconexiones. */
    this._initialized = false;

    /** @type {boolean} Indica si hay una petición LLM en curso. */
    this._isStreaming = false;

    /** @type {string|null} ID de la petición en curso. */
    this._currentRequestId = null;

    // Estado del menú de autocompletado con `@`.
    // El elemento DOM se obtiene via `shadowRoot.getElementById('gc__mentionMenu')`
    // cuando se necesita; aquí solo guardamos índice, posición y query.
    this._mentionIndex = -1;
    this._mentionStart = -1;
    this._mentionQuery = '';

    /**
     * Estado del stream en curso (null si no hay ninguno).
     * @type {{requestId:string, text:string, bodyEl:HTMLElement|null, wrapEl:HTMLElement|null, frameId:number}|null}
     */
    this._stream = null;

    /** @type {Array<object>|null} Mensajes pendientes de confirmación (petición grande). */
    this._pendingConfirm = null;

    /** @type {{text:string, replaceFrom:number}|null} Reintento pendiente de confirmación. */
    this._pendingSend = null;

    /** @type {'ctx'|'model'|null} Menú del composer abierto. */
    this._openMenu = null;

    /** @type {string} Proveedor en edición dentro de settings. */
    this._settingsProvider = 'gemini';

    /** @type {string[]} Borrador de modelos personalizados en settings. */
    this._draftCustomModels = [];

    /** @type {boolean|null} Último resultado conocido de `isAvailable()` (null = desconocido). */
    this._editorAvailable = null;

    /** @type {number} Secuencia para ids estables de mensajes (tarjetas de cambios). */
    this._msgSeq = 0;

    /**
     * Revisión abierta en el editor: mensaje y archivos (por índice) enviados
     * a `previewChanges`, para mapear los eventos `previewAccept/Reject`.
     * @type {{msgId:number, names:string[]}|null}
     */
    this._previewSet = null;

    /**
     * Servicios del host (side panel): mensajería al background, proyecto
     * activo e historial de conversaciones.
     * @type {{sendToBackground:Function|null, scriptId:string|null, store:object|null}}
     */
    this._host = { sendToBackground: null, scriptId: null, store: null };

    /** @type {string|null} Id de la conversación actual en el historial. */
    this._conversationId = null;

    /** @type {number} Cambia con cada "New chat"/carga: descarta guardados obsoletos. */
    this._chatSeq = 0;

    /**
     * Turno en curso del motor `tools` (null si no hay).
     * @type {{msg:object, requestId:string|null, abort:AbortController, cancelled:boolean, executor:object}|null}
     */
    this._toolTurn = null;

    // Binds explícitos para poder remover los listeners después.
    this._onLlmStreamEvent    = this._onLlmStreamEvent.bind(this);
    this._onLlmConfigUpdated  = this._onLlmConfigUpdated.bind(this);
    this._refreshTokenEstimate_ = DomUtils.debounce(() => this._updateTokenEstimate_(), 350);
    this._scheduleSave_ = DomUtils.debounce(() => this._saveConversation_(), GasChatPanel.SAVE_DEBOUNCE_MS);
    this._onWindowKeyDown  = this._onWindowKeyDown.bind(this);
    this._onDocPointerDown = this._onDocPointerDown.bind(this);

    // Items de contexto (botón "Context" y autocompletado con @).
    this._mentionItems = [
      { tag: '@selection', icon: 'selection',
        label: DomUtils.t('edChatMentionSelection', 'Selected text'),
        title: DomUtils.t('edChatCtxSelection', 'Selection'),
        hint:  DomUtils.t('edChatCtxSelectionDesc', 'Current editor selection') },
      { tag: '@file', icon: 'file',
        label: DomUtils.t('edChatMentionFile', 'Active file'),
        title: DomUtils.t('edChatMentionFile', 'Active file'),
        hint:  DomUtils.t('edChatCtxFileDesc', 'Full content of the open file') },
      { tag: '@project', icon: 'project',
        label: DomUtils.t('edChatMentionProject', 'Entire project'),
        title: DomUtils.t('edChatCtxProject', 'Project'),
        hint:  DomUtils.t('edChatCtxProjectDesc', 'All project files (up to the limit)') },
    ];
  }

  // ──────────────────────────────────────────────────────────────────
  // CICLO DE VIDA
  // ──────────────────────────────────────────────────────────────────

  /** Renderiza el shell, conecta listeners globales y carga la configuración. */
  connectedCallback() {
    // El shadowRoot persiste entre reconexiones: render y listeners internos solo una vez.
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._setupListeners();
    }
    this._syncHistoryButton_();
    window.addEventListener('keydown', this._onWindowKeyDown);
    document.addEventListener('pointerdown', this._onDocPointerDown, true);
    document.addEventListener('GAS_LLM_STREAM_EVENT', this._onLlmStreamEvent);
    document.addEventListener('GAS_LLM_CONFIG_UPDATED', this._onLlmConfigUpdated);
    this._loadConfig();
  }

  /** Libera todos los listeners globales para evitar memory leaks. */
  disconnectedCallback() {
    // Sin listener no llegarían más eventos: se cancela el stream y se conserva lo recibido.
    if (this._isStreaming) this._cancelRequest();
    this._refreshTokenEstimate_.cancel();
    document.removeEventListener('GAS_LLM_STREAM_EVENT', this._onLlmStreamEvent);
    document.removeEventListener('GAS_LLM_CONFIG_UPDATED', this._onLlmConfigUpdated);
    window.removeEventListener('keydown', this._onWindowKeyDown);
    document.removeEventListener('pointerdown', this._onDocPointerDown, true);
  }

  // ──────────────────────────────────────────────────────────────────
  // API PÚBLICA
  // ──────────────────────────────────────────────────────────────────

  /**
   * Compatibilidad: el panel ya no accede a Monaco directamente. No-op.
   * @param {object|null} _editor
   */
  setEditor(_editor) { /* no-op: usar setEditorAdapter */ }

  /**
   * Inyecta el adaptador asíncrono del editor (lo provee el bootstrap del side panel).
   * @param {object|null} adapter
   */
  setEditorAdapter(adapter) {
    this._editorAdapter = adapter || null;
    this._editorAvailable = adapter ? null : false;
    this._refreshTokenEstimate_();
    this._probeEditor_();
  }

  /**
   * Servicios del host (los provee el bootstrap del side panel). Se puede
   * llamar de nuevo con valores parciales (p. ej. al cambiar de proyecto).
   * @param {{sendToBackground?:Function, scriptId?:string|null, store?:object}} host
   */
  setHost(host = {}) {
    const prevScript = this._host.scriptId;
    this._host = { ...this._host, ...host };
    // Otro proyecto: la conversación actual se guardará como una nueva.
    if ('scriptId' in host && host.scriptId !== prevScript) this._conversationId = null;
    this._syncHistoryButton_();
  }

  /**
   * Carga una conversación del historial del proyecto actual.
   * @param {string} id
   * @returns {Promise<boolean>} true si se cargó.
   */
  async loadConversation(id) {
    const store = this._host.store;
    if (!store || !id) return false;
    const entry = await store.get(this._host.scriptId, id);
    if (!entry) return false;
    if (this._isStreaming) this._cancelRequest();
    this._resetChatState_();
    this._conversationId = entry.id;
    this._messages = (entry.messages || []).map((m) => this._restoreMessage_(m));
    this._closeHistory_();
    this._renderMessages_();
    this._updateTokenEstimate_();
    return true;
  }

  /**
   * Evento del editor (vista de revisión): el MAIN world ya aplicó/descartó
   * el archivo; aquí solo se actualiza el estado en el ChangeSet más reciente.
   * @param {{type:string, name?:string, index?:number}} event
   */
  handleEditorEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'previewClosed') { this._previewSet = null; this._setChangesFocus_(null); return; }
    // Revisión abierta desde un bloque de código: no pertenece a ningún ChangeSet.
    if (this._previewSet?.source === 'code') {
      if (event.type === 'previewAccept' && event.ok !== false) {
        this._showToast_(DomUtils.t('edDiffApplied', 'Changes applied to $1', event.name || this._previewSet.names[0] || ''), 'success', 3500);
      }
      if (event.type === 'previewAccept' || event.type === 'previewReject') this._previewSet = null;
      return;
    }

    const msg = this._latestChangesMessage_();
    if (!msg) return;
    const name = event.name || this._previewSet?.names?.[event.index] || '';
    const file = this._findChangeFile_(msg, name);

    if (event.type === 'previewNavigate') {
      this._setChangesFocus_(file ? file.name : null);
      return;
    }
    if (!file || file.status !== 'pending' || file.stale) return;
    if (event.type === 'previewAccept' && event.ok === false) {
      if (event.error !== 'conflict') return;
      file.conflict = { reason: 'changed', failed: [] };
      this._refreshChangesCard_(msg);
      return;
    }
    if (event.type === 'previewAccept') file.status = 'accepted';
    else if (event.type === 'previewReject') file.status = 'rejected';
    else return;
    this._refreshChangesCard_(msg);
  }

  /** En el side panel siempre está visible: solo enfoca el textarea. */
  open() {
    setTimeout(() => {
      this.shadowRoot.getElementById('gc__chatInput')?.focus();
    }, 30);
  }

  /** No-op: Chrome gestiona el cierre del side panel. */
  close() { /* no-op */ }

  /** Equivale a `open()` (enfocar); el panel no se puede ocultar desde aquí. */
  toggle() {
    this.open();
  }

  /**
   * Llama a un método del adaptador sin lanzar nunca.
   * @param {string} method
   * @param {...any} args
   * @returns {Promise<any>} Resultado del adaptador o null si no existe/falla.
   * @private
   */
  async _callAdapter_(method, ...args) {
    const adapter = this._editorAdapter;
    if (!adapter || typeof adapter[method] !== 'function') return null;
    try { return await adapter[method](...args); }
    catch (_) { return null; }
  }

  // ──────────────────────────────────────────────────────────────────
  // CONFIG (persistencia vía bridge)
  // ──────────────────────────────────────────────────────────────────

  /** Carga la configuración desde chrome.storage.sync vía bridge. */
  _loadConfig() {
    this._bridgeCall_('GAS_LLM_GET_CONFIG').then((cfg) => {
      if (cfg && typeof cfg === 'object') {
        // Defensa: si un background antiguo aún enviara keys en claro, se descartan.
        delete cfg.apiKeys;
        this._config = {
          ...this._config,
          ...cfg,
          apiKeysSet: { ...(cfg.apiKeysSet || {}) },
          providerSettings: { ...this._config.providerSettings, ...(cfg.providerSettings || {}) },
        };
      }

      // El tema (light/dark) lo decide la opción global "IDE Dark Mode":
      // `body.qc__is-dark-mode` cambia los tokens --gt-* heredados.
      this._loadAiContext_();
      this._syncModeToggle_();
      this._refreshComposerProviderUI_();
      this._refreshSettingsUI_();
    });
  }

  /** Carga el AI Context global desde el background. */
  _loadAiContext_() {
    this._bridgeCall_('GAS_LLM_GET_GLOBAL_AI_CONTEXT').then((context) => {
      if (context) this._config.aiContext = context;
    });
  }

  /**
   * Persiste la configuración actual vía bridge (fire-and-forget).
   * Nunca envía `apiKeysSet` ni `aiContext`; las keys solo viajan en
   * `apiKeyUpdates` (string = guardar, null = eliminar) y el background las fusiona.
   * @param {Object<string, string|null>} [apiKeyUpdates]
   */
  _saveConfig(apiKeyUpdates = null) {
    const payload = this._publicConfigPayload_();
    if (apiKeyUpdates && Object.keys(apiKeyUpdates).length) {
      payload.apiKeyUpdates = apiKeyUpdates;
    }
    document.dispatchEvent(
      new CustomEvent('GAS_LLM_SAVE_CONFIG', {
        detail: JSON.stringify(payload),
      })
    );
  }

  /**
   * Config pública a persistir (sin keys, `apiKeysSet` ni `aiContext`).
   * @returns {object}
   * @private
   */
  _publicConfigPayload_() {
    const { apiKeys, apiKeysSet, aiContext, ...config } = this._config;
    return { ...config };
  }

  /**
   * Guarda la config y espera a que el background la persista (así la
   * siguiente petición ya la ve). Sin host, cae al guardado fire-and-forget.
   * @returns {Promise<void>}
   * @private
   */
  async _saveConfigAndWait_() {
    const send = this._host.sendToBackground;
    if (typeof send !== 'function') { this._saveConfig(); return; }
    await send({ type: 'LLM_SAVE_CONFIG', payload: this._publicConfigPayload_() }, null);
  }

  /**
   * Relee solo `apiKeysSet` de la config pública (p. ej. tras cambiar el modo
   * de autenticación de Gemini o iniciar/cerrar sesión) sin tocar los campos
   * de settings que el usuario esté editando.
   * @returns {Promise<void>}
   * @private
   */
  async _reloadKeysSet_() {
    const cfg = await this._bridgeCall_('GAS_LLM_GET_CONFIG');
    if (cfg && typeof cfg === 'object') this._config.apiKeysSet = { ...(cfg.apiKeysSet || {}) };
    this._renderProviderList_();
    this._refreshComposerProviderUI_();
  }

  /**
   * Devuelve la configuración del proveedor (temperatura, prompt, modelos
   * personalizados, endpoint) fusionando defaults con lo guardado.
   * @param {string} providerId
   * @returns {{temperature:number, systemPrompt:string, customModels:string[], endpointUrl:string}}
   * @private
   */
  _getProviderSettings_(providerId) {
    const defaults = {
      temperature: 0.3,
      systemPrompt: GasChatPanel.DEFAULT_SYSTEM_PROMPT,
      customModels: [],
      fetchedModels: [],
      endpointUrl: '',
      maxTokens: '',
      agentEngine: 'auto',
      // Ventana de contexto (tokens). Los servidores locales suelen tener poca.
      contextWindow: providerId === 'custom' ? 8192 : '',
    };
    return {
      ...defaults,
      ...((this._config.providerSettings || {})[providerId] || {}),
    };
  }

  /**
   * Envía un evento al bridge y resuelve con el `data` de la respuesta
   * (`GAS_LLM_CONFIG_RESULT`, mismo `requestId`), o `null` tras 10 s.
   * @param {string} eventName
   * @param {object} [payload]
   * @returns {Promise<any>}
   * @private
   */
  async _bridgeCall_(eventName, payload = {}) {
    const detail = await DomUtils.bridgeRequest(
      eventName, 'GAS_LLM_CONFIG_RESULT', payload, { timeoutMs: 10000 }
    );
    return detail ? detail.data : null;
  }

  // ──────────────────────────────────────────────────────────────────
  // ENVÍO DE MENSAJES Y CONTEXTO DEL EDITOR
  // ──────────────────────────────────────────────────────────────────

  /**
   * Expande los tags @, construye los mensajes para el API y arranca el stream.
   * Si la petición estimada supera el umbral de tokens, pide confirmación
   * en el panel antes de enviar.
   * Con `text` (reintento) se envía ese texto sin tocar el composer y, si se
   * indica `replaceFrom`, se descartan del historial los mensajes desde ese
   * índice (el turno fallido) antes de añadir el nuevo.
   * @param {{confirmed?:boolean, text?:string, replaceFrom?:number}} [opts]
   */
  async _sendMessage({ confirmed = false, text, replaceFrom, display, engine: forcedEngine, notice } = {}) {
    const input    = this.shadowRoot.getElementById('gc__chatInput');
    const isRetry  = typeof text === 'string';
    const userText = (isRetry ? text : (input?.value || '')).trim();
    if (!userText || this._isStreaming || this._isGatheringContext) return;

    const provider = GAS_LLM_PROVIDERS[this._config.provider] ? this._config.provider : 'gemini';
    const model    = this._config.model || this._modelsFor_(provider)[0] || '';
    this._config.provider = provider;
    this._config.model    = model;

    // La key vive solo en el background; aquí solo se comprueba que exista.
    if (!this._config.apiKeysSet?.[provider] && provider !== 'custom') {
      this._appendSystemNotice_(
        DomUtils.t('edChatMissingKey', 'Missing API key for $1. Configure it in Settings.', GAS_LLM_PROVIDERS[provider]?.label || provider),
        'warn'
      );
      this._openSettings_();
      return;
    }

    const provSettings = this._getProviderSettings_(provider);

    // Recolectar el contexto del editor (asíncrono) mostrando el indicador "thinking".
    this._isGatheringContext = true;
    this._appendThinking_();
    // Modo Agent: motor `tools` (tool calling) o `blocks` (bloques de edición).
    const engine = this._mode_() === 'agent' ? (forcedEngine || this._agentEngine_(provider)) : null;
    let context;
    let agent = null;
    let toolsInfo = null;
    try {
      context = await this._collectContext_(userText);
      if (engine === 'tools') {
        // Solo el nombre del archivo activo: el modelo lee el resto con herramientas.
        toolsInfo = await this._callAdapter_('getInfo');
      } else if (engine === 'blocks') {
        // Lista de archivos + archivo activo + archivos mencionados.
        agent = await this._collectAgentContext_(userText);
      }
    } finally {
      this._isGatheringContext = false;
      this.shadowRoot.getElementById('gc__messages')?.querySelector('.gc__thinking')?.remove();
    }
    // El componente pudo desconectarse o empezar otro stream mientras se esperaba.
    if (!this.isConnected || this._isStreaming) return;

    const expandedContent = context.text;
    const historyEnd      = isRetry && typeof replaceFrom === 'number' ? replaceFrom : this._messages.length;
    const useTools        = engine === 'tools' && !!toolsInfo?.available;
    const isAgent         = !!agent?.available;
    // Modo Ask con contenido de archivos (@file/@project/@selection): se añaden las reglas de anclaje.
    const askExtra        = !isAgent && !useTools && expandedContent !== userText ? GasChatPanel.GROUNDING_RULES : '';
    const apiMessages     = useTools
      ? this._buildToolsMessages_(expandedContent, historyEnd, toolsInfo.fileName || '')
      : this._buildApiMessages_(provSettings, expandedContent, historyEnd, isAgent ? agent.system : askExtra);
    // Sin editor el modo Agent no puede leer archivos: se envía como Ask.
    if ((agent && !isAgent) || (engine === 'tools' && !useTools)) context.missingEditor = true;

    // Ventana de contexto del modelo: se recorta la petición si no cabe.
    const contextNotice = await this._fitContextWindow_(apiMessages, provSettings, isAgent ? agent : null);
    if (!this.isConnected || this._isStreaming) return;

    // Control de coste: peticiones grandes (típicamente @project) requieren confirmación.
    const tokens = this._estimateTokens_(apiMessages);
    if (!confirmed && tokens > GasChatPanel.TOKEN_CONFIRM_THRESHOLD) {
      if (context.missingEditor) this._appendNoEditorNotice_();
      this._showSendConfirm_(tokens, isRetry ? { text: userText, replaceFrom: historyEnd, display, engine: forcedEngine } : null);
      return;
    }
    this._hideSendConfirm_();

    if (isRetry) {
      // Se descarta el turno fallido (usuario + error) antes de reenviarlo.
      this._messages.splice(historyEnd);
    } else if (input) {
      input.value = '';
      input.style.height = 'auto';
      this._updateTokenEstimate_();
    }

    // `display` (p. ej. "Ask to fix") muestra un texto corto; `_raw` conserva lo enviado para reintentos.
    this._messages.push({ role: 'user', content: display || userText, _raw: userText, _expanded: expandedContent });

    if (useTools) {
      this._runToolsTurn_({ provider, model, provSettings, apiMessages, userIdx: this._messages.length - 1, notice, warning: contextNotice });
      return;
    }

    const requestId = `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._currentRequestId = requestId;
    this._stream = {
      requestId, model, text: '', bodyEl: null, wrapEl: null, frameId: 0,
      agent: isAgent, agentFiles: isAgent ? agent.files : [], notice: notice || '', warning: contextNotice || '',
    };
    this._isStreaming = true;
    this._renderMessages_(); // Incluye el indicador "thinking" hasta el primer delta.
    // El aviso va después del render (que reconstruye la lista de mensajes).
    if (context.missingEditor) this._appendNoEditorNotice_();
    if (notice) this._appendSystemNotice_(notice, 'info');
    if (contextNotice) this._appendSystemNotice_(contextNotice, 'warn');
    this._updateSendButton_();

    // La API key la inyecta el background; nunca viaja por el MAIN world.
    document.dispatchEvent(
      new CustomEvent('GAS_LLM_STREAM_START', {
        detail: JSON.stringify({
          requestId,
          provider,
          model,
          temperature: provSettings.temperature,
          endpointUrl: provSettings.endpointUrl,
          maxTokens: provSettings.maxTokens ? Number(provSettings.maxTokens) : undefined,
          messages: apiMessages,
        }),
      })
    );
  }

  /**
   * Construye la lista de mensajes para el API: system (prompt + AI Context),
   * historial y, opcionalmente, el mensaje de usuario pendiente.
   * @param {{systemPrompt:string}} provSettings
   * @param {string} [pendingUserContent]
   * @param {number} [historyEnd] Índice (exclusivo) hasta el que se toma el historial.
   * @returns {Array<{role:string, content:string}>}
   * @private
   */
  _buildApiMessages_(provSettings, pendingUserContent, historyEnd = this._messages.length, extraSystem = '') {
    let systemContent = provSettings.systemPrompt;
    if (this._config.aiContext) {
      systemContent += '\n\n--- Project Context ---\n' + this._config.aiContext;
    }
    if (extraSystem) systemContent += '\n\n' + extraSystem;
    const messages = [
      { role: 'system', content: systemContent },
      ...this._messages
        .slice(0, historyEnd)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m._expanded || this._apiContentOf_(m) })),
    ];
    if (pendingUserContent) messages.push({ role: 'user', content: pendingUserContent });
    return messages;
  }

  /**
   * Contenido de un mensaje para el historial del API. Las respuestas con
   * error conservan el texto parcial + el error (mantiene la alternancia de roles).
   * @param {{content:string, _isError?:boolean, _error?:string}} m
   * @returns {string}
   * @private
   */
  _apiContentOf_(m) {
    if (!m._isError) return m.content;
    const partial = m.content ? `${m.content}\n\n` : '';
    return `${partial}**Error:** ${m._error || ''}`;
  }

  /**
   * Estimación aproximada de tokens (caracteres / 4).
   * @param {Array<{content:string}>} messages
   * @returns {number}
   * @private
   */
  _estimateTokens_(messages) {
    const chars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
    return Math.ceil(chars / GasChatPanel.CHARS_PER_TOKEN);
  }

  /** Ventana de contexto configurada (tokens) del proveedor; 0 = desconocida/sin límite. */
  _contextWindow_(provSettings) {
    const n = parseInt(provSettings?.contextWindow, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Ajusta `apiMessages` (en sitio) a la ventana de contexto del proveedor.
   * Solo el motor de bloques del modo Agent se puede recortar (archivos
   * mencionados → lista de archivos → archivo activo); en el resto solo se avisa.
   * @param {Array<{role:string, content:string}>} apiMessages
   * @param {object} provSettings
   * @param {{system:string, ctx:object}|null} agent Contexto del motor de bloques.
   * @returns {Promise<string>} Aviso para el usuario ('' si cabe sin cambios).
   * @private
   */
  async _fitContextWindow_(apiMessages, provSettings, agent) {
    const contextWindow = this._contextWindow_(provSettings);
    const budget = GasChatContext.budgetTokens(contextWindow);
    if (!budget) return '';
    let tokens = this._estimateTokens_(apiMessages);
    if (tokens <= budget) return '';

    const sys = apiMessages[0];
    if (agent?.ctx && sys?.role === 'system' && sys.content.endsWith(agent.system)) {
      const prefix = sys.content.slice(0, sys.content.length - agent.system.length);
      const otherChars = apiMessages.slice(1).reduce((sum, m) => sum + String(m.content || '').length, 0);
      const maxChars = budget * GasChatPanel.CHARS_PER_TOKEN - otherChars - prefix.length;
      // La selección del usuario centra el recorte del archivo activo.
      const sel = await this._callAdapter_('getSelection');
      const res = GasChatContext.shrinkAgentContext({ ...agent.ctx, focus: sel?.available ? sel.text || '' : '' }, maxChars);
      if (res.trimmed) {
        apiMessages[0] = { ...sys, content: prefix + res.system };
        tokens = this._estimateTokens_(apiMessages);
      }
    }
    const args = [this._formatTokens_(tokens), this._formatContext_(contextWindow)];
    if (tokens > budget) {
      return DomUtils.t('edChatContextOverflow',
        "This request (≈$1 tokens) doesn't fit the model's context ($2). The model may ignore part of it. Increase the context length or send less context.",
        ...args);
    }
    return DomUtils.t('edChatContextTrimmed',
      "Request trimmed to fit the model's context (≈$1 of $2 tokens). Increase the context length for better answers.",
      ...args);
  }

  /** Ventana de contexto compacta: potencias de 1024 como "4k"/"8k"/"32k"; el resto como tokens. */
  _formatContext_(n) {
    return n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : this._formatTokens_(n);
  }

  /** Formatea un número de tokens de forma compacta (ej. 1.2k, 45k). */
  _formatTokens_(n) {
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  }

  /**
   * Actualiza el indicador de tokens estimados del composer (mensaje
   * expandido + historial + system). Se invoca con debounce desde el input.
   * @private
   */
  async _updateTokenEstimate_() {
    const el    = this.shadowRoot.getElementById('gc__tokenEstimate');
    const input = this.shadowRoot.getElementById('gc__chatInput');
    if (!el) return;
    const seq  = ++this._estimateSeq;
    const text = (input?.value || '').trim();
    if (!text) {
      el.textContent = '';
      el.hidden = true;
      return;
    }
    const provider = this._config.provider;
    const baseChars = this._buildApiMessages_(this._getProviderSettings_(provider), text)
      .reduce((sum, m) => sum + String(m.content || '').length, 0);
    const tagChars = (await this._estimateTagChars_(text)) + (await this._estimateAgentChars_());
    // Descartar resultados de una estimación anterior que terminó tarde.
    if (seq !== this._estimateSeq) return;
    const tokens = Math.ceil((baseChars + tagChars) / GasChatPanel.CHARS_PER_TOKEN);
    const contextWindow = this._contextWindow_(this._getProviderSettings_(provider));
    el.hidden = false;
    if (contextWindow) {
      // Con ventana configurada: "≈5.2k / 8k" (ámbar por encima del 85 %; al enviar se recorta).
      el.textContent = DomUtils.t('edChatTokenEstimateCtx', '≈$1 / $2', this._formatTokens_(tokens), this._formatContext_(contextWindow));
      el.title = DomUtils.t('edChatTokenEstimateCtxTitle',
        "Estimated tokens for this request vs. the model's context length (~4 chars/token). Bigger requests are trimmed.");
      el.classList.toggle('gc__tokenEstimate--warn', tokens > GasChatContext.budgetTokens(contextWindow));
    } else {
      el.textContent = DomUtils.t('edChatTokenEstimate', '≈ $1 tokens', this._formatTokens_(tokens));
      el.title = DomUtils.t('edChatTokenEstimateTitle', 'Estimated tokens for this request (message + context + history, ~4 chars/token)');
      el.classList.toggle('gc__tokenEstimate--warn', tokens > GasChatPanel.TOKEN_CONFIRM_THRESHOLD);
    }
  }

  /**
   * Muestra la barra de confirmación para peticiones grandes.
   * @param {number} tokens
   * @param {{text:string, replaceFrom:number}|null} [pending] Reintento a reenviar al confirmar.
   * @private
   */
  _showSendConfirm_(tokens, pending = null) {
    this._pendingSend = pending;
    const bar  = this.shadowRoot.getElementById('gc__confirmBar');
    const text = this.shadowRoot.getElementById('gc__confirmText');
    if (!bar || !text) return;
    text.textContent = DomUtils.t(
      'edChatConfirmLarge',
      'This request is about $1 tokens (over $2). It may be slow or costly. Send anyway?',
      this._formatTokens_(tokens),
      this._formatTokens_(GasChatPanel.TOKEN_CONFIRM_THRESHOLD)
    );
    bar.hidden = false;
    this.shadowRoot.getElementById('gc__confirmSend')?.focus();
  }

  /** Oculta la barra de confirmación. */
  _hideSendConfirm_() {
    this._pendingSend = null;
    const bar = this.shadowRoot.getElementById('gc__confirmBar');
    if (bar) bar.hidden = true;
  }

  /** Indica si la barra de confirmación está visible. */
  _isSendConfirmOpen_() {
    const bar = this.shadowRoot.getElementById('gc__confirmBar');
    return !!bar && !bar.hidden;
  }

  /**
   * Reemplaza los tags @selection / @file / @project por el contenido real del editor.
   * @param {string} text
   * @returns {Promise<string>}
   */
  async _expandContextTags_(text) {
    return (await this._collectContext_(text)).text;
  }

  /**
   * Expande los tags @ con datos del adaptador del editor. Si un tag se usa
   * pero el editor no está disponible, el tag se elimina y se marca
   * `missingEditor` para avisar al usuario.
   * Se usan funciones de reemplazo para que `$&`, `$'`, etc. del código no se interpreten.
   * @param {string} text
   * @returns {Promise<{text:string, missingEditor:boolean}>}
   * @private
   */
  async _collectContext_(text) {
    let result = text;
    let missingEditor = false;
    if (/(^|\s)@selection\b/.test(result)) {
      const sel = await this._callAdapter_('getSelection');
      if (sel?.available) {
        const selText = sel.text || '';
        const block = selText ? '```\n' + selText + '\n```' : '(no selection)';
        result = result.replace(/@selection\b/g, () => `\n[Current selection]\n${block}\n`);
      } else {
        missingEditor = true;
        result = result.replace(/@selection\b/g, () => '');
      }
    }
    if (/(^|\s)@file\b/.test(result)) {
      const file = await this._callAdapter_('getFile');
      if (file?.available) {
        const fileText = file.text || '';
        const block = fileText ? '```\n' + fileText + '\n```' : '(no active file)';
        result = result.replace(/@file\b/g, () => `\n[Active file]\n${block}\n`);
      } else {
        missingEditor = true;
        result = result.replace(/@file\b/g, () => '');
      }
    }
    if (/(^|\s)@project\b/.test(result)) {
      const project = await this._callAdapter_('getProject', GasChatPanel.PROJECT_MAX_CHARS);
      if (project?.available) {
        const all = this._formatProjectText_(project.files, project.omitted);
        result = result.replace(/@project\b/g, () => `\n[Entire project]\n${all}\n`);
      } else {
        missingEditor = true;
        result = result.replace(/@project\b/g, () => '');
      }
    }
    return { text: result, missingEditor };
  }

  /**
   * Formatea los archivos del proyecto (ya recortados por el editor a
   * `PROJECT_MAX_CHARS`). Los omitidos se listan en una nota final para que
   * el modelo sepa que no los ve.
   * @param {Array<{name:string, text:string}>} files
   * @param {string[]} omitted
   * @returns {string}
   * @private
   */
  _formatProjectText_(files, omitted) {
    const maxChars = GasChatPanel.PROJECT_MAX_CHARS;
    const blocks = (Array.isArray(files) ? files : []).map((f) =>
      `--- File: ${f?.name || 'unknown'} ---\n\`\`\`\n${f?.text || ''}\n\`\`\`\n`
    );
    const omittedNames = Array.isArray(omitted) ? omitted : [];
    if (omittedNames.length) {
      blocks.push(
        `[Note: @project is capped at ${maxChars.toLocaleString('en-US')} characters. ` +
        `${omittedNames.length} file(s) were omitted and are NOT included above: ${omittedNames.join(', ')}. ` +
        'Do not assume their contents; ask the user to share them with @file if needed.]\n'
      );
    }
    return blocks.join('\n');
  }

  /**
   * Estima (sin transferir código) los caracteres que añadirán los tags @
   * presentes en el texto, usando `getStats()` del adaptador.
   * @param {string} text
   * @returns {Promise<number>}
   * @private
   */
  async _estimateTagChars_(text) {
    const count = (re) => (text.match(re) || []).length;
    const nSel  = /(^|\s)@selection\b/.test(text) ? count(/@selection\b/g) : 0;
    const nFile = /(^|\s)@file\b/.test(text)      ? count(/@file\b/g)      : 0;
    const nProj = /(^|\s)@project\b/.test(text)   ? count(/@project\b/g)   : 0;
    if (!nSel && !nFile && !nProj) return 0;

    const stats = await this._callAdapter_('getStats');
    if (!stats?.available) return 0;
    // Overhead aproximado de cabeceras y fences que añade `_collectContext_`.
    const WRAP = 32;
    const projectChars = Math.min(Number(stats.projectChars) || 0, GasChatPanel.PROJECT_MAX_CHARS);
    return nSel  * ((Number(stats.selectionChars) || 0) + WRAP) +
           nFile * ((Number(stats.fileChars) || 0) + WRAP) +
           nProj * (projectChars + WRAP);
  }

  // ──────────────────────────────────────────────────────────────────
  // MODO AGENT (contexto y estado)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Modo activo del composer. Sin preferencia guardada se usa Agent cuando
   * hay un editor disponible y Ask en caso contrario.
   * @returns {'ask'|'agent'}
   * @private
   */
  _mode_() {
    const saved = this._config.mode;
    if (saved === 'ask' || saved === 'agent') return saved;
    return this._editorAdapter && this._editorAvailable !== false ? 'agent' : 'ask';
  }

  /** Cambia el modo (Ask/Agent), lo persiste y re-estima tokens. */
  _setMode_(mode) {
    if (mode !== 'ask' && mode !== 'agent') return;
    if (this._config.mode === mode) return;
    this._config.mode = mode;
    this._saveConfig();
    this._syncModeToggle_();
    this._refreshTokenEstimate_();
  }

  /** Sincroniza el toggle segmentado y el placeholder con el modo activo. */
  _syncModeToggle_() {
    const sr = this.shadowRoot;
    const mode = this._mode_();
    sr?.querySelectorAll('.gc__modeOpt').forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    const input = sr?.getElementById('gc__chatInput');
    if (input) {
      input.placeholder = mode === 'agent'
        ? DomUtils.t('edChatAgentPlaceholder', 'Describe a change… type @ for context')
        : DomUtils.t('edChatInputPlaceholder', 'Ask something… type @ for context');
    }
  }

  /** Comprueba (async) si hay editor y actualiza el modo por defecto. */
  async _probeEditor_() {
    if (!this._editorAdapter) { this._syncModeToggle_(); return; }
    const available = await this._callAdapter_('isAvailable');
    this._editorAvailable = available === null ? null : !!available;
    this._syncModeToggle_();
  }

  /**
   * Nombre visible de un archivo del proyecto (con extensión si el editor
   * la omite: `Code` + `gs` → `Code.gs`).
   * @param {{name:string, type?:string}} f
   * @returns {string}
   * @private
   */
  _fileLabel_(f) {
    const name = String(f?.name || '');
    const type = String(f?.type || '').toLowerCase();
    if (!type || /\.[a-z0-9]+$/i.test(name)) return name;
    const ext = type === 'server_js' ? 'gs' : type;
    return `${name}.${ext}`;
  }

  /**
   * Resuelve una ruta escrita por el modelo (`Code.gs`, `utils/Helpers`, …)
   * al nombre real del archivo del proyecto. Si no se encuentra, devuelve
   * la ruta tal cual (readFile decide).
   * @param {string} path
   * @param {Array<{name:string, type?:string}>} files
   * @returns {string}
   * @private
   */
  _resolveFileName_(path, files) {
    const p = String(path || '').trim();
    const list = Array.isArray(files) ? files : [];
    const strip = (s) => String(s).replace(/\.(gs|js|html|json)$/i, '');
    const hit = list.find((f) => f.name === p)
      || list.find((f) => this._fileLabel_(f) === p)
      || list.find((f) => strip(f.name) === strip(p))
      || list.find((f) => strip(f.name).toLowerCase() === strip(p).toLowerCase());
    return hit ? hit.name : p;
  }

  /**
   * Archivos del proyecto mencionados en el texto del usuario (nombre
   * completo, con extensión o solo el basename). Sensible a mayúsculas para
   * no confundir la palabra "code" con `Code.gs`.
   * @param {string} text
   * @param {Array<{name:string, type?:string}>} files
   * @returns {string[]}
   * @private
   */
  _mentionedFiles_(text, files) {
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = [];
    for (const f of files) {
      const name = String(f?.name || '');
      if (!name) continue;
      const label = this._fileLabel_(f);
      const candidates = [...new Set([label, name, name.split('/').pop(), label.split('/').pop()])]
        .filter((c) => c.length >= 3);
      const hit = candidates.some((c) => new RegExp(`(^|[^\\w/.-])${escRe(c)}(?![\\w-])`).test(text));
      if (hit) out.push(name);
    }
    return out;
  }

  /**
   * Contexto del modo Agent para el system prompt: rol, formato de bloques
   * de edición, lista de archivos, archivo activo completo y archivos
   * mencionados en el texto (hasta `PROJECT_MAX_CHARS`).
   * @param {string} userText
   * @returns {Promise<{available:boolean, system:string, files:Array<object>}>}
   * @private
   */
  async _collectAgentContext_(userText) {
    const list = await this._callAdapter_('listFiles');
    if (!list?.available) return { available: false, system: '', files: [] };
    const files = Array.isArray(list.files) ? list.files : [];

    const active = await this._callAdapter_('getFile');
    const activeName = active?.available ? this._resolveFileName_(active.name || '', files) : '';

    // Archivo activo primero; luego los mencionados (sin duplicar).
    const wanted = [];
    if (activeName) wanted.push({ name: activeName, text: active.text || '', active: true });
    for (const name of this._mentionedFiles_(userText, files)) {
      if (name !== activeName) wanted.push({ name });
    }

    let budget = GasChatPanel.PROJECT_MAX_CHARS;
    const included = [];
    const omitted = [];
    let activeLabel = '';
    for (const w of wanted) {
      let text = w.text;
      if (text === undefined) {
        const res = await this._callAdapter_('readFile', w.name);
        if (!res?.found) continue;
        text = res.text || '';
      }
      const meta = files.find((f) => f.name === w.name);
      const label = meta ? this._fileLabel_(meta) : w.name;
      if (w.active) {
        // El archivo activo siempre se incluye (recortado si excede el tope).
        activeLabel = label;
        text = GasChatContext.truncateAround(text, budget);
      } else if (text.length > budget) {
        omitted.push(label);
        continue;
      }
      budget -= text.length;
      included.push({ label, text, active: !!w.active });
    }

    const listing = files.length
      ? files.map((f) => `- ${this._fileLabel_(f)}${Number.isFinite(f.lines) ? ` (${f.lines} lines)` : ''}`).join('\n')
      : '(no files)';
    const listingCompact = files.length ? files.map((f) => this._fileLabel_(f)).join(', ') : '(no files)';
    const format = typeof GasEditBlocks !== 'undefined' ? GasEditBlocks.FORMAT_INSTRUCTIONS : '';
    const activeLine = activeLabel
      ? `[Active file in the editor: ${activeLabel} — its full content is included below; "this file" or "the code" refers to it.]`
      : '';
    const ctx = {
      head: [GasChatPanel.AGENT_ROLE, GasChatPanel.GROUNDING_RULES, format, activeLine].filter(Boolean),
      listing, listingCompact, files: included, omitted,
    };
    return { available: true, system: GasChatContext.composeAgentSystem(ctx), files, ctx };
  }

  /**
   * Caracteres aproximados que añade el modo Agent (archivo activo, rol,
   * formato y lista de archivos), sin transferir código.
   * @returns {Promise<number>}
   * @private
   */
  async _estimateAgentChars_() {
    if (this._mode_() !== 'agent') return 0;
    // Motor tools: solo rol + definiciones de herramientas (~1.5k caracteres).
    if (this._agentEngine_(this._config.provider) === 'tools') return GasChatPanel.TOOLS_AGENT_ROLE.length + GasChatPanel.GROUNDING_RULES.length + 1500;
    const stats = await this._callAdapter_('getStats');
    if (!stats?.available) return 0;
    const format = typeof GasEditBlocks !== 'undefined' ? String(GasEditBlocks.FORMAT_INSTRUCTIONS || '').length : 0;
    return (Number(stats.fileChars) || 0) + GasChatPanel.AGENT_ROLE.length + GasChatPanel.GROUNDING_RULES.length + format + 700;
  }

  /** Muestra el aviso de que no hay un editor de Apps Script disponible. */
  _appendNoEditorNotice_() {
    this._appendSystemNotice_(
      DomUtils.t('edChatNoEditor', 'Open an Apps Script project in this window to use @selection, @file and @project.'),
      'warn'
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // MODO AGENT: MOTOR TOOLS (tool calling)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Motor del modo Agent para un proveedor: preferencia guardada
   * (`providerSettings[p].agentEngine`) o, en `auto`, `tools` para los
   * proveedores con tool calling fiable.
   * @param {string} providerId
   * @returns {'tools'|'blocks'}
   * @private
   */
  _agentEngine_(providerId) {
    if (typeof GasAgentTools === 'undefined' || typeof GasEditBlocks === 'undefined') return 'blocks';
    const pref = this._getProviderSettings_(providerId).agentEngine;
    if (pref === 'tools' || pref === 'blocks') return pref;
    return GasChatPanel.TOOL_PROVIDERS.includes(providerId) ? 'tools' : 'blocks';
  }

  /**
   * Mensajes normalizados del motor tools: system (rol + AI Context +
   * archivo activo), historial simple (texto) y el mensaje pendiente.
   * @param {string} pendingUserContent
   * @param {number} historyEnd
   * @param {string} activeFile
   * @returns {Array<{role:string, content:string}>}
   * @private
   */
  _buildToolsMessages_(pendingUserContent, historyEnd, activeFile) {
    let system = GasChatPanel.TOOLS_AGENT_ROLE;
    if (this._config.aiContext) system += '\n\n--- Project Context ---\n' + this._config.aiContext;
    if (activeFile) system += `\n\n[Active file in the editor: ${activeFile}]`;
    system += '\n\n' + GasChatPanel.GROUNDING_RULES;
    const history = this._messages
      .slice(0, historyEnd)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m._running)
      .map((m) => ({ role: m.role, content: m._expanded || this._apiContentOf_(m) || '' }))
      // Los proveedores rechazan mensajes vacíos (p. ej. un turno solo con herramientas).
      .map((m) => (m.content ? m : { ...m, content: m.role === 'assistant' ? '(proposed changes)' : '…' }));
    return [{ role: 'system', content: system }, ...history, { role: 'user', content: pendingUserContent }];
  }

  /**
   * Error del proveedor que indica que el modelo no acepta herramientas
   * (HTTP 400/404/422 que menciona tools/function).
   * @param {string} error
   * @returns {boolean}
   * @private
   */
  _isToolsUnsupportedError_(error) {
    const s = String(error || '');
    return /tool|function/i.test(s) && (/\b(400|404|422)\b/.test(s) || /support/i.test(s));
  }

  /**
   * Bucle del motor tools: pide al modelo, ejecuta sus llamadas con
   * `GasAgentTools` y repite hasta una respuesta final (máx.
   * TOOLS_MAX_ITERATIONS). El historial con herramientas vive solo en este
   * turno; en `_messages` queda el texto final + `_steps` + `_changes`.
   * @private
   */
  async _runToolsTurn_({ provider, model, provSettings, apiMessages, userIdx, notice, warning }) {
    const executor = GasAgentTools.createExecutor({
      editor: this._editorAdapter,
      editBlocks: GasEditBlocks,
      lineDiff: typeof GasLineDiff !== 'undefined' ? GasLineDiff : null,
    });
    const msg = {
      role: 'assistant', content: '', _model: model, _agent: true, _engine: 'tools',
      _steps: [], _running: true, _stepsOpen: true, _id: ++this._msgSeq,
      ...(warning ? { _warning: warning } : {}),
    };
    const turn = { msg, executor, requestId: null, abort: new AbortController(), cancelled: false, hunks: {} };
    this._toolTurn = turn;
    this._messages.push(msg);
    this._isStreaming = true;
    this._renderMessages_();
    if (notice) this._appendSystemNotice_(notice, 'info');
    this._updateSendButton_();

    const history = [...apiMessages];
    let final = null;
    let error = null;
    let permissionOrigin = null;
    let lastContent = '';

    for (let i = 0; i < GasChatPanel.TOOLS_MAX_ITERATIONS; i++) {
      const requestId = `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      turn.requestId = requestId;
      this._currentRequestId = requestId;
      let res = null;
      try {
        res = await DomUtils.bridgeRequest('GAS_LLM_REQUEST', 'GAS_LLM_RESPONSE', {
          provider,
          model,
          temperature: provSettings.temperature,
          endpointUrl: provSettings.endpointUrl,
          maxTokens: provSettings.maxTokens ? Number(provSettings.maxTokens) : undefined,
          messages: history,
          tools: executor.definitions,
        }, { timeoutMs: 120000, signal: turn.abort.signal, requestId });
      } catch (_) {
        return; // Cancelado: `_cancelRequest` ya cerró el turno.
      }
      if (turn.cancelled || this._toolTurn !== turn) return;

      if (!res) { error = DomUtils.t('edChatAgentTimeout', 'The model took too long to respond.'); break; }
      if (!res.ok) {
        if (res.aborted) { this._cancelRequest(); return; }
        // Modelo sin tool calling: se repite una vez con bloques de edición.
        if (i === 0 && !msg._steps.length && this._isToolsUnsupportedError_(res.error)) {
          this._fallbackToBlocks_(turn, userIdx);
          return;
        }
        error = String(res.error || DomUtils.t('edChatUnknownResponse', 'Empty or unknown response'));
        permissionOrigin = res.permissionOrigin || null;
        break;
      }

      const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
      lastContent = res.content || lastContent;
      if (!calls.length) { final = res.content || ''; break; }

      history.push({ role: 'assistant', content: res.content || '', toolCalls: calls, providerData: res.providerData || null });
      for (const call of calls) {
        const out = await executor.execute({ name: call.name, args: call.args });
        if (turn.cancelled || this._toolTurn !== turn) return;
        const step = out.step || { kind: call.name };
        if (step.kind === 'edit' && step.path && !step.error) turn.hunks[step.path] = (step.applied || 0) + (step.failed || 0);
        msg._steps.push(step);
        history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: String(out.content ?? '') });
        this._refreshAssistantMessage_(msg);
      }
    }

    if (final === null && !error) {
      // Se agotaron las vueltas: se conserva lo propuesto hasta ahora.
      final = lastContent;
      this._finishToolsTurn_(turn, { final });
      this._appendSystemNotice_(
        DomUtils.t('edChatAgentMaxSteps', 'Stopped after $1 steps. Review the proposed changes or ask to continue.', GasChatPanel.TOOLS_MAX_ITERATIONS),
        'warn'
      );
      return;
    }
    this._finishToolsTurn_(turn, { final, error });
    if (permissionOrigin) {
      this._appendSystemNotice_(
        DomUtils.t(
          'edChatPermissionMissing',
          'Access to $1 has not been granted. Open the extension popup → AI Context → "Provider access", allow this provider and try again.',
          permissionOrigin
        ),
        'warn'
      );
    }
  }

  /**
   * Cierra el turno del motor tools: texto final o error, ChangeSet del
   * ejecutor y guardado en el historial.
   * @param {object} turn
   * @param {{final?:string|null, error?:string|null}} result
   * @private
   */
  _finishToolsTurn_(turn, { final = '', error = null } = {}) {
    if (this._toolTurn !== turn) return;
    const { msg, executor } = turn;
    const container = this.shadowRoot.getElementById('gc__messages');
    const stickToBottom = !container || this._isNearBottom_(container);

    this._toolTurn = null;
    this._isStreaming = false;
    this._currentRequestId = null;
    delete msg._running;
    msg._stepsOpen = false;
    msg.content = final || '';
    if (error) { msg._isError = true; msg._error = error; }

    const files = executor.changeSet().files || [];
    if (files.length) {
      msg._changes = {
        loading: false, focus: null, busy: false,
        files: files.map((f) => ({
          ...f,
          name: f.path,
          failed: Array.isArray(f.failed) ? f.failed : [],
          hunks: turn.hunks[f.path] || (Array.isArray(f.failed) ? f.failed.length : 0),
          error: '',
        })),
      };
    }
    // Un turno sin texto, sin pasos y sin error no aporta nada al historial.
    if (!msg.content && !msg._steps.length && !msg._changes && !msg._isError) {
      this._messages = this._messages.filter((m) => m !== msg);
    }
    this._renderMessages_({ preserveScroll: !stickToBottom });
    this._updateSendButton_();
    this._scheduleSave_();
    // Sin propose_edit: si el modelo pegó la función completa en un bloque
    // de código normal, se convierte en un ChangeSet del archivo activo.
    if (!msg._changes && !msg._isError && this._messages.includes(msg)) this._buildConvertedChangeSet_(msg);
  }

  /**
   * El modelo no admite herramientas: se descarta el turno y se reenvía la
   * misma petición con el motor de bloques, con un aviso discreto.
   * @private
   */
  _fallbackToBlocks_(turn, userIdx) {
    const user = this._messages[userIdx];
    this._toolTurn = null;
    this._isStreaming = false;
    this._currentRequestId = null;
    this._messages = this._messages.filter((m) => m !== turn.msg);
    if (!user) { this._renderMessages_(); this._updateSendButton_(); return; }
    this._sendMessage({
      text: user._raw ?? user.content,
      display: user._raw ? user.content : undefined,
      replaceFrom: userIdx,
      confirmed: true,
      engine: 'blocks',
      notice: DomUtils.t('edChatAgentToolsFallback', "This model doesn't support tool calling; using edit blocks instead."),
    });
  }

  /**
   * Re-renderiza en su sitio un mensaje del asistente (pasos en vivo).
   * @param {object} msg
   * @private
   */
  _refreshAssistantMessage_(msg) {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;
    const el = container.querySelector(`.gc__msg--assistant[data-msg-id="${msg._id}"]`);
    if (!el) { this._renderMessages_({ preserveScroll: !this._isNearBottom_(container) }); return; }
    const stick = this._isNearBottom_(container);
    const idx = this._messages.indexOf(msg);
    DomUtils.setHTML(el, this._assistantInnerHtml_(msg, idx, this._messages.length - 1));
    if (stick) container.scrollTop = container.scrollHeight;
    if (!msg._running) this._syncApplyButtons_();
  }

  /**
   * Bloque plegable "Model steps · N" con las herramientas usadas.
   * Desplegado mientras el turno corre; plegado al terminar.
   * @param {object} m
   * @returns {string}
   * @private
   */
  _stepsHtml_(m) {
    const steps = Array.isArray(m._steps) ? m._steps : [];
    if (!steps.length && !m._running) return '';
    const esc = (s) => DomUtils.escapeHtml(s);
    const open = !!m._stepsOpen;
    const rows = steps.map((s) => this._stepRowHtml_(s)).join('');
    const working = m._running
      ? `<li class="gc__step gc__step--working" role="status"><span class="gc__spinner" aria-hidden="true"></span><span class="gc__stepText">${esc(DomUtils.t('edChatAgentWorking', 'Working…'))}</span></li>`
      : '';
    const label = DomUtils.t('edChatAgentSteps', 'Model steps');
    return `<div class="gc__steps" data-open="${open}">
        <button type="button" class="gc__stepsToggle" data-steps-toggle="${m._id}" aria-expanded="${open}">
          <span class="gc__stepsChev" aria-hidden="true">${this._icon_('chevronRight', 12)}</span>
          <span>${esc(label)}</span><span class="gc__metaSep" aria-hidden="true">·</span><span class="gc__stepsCount">${steps.length}</span>
          ${m._running ? '<span class="gc__spinner gc__spinner--xs" aria-hidden="true"></span>' : ''}
        </button>
        ${open ? `<ul class="gc__stepList">${rows}${working}</ul>` : ''}
      </div>`;
  }

  /**
   * Fila de un paso del modelo (icono + descripción).
   * @param {{kind:string, path?:string, query?:string, count?:number, applied?:number, failed?:number, error?:boolean, name?:string}} s
   * @returns {string}
   * @private
   */
  _stepRowHtml_(s) {
    const esc = (v) => DomUtils.escapeHtml(v);
    const code = (v) => `<code class="gc__stepPath">${esc(v || '')}</code>`;
    let icon = 'info';
    let text = '';
    let extra = '';
    switch (s.kind) {
      case 'list':
        icon = 'list';
        text = esc(DomUtils.t('edChatStepListed', 'Listed project files ($1)', s.count || 0));
        break;
      case 'read':
        icon = 'file';
        text = `${esc(DomUtils.t('edChatStepRead', 'Read'))} ${code(s.path)}`;
        break;
      case 'search':
        icon = 'search';
        text = `${esc(DomUtils.t('edChatStepSearched', 'Searched for'))} ${code(`"${s.query || ''}"`)}`;
        if (!s.error) extra = esc(s.count === 1 ? DomUtils.t('edChatStepOneResult', '1 result') : DomUtils.t('edChatStepResults', '$1 results', s.count || 0));
        break;
      case 'edit':
        icon = 'pencil';
        text = `${esc(DomUtils.t('edChatStepEdit', 'Proposed changes to'))} ${code(s.path)}`;
        if (!s.error) {
          const applied = s.applied || 0;
          extra = esc(applied === 1
            ? DomUtils.t('edChatStepAppliedOne', '1 change applied')
            : DomUtils.t('edChatStepApplied', '$1 changes applied', applied));
          if (s.failed) {
            const failedText = s.failed === 1
              ? DomUtils.t('edChatStepFailedOne', '1 change failed')
              : DomUtils.t('edChatStepFailed', '$1 changes failed', s.failed);
            extra += `, <span class="gc__stepFail">${esc(failedText)}</span>`;
          }
        }
        break;
      case 'create':
        icon = 'fileNew';
        text = `${esc(DomUtils.t('edChatStepCreate', 'Proposed new file'))} ${code(s.path)}`;
        break;
      default:
        text = `${esc(DomUtils.t('edChatStepTool', 'Tool'))} ${code(s.name || s.kind)}`;
    }
    if (s.error) icon = 'error';
    return `<li class="gc__step${s.error ? ' gc__step--error' : ''}">
        <span class="gc__stepIcon" aria-hidden="true">${this._icon_(icon, 13)}</span>
        <span class="gc__stepText">${text}${extra ? ` <span class="gc__stepExtra">(${extra})</span>` : ''}</span>
      </li>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // STREAMING
  // ──────────────────────────────────────────────────────────────────

  /**
   * Procesa los eventos del stream (`GAS_LLM_STREAM_EVENT`):
   * `delta` (texto incremental), `done` (contenido final) o `error`.
   * @param {CustomEvent} e
   */
  _onLlmStreamEvent(e) {
    let payload;
    try { payload = JSON.parse(e.detail); } catch (_) { return; }
    const stream = this._stream;
    if (!payload || !stream || payload.requestId !== stream.requestId) return;

    if (payload.type === 'delta') {
      if (typeof payload.text !== 'string' || !payload.text) return;
      stream.text += payload.text;
      this._scheduleStreamRender_();
      return;
    }

    if (payload.type === 'done') {
      // `content` es la fuente de verdad; los deltas solo sirven para el render progresivo.
      const content = typeof payload.content === 'string' ? payload.content : stream.text;
      this._finishStream_(content ? { role: 'assistant', content } : {
        role: 'assistant', content: '', _error: DomUtils.t('edChatEmptyResponse', 'Empty response'), _isError: true,
      });
      return;
    }

    if (payload.type === 'error') {
      if (payload.aborted) {
        // Abort iniciado fuera del panel (el cancel propio ya limpió `_stream`).
        this._finishStream_(stream.text ? { role: 'assistant', content: stream.text } : null);
        this._appendSystemNotice_(DomUtils.t('edChatRequestCancelled', 'Request cancelled'));
        return;
      }
      this._finishStream_({
        role: 'assistant',
        content: stream.text || '',
        _error: String(payload.error || DomUtils.t('edChatUnknownResponse', 'Empty or unknown response')),
        _isError: true,
      });
      if (payload.permissionOrigin) {
        this._appendSystemNotice_(
          DomUtils.t(
            'edChatPermissionMissing',
            'Access to $1 has not been granted. Open the extension popup → AI Context → "Provider access", allow this provider and try again.',
            payload.permissionOrigin
          ),
          'warn'
        );
      }
    }
  }

  /**
   * Recarga la configuraci\u00f3n LLM y muestra un toast de aviso cuando el popup
   * actualiza el config (evento `GAS_LLM_CONFIG_UPDATED` o chrome.runtime).
   * @private
   */
  _onLlmConfigUpdated() {
    this._loadConfig();
    this._showToast_(
      DomUtils.t('edChatConfigUpdated', 'AI settings updated from the popup'),
      'info',
      3000
    );
  }

  /** Agenda un render del mensaje en streaming (como mucho uno por frame). */
  _scheduleStreamRender_() {
    const stream = this._stream;
    if (!stream || stream.frameId) return;
    stream.frameId = requestAnimationFrame(() => {
      stream.frameId = 0;
      if (this._stream === stream) this._renderStreamFrame_();
    });
  }

  /** Re-renderiza el Markdown parcial; auto-scroll solo si el usuario está cerca del final. */
  _renderStreamFrame_() {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container || !this._stream) return;
    const stickToBottom = this._isNearBottom_(container);
    const body = this._ensureStreamBubble_(container);
    DomUtils.setHTML(body, this._streamBodyHtml_());
    if (stickToBottom) container.scrollTop = container.scrollHeight;
  }

  /**
   * HTML del mensaje en streaming. En modo Agent solo se muestra la prosa y
   * una fila "Editing <ruta>…" por bloque de edición (nunca los marcadores).
   * @returns {string}
   * @private
   */
  _streamBodyHtml_() {
    const stream = this._stream;
    if (!stream) return '';
    if (!stream.agent || typeof GasEditBlocks === 'undefined') return this._renderMarkdown_(stream.text);
    let parsed;
    try { parsed = GasEditBlocks.parse(stream.text); } catch (_) { return this._renderMarkdown_(stream.text); }
    const paths = (parsed.files || []).map((f) => f.path);
    let pending = '';
    try { pending = GasEditBlocks.pendingPath(stream.text) || ''; } catch (_) { /* sin bloque abierto */ }
    if (pending && !paths.includes(pending)) paths.push(pending);
    const prose = (parsed.prose || '').trim();
    const rows = paths.map((p) => this._editingRowHtml_(p)).join('');
    return `${prose ? this._renderMarkdown_(prose) : ''}${rows ? `<div class="gc__editingList">${rows}</div>` : ''}`;
  }

  /** Fila compacta "Editing <ruta>…" con spinner (solo durante el stream). */
  _editingRowHtml_(path) {
    const esc = (s) => DomUtils.escapeHtml(s);
    const { base, dir } = this._splitPath_(path);
    return `<div class="gc__editingRow" role="status">
        <span class="gc__spinner" aria-hidden="true"></span>
        <span class="gc__editingLabel">${esc(DomUtils.t('edChatAgentEditing', 'Editing'))}</span>
        <span class="gc__editingPath" title="${esc(path)}"><span class="gc__chBase">${esc(base)}</span>${dir ? `<span class="gc__chDir">${esc(dir)}</span>` : ''}</span>
      </div>`;
  }

  /** Separa `a/b/Code.gs` en `{ base:'Code.gs', dir:'a/b' }`. */
  _splitPath_(path) {
    const parts = String(path || '').split('/');
    const base = parts.pop() || '';
    return { base, dir: parts.join('/') };
  }

  /**
   * Devuelve el cuerpo de la burbuja del mensaje en streaming, creándola
   * (y retirando el indicador "thinking") si aún no está en el DOM.
   * @param {HTMLElement} container
   * @returns {HTMLElement}
   * @private
   */
  _ensureStreamBubble_(container) {
    const stream = this._stream;
    if (stream.wrapEl?.isConnected) return stream.bodyEl;
    container.querySelector('.gc__thinking')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'gc__msg--assistant';
    wrap.setAttribute('aria-busy', 'true');
    DomUtils.setHTML(wrap, `${this._assistantMetaHtml_(stream.model)}<div class="gc__assistantBody"></div>`);
    container.appendChild(wrap);
    stream.wrapEl = wrap;
    stream.bodyEl = wrap.querySelector('.gc__assistantBody');
    return stream.bodyEl;
  }

  /**
   * Cierra el stream en curso, añade el mensaje final (si lo hay) al
   * historial y re-renderiza conservando el scroll si el usuario subió.
   * @param {{role:string, content:string, _isError?:boolean}|null} message
   * @private
   */
  _finishStream_(message) {
    const stream = this._stream;
    if (stream?.frameId) cancelAnimationFrame(stream.frameId);
    const container     = this.shadowRoot.getElementById('gc__messages');
    const stickToBottom = !container || this._isNearBottom_(container);

    this._stream           = null;
    this._isStreaming      = false;
    this._currentRequestId = null;
    if (message) {
      if (stream?.model && !message._model) message._model = stream.model;
      message._id = ++this._msgSeq;
      if (stream?.agent) message._agent = true;
      // Aviso del turno (p. ej. fallback a bloques): se conserva junto al mensaje.
      if (stream?.notice) message._notice = stream.notice;
      if (stream?.warning) message._warning = stream.warning;
      this._messages.push(message);
    }

    this._renderMessages_({ preserveScroll: !stickToBottom });
    this._updateSendButton_();
    // Respuesta completa del modo Agent: se prepara el ChangeSet (lee los archivos).
    if (message && stream?.agent && !message._isError) {
      this._buildChangeSet_(message, stream.agentFiles || []);
    }
    this._scheduleSave_();
  }

  /**
   * @param {HTMLElement} container
   * @returns {boolean} true si el scroll está cerca del final.
   * @private
   */
  _isNearBottom_(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight
      <= GasChatPanel.AUTOSCROLL_THRESHOLD_PX;
  }

  // ──────────────────────────────────────────────────────────────────
  // RENDER (Shadow DOM)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Icono SVG del registro compartido (Material Symbols, currentColor).
   * @param {string} name Nombre en `GasUi.ICON_NAMES`.
   * @param {number} [size=16] Lado en px.
   * @returns {string} Marcado `<svg>` ('' si no existe).
   * @private
   */
  _icon_(name, size = 16) {
    return GasUi.icon(name, size);
  }

  /** CSS propio del componente (layout + Markdown + settings); tokens y base en gas-ui.js. */
  _styles_() {
    return `
        /* ── Host: ocupa todo el Side Panel de Chrome ── */
        :host {
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          font-family: var(--gt-font-plain);
          font-size: 13px;
          line-height: 1.5;
          color: var(--gt-on-surface);
          background: var(--gt-surface);
          -webkit-font-smoothing: antialiased;
        }

        *, *::before, *::after { box-sizing: border-box; }

        button, input, select, textarea { font: inherit; color: inherit; }

        /* Scrollbars finos y con tokens del tema */
        * {
          scrollbar-width: thin;
          scrollbar-color: color-mix(in srgb, var(--gt-on-surface) 18%, transparent) transparent;
        }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb {
          background: color-mix(in srgb, var(--gt-on-surface) 18%, transparent);
          border-radius: 10px;
          border: 3px solid transparent;
          background-clip: padding-box;
        }
        ::-webkit-scrollbar-thumb:hover { background-color: color-mix(in srgb, var(--gt-on-surface) 30%, transparent); }

        .gc__shell {
          /* Bloque contenedor de los overlays absolutos (settings). */
          position: relative;
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        /* ────────────────────────────────────────
           HEADER
        ──────────────────────────────────────── */
        .gc__header,
        .gc__settingsHeader {
          flex: 0 0 44px;
          height: 44px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 8px 0 12px;
          background: var(--gt-surface);
          border-bottom: 1px solid var(--gt-outline-variant);
          user-select: none;
        }

        /* ────────────────────────────────────────
           TOAST STACK
        ──────────────────────────────────────── */
        .gc__toastStack.gt-toast-stack {
          position: absolute;
          top: 44px; /* justo debajo del header */
          bottom: auto;
          z-index: 200;
          align-items: stretch;
          padding: 6px 8px 0;
        }

        .gc__mark {
          width: 20px;
          height: 20px;
          border-radius: var(--gt-shape-s);
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          color: var(--gt-primary);
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
        }

        .gc__title,
        .gc__settingsTitle {
          flex: 1 1 auto;
          min-width: 0;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: -.005em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .gc__headerActions { display: flex; align-items: center; gap: 2px; }

        .gc__hBtn,
        .gc__settingsBack { width: 28px; height: 28px; }

        /* ────────────────────────────────────────
           MESSAGES
        ──────────────────────────────────────── */
        .gc__messages {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 16px 16px 8px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          background: var(--gt-surface);
        }

        /* Mensaje de usuario: burbuja compacta alineada a la derecha */
        .gc__msg--user {
          align-self: flex-end;
          max-width: 88%;
          padding: 7px 11px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-container);
          border: 1px solid var(--gt-outline-variant);
          color: var(--gt-on-surface);
          font-size: 13px;
          line-height: 1.5;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        /* Mensaje del asistente: ancho completo, sin burbuja */
        .gc__msg--assistant {
          align-self: stretch;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .gc__assistantMeta {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          font-size: 11px;
          line-height: 16px;
          color: var(--gt-on-surface-variant);
        }

        .gc__assistantAvatar {
          width: 16px;
          height: 16px;
          border-radius: var(--gt-shape-xs);
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          color: var(--gt-primary);
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
        }
        .gc__assistantName { font-weight: 600; color: var(--gt-on-surface); }
        .gc__metaSep { color: var(--gt-on-surface-variant); }
        .gc__assistantModel {
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-family: var(--gt-font-mono);
          font-size: 10.5px;
        }

        .gc__assistantBody {
          min-width: 0;
          font-size: 13px;
          line-height: 1.55;
          color: var(--gt-on-surface);
          overflow-wrap: anywhere;
        }

        .gc__assistantBody > :first-child { margin-top: 0; }
        .gc__assistantBody > :last-child { margin-bottom: 0; }
        .gc__assistantBody p { margin: 0 0 8px; }
        .gc__assistantBody ul,
        .gc__assistantBody ol { margin: 4px 0 8px; padding-left: 20px; }
        .gc__assistantBody li { margin: 2px 0; }
        .gc__assistantBody li > p { margin: 0 0 4px; }
        .gc__assistantBody li > p:last-child { margin-bottom: 0; }
        .gc__assistantBody li > ul,
        .gc__assistantBody li > ol { margin: 2px 0 4px; }
        .gc__assistantBody li.gc__taskItem { list-style: none; }
        .gc__assistantBody .gc__taskBox {
          margin: 0 6px 0 -18px;
          vertical-align: -2px;
          accent-color: var(--gt-primary);
        }
        .gc__assistantBody strong { font-weight: 600; }
        .gc__assistantBody h1,
        .gc__assistantBody h2,
        .gc__assistantBody h3,
        .gc__assistantBody h4,
        .gc__assistantBody h5,
        .gc__assistantBody h6 {
          margin: 16px 0 6px;
          font-weight: 600;
          line-height: 1.35;
          letter-spacing: -.005em;
        }
        .gc__assistantBody h1 { font-size: 15px; }
        .gc__assistantBody h2 { font-size: 14px; }
        .gc__assistantBody h3 { font-size: 13px; }
        .gc__assistantBody h4,
        .gc__assistantBody h5,
        .gc__assistantBody h6 { font-size: 12.5px; color: var(--gt-on-surface-variant); }

        .gc__assistantBody blockquote {
          margin: 8px 0;
          padding: 2px 0 2px 12px;
          border-left: 2px solid var(--gt-outline);
          color: var(--gt-on-surface-variant);
        }

        .gc__assistantBody hr {
          border: 0;
          border-top: 1px solid var(--gt-outline-variant);
          margin: 12px 0;
        }

        .gc__assistantBody a {
          color: var(--gt-primary);
          text-decoration: none;
        }
        .gc__assistantBody a:hover { text-decoration: underline; text-underline-offset: 2px; }

        .gc__assistantBody del { color: var(--gt-on-surface-variant); }

        /* markdown-it envuelve la tabla: el contenedor hace scroll y lleva el borde */
        .gc__assistantBody .gc__tableWrap {
          max-width: 100%;
          overflow-x: auto;
          margin: 8px 0;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
        }
        .gc__assistantBody .gc__tableWrap > table.gc__table {
          display: table;
          min-width: 100%;
          margin: 0;
          border: 0;
          border-radius: 0;
        }
        .gc__assistantBody table.gc__table {
          display: block;
          max-width: 100%;
          overflow-x: auto;
          margin: 8px 0;
          border-collapse: collapse;
          font-size: 12px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
        }
        .gc__assistantBody table.gc__table th,
        .gc__assistantBody table.gc__table td {
          padding: 6px 10px;
          border-bottom: 1px solid var(--gt-outline-variant);
          text-align: left;
          vertical-align: top;
        }
        .gc__assistantBody table.gc__table th {
          background: var(--gt-surface-container);
          font-weight: 600;
          white-space: nowrap;
        }
        .gc__assistantBody table.gc__table tr:last-child td { border-bottom: 0; }

        /* Respuesta con error: tarjeta compacta con icono, mensaje y Reintentar */
        .gc__errorCard {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 10px 12px;
          border: 1px solid color-mix(in srgb, var(--gt-error) 28%, transparent);
          border-radius: var(--gt-shape-s);
          background: color-mix(in srgb, var(--gt-error) 8%, transparent);
        }
        .gc__assistantBody + .gc__errorCard { margin-top: 8px; }
        .gc__errorIcon { color: var(--gt-error); margin-top: 1px; flex: 0 0 auto; }
        .gc__errorMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
        .gc__errorTitle { font-size: 12.5px; font-weight: 600; color: var(--gt-on-surface); }
        .gc__errorMsg {
          font-size: 12px;
          line-height: 1.45;
          color: var(--gt-on-surface-variant);
          overflow-wrap: anywhere;
        }
        .gc__errorHint {
          margin-top: 4px;
          padding: 6px 8px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-state-hover);
          font-size: 11.5px;
          line-height: 1.45;
          color: var(--gt-on-surface-variant);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .gc__errorActions { display: flex; gap: 6px; margin-top: 8px; }

        /* Código inline */
        .gc__inlineCode {
          font-family: var(--gt-font-mono);
          font-size: .9em;
          padding: .1em .35em;
          border-radius: var(--gt-shape-xs);
          background: color-mix(in srgb, var(--gt-on-surface) 8%, transparent);
          color: var(--gt-on-surface);
        }

        /* ── Indicador "pensando": tres puntos con pulso sutil ── */
        .gc__thinking {
          align-self: stretch;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .gc__thinkingDots { display: flex; gap: 4px; height: 16px; align-items: center; }

        .gc__thinkingDots span {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--gt-on-surface-variant);
          opacity: .35;
          animation: gc__pulse 1.2s ease-in-out infinite;
        }
        .gc__thinkingDots span:nth-child(2) { animation-delay: .16s; }
        .gc__thinkingDots span:nth-child(3) { animation-delay: .32s; }

        @keyframes gc__pulse {
          0%, 80%, 100% { opacity: .25; }
          40%           { opacity: .9; }
        }

        /* ── Avisos del sistema: fila fina con icono semántico ── */
        .gc__notice {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 0 2px;
          font-size: 12px;
          line-height: 1.45;
          color: var(--gt-on-surface-variant);
          overflow-wrap: anywhere;
        }
        .gc__notice .gt-icon { margin-top: 1px; color: var(--gt-outline); }
        .gc__notice--warn .gt-icon { color: var(--gt-warning); }
        .gc__notice--error { color: var(--gt-error); }
        .gc__notice--error .gt-icon { color: var(--gt-error); }
        .gc__notice--success .gt-icon { color: var(--gt-success); }

        /* ── Estado vacío ── */
        .gc__empty {
          margin: auto 0;
          padding: 24px 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 8px;
        }

        .gc__emptyMark {
          width: 40px;
          height: 40px;
          border-radius: var(--gt-shape-m);
          display: grid;
          place-items: center;
          color: var(--gt-primary);
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
          margin-bottom: 4px;
        }

        .gc__emptyTitle {
          margin: 0;
          max-width: 300px;
          font-size: 15px;
          font-weight: 600;
          line-height: 1.4;
          letter-spacing: -.01em;
          color: var(--gt-on-surface);
        }

        .gc__emptyText {
          margin: 0;
          max-width: 300px;
          font-size: 12px;
          line-height: 1.5;
          color: var(--gt-on-surface-variant);
        }

        .gc__kbd {
          display: inline-block;
          min-width: 18px;
          padding: 0 4px;
          border: 1px solid var(--gt-outline);
          border-bottom-width: 2px;
          border-radius: var(--gt-shape-xs);
          font-family: var(--gt-font-mono);
          font-size: 11px;
          line-height: 16px;
          color: var(--gt-on-surface);
        }

        .gc__suggestions {
          margin-top: 16px;
          width: 100%;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .gc__suggestion {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          min-height: 40px;
          padding: 6px 12px 6px 6px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
          color: var(--gt-on-surface);
          font-size: 12.5px;
          text-align: left;
          cursor: pointer;
          transition: background-color .12s, border-color .12s;
        }
        .gc__suggestionIcon {
          width: 28px;
          height: 28px;
          border-radius: var(--gt-shape-s);
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          color: var(--gt-on-surface-variant);
          background: var(--gt-state-hover);
          transition: color .12s, background-color .12s;
        }
        .gc__suggestionText { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .gc__suggestion:hover { background: var(--gt-state-hover); border-color: var(--gt-outline); }
        .gc__suggestion:hover .gc__suggestionIcon { color: var(--gt-primary); background: color-mix(in srgb, var(--gt-primary) 12%, transparent); }

        /* ────────────────────────────────────────
           CODE BLOCKS
        ──────────────────────────────────────── */
        .gc__codeWrap {
          container-type: inline-size;
          margin: 8px 0;
          border: 1px solid var(--gt-code-outline);
          border-radius: var(--gt-shape-s);
          background: var(--gt-code-surface);
          overflow: hidden;
        }

        .gc__codeBar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          height: 30px;
          padding: 0 4px 0 10px;
          background: var(--gt-code-surface-high);
          border-bottom: 1px solid var(--gt-code-outline);
        }

        .gc__codeLang {
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: .05em;
          text-transform: uppercase;
          /* La barra usa --gt-code-* (siempre oscura): texto con tokens de código. */
          color: color-mix(in srgb, var(--gt-code-on-surface) 75%, var(--gt-code-surface-high));
        }

        .gc__codeBarBtns { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }

        .gc__codeBtn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 22px;
          padding: 0 6px;
          border: 0;
          border-radius: var(--gt-shape-xs);
          background: transparent;
          color: color-mix(in srgb, var(--gt-code-on-surface) 75%, var(--gt-code-surface-high));
          font-size: 11.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color .12s, color .12s;
        }
        .gc__codeBtn:hover { background: color-mix(in srgb, var(--gt-code-on-surface) 10%, transparent); color: var(--gt-code-on-surface); }
        .gc__codeBtn:active { background: color-mix(in srgb, var(--gt-code-on-surface) 16%, transparent); color: var(--gt-code-on-surface); }
        .gc__codeBtn--success,
        .gc__codeBtn--success:hover { color: color-mix(in srgb, var(--gt-success) 50%, var(--gt-code-on-surface)); }

        /* Bloques estrechos con Apply visible: Copy/Insert/Replace solo con
           icono (Apply conserva el texto); muy estrechos, todos solo icono. */
        @container (max-width: 380px) {
          .gc__codeBarBtns:has(.gc__codeBtn--fits) .gc__codeBtn:not([data-action="apply"]) .gc__codeBtnLabel { display: none; }
        }
        @container (max-width: 280px) {
          .gc__codeBtnLabel { display: none; }
        }
        .gc__codeNotice { margin: -4px 0 10px; }

        .gc__codeBlock {
          margin: 0;
          padding: 10px 12px;
          overflow-x: auto;
          white-space: pre;
          tab-size: 2;
          /* Sin ligaduras: "=>" o "!==" deben verse tal cual se copian. */
          font-variant-ligatures: none;
          font-feature-settings: "liga" 0, "calt" 0;
          font-family: var(--gt-font-mono);
          font-size: 12px;
          line-height: 1.55;
          color: var(--gt-code-on-surface);
        }
        .gc__codeBlock code { font: inherit; }

        /* Resaltado de sintaxis (paleta GitHub oscura: el bloque siempre usa --gt-code-*) */
        .gc__codeBlock .hl-comment { color: #8b949e; font-style: italic; }
        .gc__codeBlock .hl-keyword { color: #ff7b72; }
        .gc__codeBlock .hl-string  { color: #a5d6ff; }
        .gc__codeBlock .hl-number  { color: #79c0ff; }
        .gc__codeBlock .hl-builtin { color: #d2a8ff; }
        .gc__codeBlock .hl-fn      { color: #d2a8ff; }
        .gc__codeBlock .hl-prop    { color: #7ee787; }
        .gc__codeBlock .hl-unit    { color: #ffa657; }



        /* Apply: solo cuando hay un editor de Apps Script con archivo activo. */
        .gc__codeBtn[data-action="apply"]:not(.gc__codeBtn--fits) { display: none; }

        /* ────────────────────────────────────────
           COMPOSER
        ──────────────────────────────────────── */
        .gc__composer {
          flex: 0 0 auto;
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 8px 12px 12px;
          background: var(--gt-surface);
        }

        .gc__composerBox {
          display: flex;
          flex-direction: column;
          border: 1px solid var(--gt-outline);
          border-radius: var(--gt-shape-m);
          background: var(--gt-surface);
          transition: border-color .15s, box-shadow .15s;
        }
        .gc__composerBox:focus-within {
          border-color: var(--gt-primary);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--gt-primary) 24%, transparent);
        }

        .gc__textarea {
          display: block;
          width: 100%;
          min-height: 44px;
          max-height: 40vh;
          resize: none;
          border: 0;
          outline: none;
          padding: 10px 12px 4px;
          background: transparent;
          color: var(--gt-on-surface);
          font-size: 13px;
          line-height: 1.5;
          overflow-y: auto;
        }
        .gc__textarea::placeholder { color: var(--gt-outline); }
        .gc__textarea:focus-visible { outline: none; }

        /* Fila inferior: [Context] [Modelo] ··· [tokens] [Enviar] */
        .gc__composerBar {
          container-type: inline-size;
          display: flex;
          align-items: center;
          gap: 2px;
          min-width: 0;
          padding: 4px 6px 6px 4px;
        }

        /* Botón "pill" del composer (contexto y selector de modelo) */
        .gc__pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          min-width: 0;
          height: 28px;
          padding: 0 5px 0 7px;
          border: 1px solid transparent;
          border-radius: var(--gt-shape-s);
          background: transparent;
          color: var(--gt-on-surface-variant);
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
          cursor: pointer;
          flex: 0 0 auto;
          transition: background-color .12s, color .12s, border-color .12s;
        }
        .gc__pill:hover { background: var(--gt-state-hover); color: var(--gt-on-surface); }
        .gc__pill[aria-expanded="true"] {
          background: var(--gt-state-pressed);
          color: var(--gt-on-surface);
        }
        .gc__pill .gc__chev { color: var(--gt-outline); transition: transform .15s var(--gt-motion-standard); }
        .gc__pill[aria-expanded="true"] .gc__chev { transform: rotate(180deg); }

        .gc__pill--model { flex: 0 1 auto; max-width: 100%; }
        .gc__modelName {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: var(--gt-font-mono);
          font-size: 11px;
          font-weight: 400;
        }

        /* En barras estrechas el botón de contexto queda solo con el icono */
        @container (max-width: 290px) {
          .gc__pillLabel { display: none; }
        }
        /* Con el contador de tokens visible se prioriza el nombre del modelo */
        @container (max-width: 360px) {
          .gc__composerBar:has(.gc__tokenEstimate:not([hidden])) .gc__pillLabel { display: none; }
        }

        .gc__providerDot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex: 0 0 auto;
          background: var(--qc-chat-dot, var(--gt-primary));
        }

        .gc__spacer { flex: 1 1 auto; min-width: 4px; }

        .gc__tokenEstimate {
          flex: 0 0 auto;
          padding: 0 4px;
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          color: var(--gt-on-surface-variant);
          white-space: nowrap;
        }
        .gc__tokenEstimate[hidden] { display: none; }
        .gc__tokenEstimate--warn { color: var(--gt-warning); font-weight: 600; }

        /* Botón enviar / detener */
        .gc__sendBtn {
          width: 30px;
          height: 30px;
          padding: 0;
          border: 0;
          border-radius: var(--gt-shape-s);
          background: var(--gt-primary);
          color: var(--gt-on-primary);
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          cursor: pointer;
          transition: background-color .12s, color .12s;
        }
        .gc__sendBtn:hover:not(:disabled) { background: color-mix(in srgb, var(--gt-primary) 92%, var(--gt-on-primary)); }
        .gc__sendBtn:disabled {
          background: var(--gt-state-pressed);
          color: var(--gt-outline);
          cursor: default;
        }
        .gc__sendBtn .gc__stopIcon { display: none; }
        .gc__sendBtn--cancel {
          background: var(--gt-on-surface);
          color: var(--gt-surface);
        }
        .gc__sendBtn--cancel:hover:not(:disabled) { background: var(--gt-on-surface-variant); }
        .gc__sendBtn--cancel .gc__sendIcon { display: none; }
        .gc__sendBtn--cancel .gc__stopIcon { display: grid; }

        /* Confirmación de petición grande: fila compacta de aviso */
        .gc__confirmBar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px 8px;
          padding: 8px 8px 8px 10px;
          border: 1px solid color-mix(in srgb, var(--gt-warning) 30%, transparent);
          border-radius: var(--gt-shape-s);
          background: color-mix(in srgb, var(--gt-warning) 10%, transparent);
          font-size: 12px;
          line-height: 1.45;
          color: var(--gt-on-surface);
        }
        .gc__confirmBar[hidden] { display: none; }
        .gc__confirmBar > .gt-icon { color: var(--gt-warning); }
        .gc__confirmText { flex: 1 1 160px; min-width: 0; }
        .gc__confirmBtns { display: flex; gap: 4px; margin-left: auto; }
        .gc__confirmBtns .gt-btn { height: 28px; padding: 0 10px; font-size: 12px; }

        /* ────────────────────────────────────────
           MENÚS FLOTANTES (contexto, modelo, @)
        ──────────────────────────────────────── */
        .gc__menu {
          position: absolute;
          left: 12px;
          bottom: calc(100% - 4px);
          z-index: 20;
          display: none;
          flex-direction: column;
          width: min(300px, calc(100% - 24px));
          animation: gc__menuIn .12s var(--gt-motion-standard);
        }
        .gc__menu.gc__open { display: flex; }

        .gc__menu--model {
          width: min(320px, calc(100% - 24px));
          max-height: min(420px, calc(100vh - 160px));
          padding: 0;
          overflow: hidden;
        }

        @keyframes gc__menuIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .gc__menuHeader {
          padding: 6px 8px 4px;
          font-size: 11px;
          font-weight: 600;
          color: var(--gt-on-surface-variant);
        }

        .gc__menuItem { gap: 10px; padding: 6px 8px; font-size: 12.5px; }
        .gc__menuItem.gc__active { background: var(--gt-state-hover); }

        /* Item enriquecido: icono en loseta + título + descripción */
        .gc__menuIcon {
          width: 28px;
          height: 28px;
          border-radius: var(--gt-shape-s);
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          color: var(--gt-on-surface-variant);
          background: var(--gt-state-hover);
        }
        .gc__menuItem:hover .gc__menuIcon,
        .gc__menuItem.gc__active .gc__menuIcon,
        .gc__menuItem:focus-visible .gc__menuIcon { color: var(--gt-primary); background: color-mix(in srgb, var(--gt-primary) 12%, transparent); }

        .gc__menuText { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; gap: 1px; }
        .gc__menuTitle {
          display: flex;
          align-items: baseline;
          gap: 8px;
          font-weight: 500;
          white-space: nowrap;
        }
        .gc__menuTag {
          margin-left: auto;
          font-family: var(--gt-font-mono);
          font-size: 10.5px;
          font-weight: 400;
          color: var(--gt-on-surface-variant);
        }
        .gc__menuDesc {
          font-size: 11.5px;
          line-height: 1.35;
          color: var(--gt-on-surface-variant);
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        /* Sin editor disponible: items atenuados + nota explicativa */
        .gc__menuNote {
          display: none;
          align-items: flex-start;
          gap: 6px;
          margin: 4px 4px 2px;
          padding: 6px 8px;
          border-radius: var(--gt-shape-s);
          background: color-mix(in srgb, var(--gt-warning) 10%, transparent);
          color: var(--gt-on-surface-variant);
          font-size: 11.5px;
          line-height: 1.4;
        }
        .gc__menuNote .gt-icon { color: var(--gt-warning); margin-top: 1px; }
        .gc__menu--unavailable .gc__menuNote { display: flex; }
        .gc__menu--unavailable .gc__menuItem--ctx .gc__menuIcon { color: var(--gt-outline); }

        /* Selector de modelo: lista con scroll + cabeceras de grupo fijas */
        .gc__menuScroll {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 0 4px 4px;
        }

        /* Buscador del selector de modelo (fijo arriba, fuera del scroll) */
        .gc__mpSearch {
          flex: 0 0 auto;
          position: relative;
          display: flex;
          align-items: center;
          margin: 6px 6px 2px;
        }
        .gc__mpSearchIcon {
          position: absolute;
          left: 9px;
          display: grid;
          color: var(--gt-outline);
          pointer-events: none;
        }
        .gc__mpSearchInput {
          width: 100%;
          height: 30px;
          padding: 0 28px 0 30px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
          color: var(--gt-on-surface);
          font: inherit;
          font-size: 12.5px;
          outline: none;
        }
        .gc__mpSearchInput::placeholder { color: var(--gt-outline); }
        .gc__mpSearchInput:focus { border-color: var(--gt-primary); box-shadow: 0 0 0 2px var(--gt-primary); }
        .gc__mpSearchInput::-webkit-search-cancel-button { display: none; }
        .gc__mpClear {
          position: absolute;
          right: 4px;
          display: grid;
          place-items: center;
          width: 22px;
          height: 22px;
          padding: 0;
          border: 0;
          border-radius: var(--gt-shape-s);
          background: transparent;
          color: var(--gt-on-surface-variant);
          cursor: pointer;
        }
        .gc__mpClear[hidden] { display: none; }
        .gc__mpClear:hover { background: var(--gt-state-hover); color: var(--gt-on-surface); }
        .gc__mpClear:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--gt-primary); }

        /* Acordeón de proveedores */
        .gc__mpGroup { margin: 0 -4px; padding: 0 4px; }
        .gc__mpGroup + .gc__mpGroup { border-top: 1px solid var(--gt-outline-variant); }
        .gc__mpHead {
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          width: calc(100% + 8px);
          margin: 0 -4px;
          min-height: 32px;
          padding: 6px 12px 6px 10px;
          border: 0;
          background: var(--gt-surface-bright);
          color: var(--gt-on-surface-variant);
          font: inherit;
          font-size: 11.5px;
          font-weight: 600;
          text-align: left;
          cursor: pointer;
        }
        .gc__mpHead:hover { color: var(--gt-on-surface); background: var(--gt-state-hover); }
        .gc__mpHead:focus-visible {
          outline: none;
          color: var(--gt-on-surface);
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
          box-shadow: inset 0 0 0 1px var(--gt-primary);
        }
        .gc__mpGroup--open > .gc__mpHead { color: var(--gt-on-surface); }
        .gc__mpChev {
          display: grid;
          flex: 0 0 auto;
          color: var(--gt-outline);
          transition: transform .16s var(--gt-motion-standard);
        }
        .gc__mpGroup--open > .gc__mpHead .gc__mpChev { transform: rotate(90deg); }
        .gc__mpLabel { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .gc__mpCount {
          flex: 0 0 auto;
          min-width: 18px;
          padding: 0 5px;
          border-radius: 8px;
          background: var(--gt-state-hover);
          color: var(--gt-on-surface-variant);
          font-size: 10.5px;
          font-weight: 500;
          line-height: 16px;
          text-align: center;
        }
        .gc__menuGroupMeta {
          margin-left: auto;
          flex: 0 0 auto;
          font-size: 11px;
          font-weight: 500;
          color: var(--gt-on-surface-variant);
        }
        .gc__menuGroupMeta--ok { color: var(--gt-success); }

        /* Cuerpo plegable: transición de alto (grid 0fr → 1fr) + opacidad */
        .gc__mpBody {
          display: grid;
          grid-template-rows: 0fr;
          opacity: 0;
          transition: grid-template-rows .16s var(--gt-motion-standard), opacity .12s linear;
        }
        .gc__mpGroup--open > .gc__mpBody { grid-template-rows: 1fr; opacity: 1; }
        .gc__mpBodyInner { min-height: 0; overflow: hidden; }
        .gc__mpGroup--open > .gc__mpBody > .gc__mpBodyInner { padding-bottom: 4px; }

        .gc__mpMark {
          padding: 0 1px;
          border-radius: 2px;
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
          color: inherit;
          box-shadow: inset 0 -1px 0 var(--gt-primary);
        }
        .gc__mpEmpty {
          padding: 18px 12px;
          text-align: center;
          font-size: 12px;
          color: var(--gt-on-surface-variant);
          overflow-wrap: anywhere;
        }

        .gc__menuItem--model { min-height: 30px; padding: 4px 8px 4px 10px; gap: 8px; }
        .gc__menuModel {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-family: var(--gt-font-mono);
          font-size: 11.5px;
        }
        .gc__menuCheck { width: 14px; flex: 0 0 auto; color: var(--gt-primary); visibility: hidden; }
        .gc__menuItem[aria-checked="true"] .gc__menuCheck { visibility: visible; }
        .gc__menuItem[aria-checked="true"] { color: var(--gt-primary); }
        .gc__menuItem--muted { color: var(--gt-on-surface-variant); font-style: italic; }

        .gc__menuFooter {
          flex: 0 0 auto;
          padding: 4px;
          border-top: 1px solid var(--gt-outline-variant);
        }
        .gc__menuFooter .gc__menuItem { color: var(--gt-on-surface-variant); gap: 8px; }
        .gc__menuFooter .gc__menuItem:hover { color: var(--gt-on-surface); }

        /* ────────────────────────────────────────
           SETTINGS (vista a panel completo)
        ──────────────────────────────────────── */
        .gc__settings {
          position: absolute;
          inset: 0;
          z-index: 30;
          display: none;
          flex-direction: column;
          overflow: hidden;
          background: var(--gt-surface);
          animation: gc__fadeIn .14s var(--gt-motion-standard);
        }
        .gc__settings.gc__open { display: flex; }

        @keyframes gc__fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .gc__settingsHeader {
          display: flex;
          align-items: center;
          gap: 10px;
          height: 48px;
          padding: 0 16px;
          border-bottom: 1px solid var(--gt-outline-variant);
          background: var(--gt-surface);
          flex: 0 0 auto;
        }
        .gc__settingsTitle {
          font-size: 14px;
          font-weight: 600;
          color: var(--gt-on-surface);
        }

        .gc__settingsBody {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 14px 14px 24px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .gc__section {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px 14px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-container);
          transition: border-color .15s;
        }
        .gc__section:first-child { border-top: 1px solid var(--gt-outline-variant); }
        .gc__section[hidden] { display: none; }

        .gc__sectionHead { display: flex; align-items: baseline; gap: 8px; }
        .gc__sectionLabel {
          margin: 0;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: .05em;
          text-transform: uppercase;
          color: var(--gt-on-surface-variant);
        }
        .gc__sectionScope {
          margin-left: auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-size: 11.5px;
          color: var(--gt-on-surface-variant);
        }

        .gc__settingsField { display: flex; flex-direction: column; gap: 6px; }
        .gc__settingsField[hidden] { display: none; }

        .gc__fieldLabel {
          display: flex;
          align-items: center;
          gap: 6px;
          min-height: 18px;
          font-size: 12px;
          font-weight: 500;
          color: var(--gt-on-surface);
        }

        .gc__fieldHint {
          margin: 0;
          font-size: 11.5px;
          line-height: 1.45;
          color: var(--gt-on-surface-variant);
        }
        .gc__fieldHint strong { font-weight: 600; color: var(--gt-on-surface); }

        /* Lista de proveedores: cuadrícula compacta y limpia (2 columnas) */
        .gc__providerList {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 6px;
        }

        .gc__provCard {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 38px;
          padding: 6px 10px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
          color: var(--gt-on-surface);
          text-align: left;
          cursor: pointer;
          transition: border-color .12s, background-color .12s, box-shadow .12s;
        }
        .gc__provCard:hover {
          background: var(--gt-state-hover);
          border-color: var(--gt-outline);
        }
        .gc__provCard[aria-checked="true"] {
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
          border-color: var(--gt-primary);
          box-shadow: 0 0 0 1px var(--gt-primary);
        }
        .gc__provCard[aria-checked="true"]::before {
          content: "";
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 3px;
          border-radius: var(--gt-shape-s) 0 0 var(--gt-shape-s);
          background: var(--gt-primary);
        }
        .gc__provCard:focus-visible { outline-offset: -2px; }

        .gc__provText {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-width: 0;
          flex: 1 1 auto;
          gap: 4px;
        }
        .gc__provName {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        .gc__provStatusDot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          flex: 0 0 auto;
        }
        .gc__provStatusDot--ok { background: var(--gt-success); }
        .gc__provStatusDot--none { background: var(--gt-outline); }
        .gc__provStatusDot--local { background: var(--gt-primary); }

        /* Banner informativo del proveedor actualmente seleccionado */
        .gc__activeProvBanner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 10px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
          border: 1px solid var(--gt-outline-variant);
          font-size: 11.5px;
        }
        .gc__activeProvBannerInfo {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          flex: 1 1 auto;
        }
        .gc__activeProvBannerTitle {
          font-weight: 600;
          color: var(--gt-on-surface);
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .gc__activeProvBannerDesc {
          color: var(--gt-on-surface-variant);
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        /* Insignias de estado */
        .gc__badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          flex: 0 0 auto;
          height: 20px;
          padding: 0 7px;
          border-radius: 10px;
          font-size: 10.5px;
          font-weight: 600;
          white-space: nowrap;
          color: var(--gt-on-surface-variant);
          background: var(--gt-state-hover);
        }
        .gc__badge::before {
          content: "";
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          opacity: .8;
        }
        .gc__badge--ok { color: var(--gt-success); background: color-mix(in srgb, var(--gt-success) 12%, transparent); }
        .gc__badge--local { color: var(--gt-primary); background: color-mix(in srgb, var(--gt-primary) 12%, transparent); }
        .gc__badge--none { color: var(--gt-on-surface-variant); }
        .gc__badge--warn { color: var(--gt-warning); background: color-mix(in srgb, var(--gt-warning) 10%, transparent); }

        /* Campos: base .gt-input / .gt-select; aquí solo ajustes propios. */
        .gc__select { font-family: var(--gt-font-mono); font-size: 12px; }
        .gc__textareaCfg { min-height: 112px; padding: 8px 10px; font-size: 12.5px; }
        .gc__textInput--mono { font-family: var(--gt-font-mono); font-size: 12px; }
        .gc__textInput--mono::placeholder { font-family: var(--gt-font-plain); font-size: 12.5px; }

        .gc__inputRow { display: flex; align-items: center; gap: 6px; }
        .gc__inputRow .gc__textInput { flex: 1 1 auto; }

        .gt-iconBtn { width: 36px; height: 36px; }

        /* Chips de modelos personalizados */
        .gc__chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .gc__chips:empty { display: none; }
        .gc__chip {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          max-width: 100%;
          height: 26px;
          padding: 0 2px 0 9px;
          border: 1px solid var(--gt-outline);
          border-radius: 13px;
          background: var(--gt-surface-container);
          font-family: var(--gt-font-mono);
          font-size: 11.5px;
        }
        .gc__chipText { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .gc__chipRemove {
          width: 20px;
          height: 20px;
          padding: 0;
          border: 0;
          border-radius: 50%;
          background: transparent;
          color: var(--gt-on-surface-variant);
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          cursor: pointer;
        }
        .gc__chipRemove:hover { background: color-mix(in srgb, var(--gt-error) 8%, transparent); color: var(--gt-error); }

        /* Estado de la API key */
        .gc__keyStatus { display: flex; align-items: center; gap: 8px; min-height: 22px; }

        .gc__linkBtn {
          height: 22px;
          padding: 0 4px;
          border: 0;
          border-radius: var(--gt-shape-xs);
          background: transparent;
          color: var(--gt-primary);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
        }
        .gc__linkBtn:hover { text-decoration: underline; text-underline-offset: 2px; }
        .gc__linkBtn--danger { color: var(--gt-error); }
        .gc__linkBtn--icon {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: auto;
          font-size: 11px;
        }
        .gc__spinning svg {
          animation: gc__spin .75s linear infinite;
        }
        @keyframes gc__spin {
          100% { transform: rotate(360deg); }
        }
        .gc__linkBtn[hidden] { display: none; }
        .gc__fieldLabel .gc__linkBtn { margin-left: auto; }

        /* Estado del fetch de modelos */
        .gc__fetchStatus {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 6px;
          padding: 6px 10px;
          border-radius: var(--gt-shape-s);
          font-size: 11.5px;
          line-height: 1.4;
          font-weight: 500;
          transition: opacity .3s ease;
        }
        .gc__fetchStatus[hidden] { display: none; }
        .gc__fetchStatus--loading {
          background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
          color: var(--gt-primary);
        }
        .gc__fetchStatus--loading .gc__fetchStatusDot {
          width: 7px; height: 7px;
          border-radius: 50%;
          background: var(--gt-primary);
          animation: gc__fetchPulse 1s ease-in-out infinite;
          flex-shrink: 0;
        }
        @keyframes gc__fetchPulse {
          0%,100% { opacity: 1; transform: scale(1); }
          50% { opacity: .4; transform: scale(.75); }
        }
        .gc__fetchStatus--success {
          background: color-mix(in srgb, var(--gt-success) 12%, transparent);
          color: var(--gt-success);
        }
        .gc__fetchStatus--info {
          background: color-mix(in srgb, var(--gt-on-surface-variant) 10%, transparent);
          color: var(--gt-on-surface-variant);
        }
        .gc__fetchStatus--error {
          background: var(--gt-error-container);
          color: var(--gt-on-error-container);
        }

        .gc__tempValue {
          margin-left: auto;
          min-width: 32px;
          padding: 1px 6px;
          border-radius: var(--gt-shape-xs);
          background: var(--gt-state-hover);
          font-family: var(--gt-font-mono);
          font-size: 11.5px;
          font-variant-numeric: tabular-nums;
          text-align: center;
          color: var(--gt-on-surface);
        }

        .gc__sliderWrap { display: flex; align-items: center; gap: 10px; height: 24px; }
        .gc__sliderEdge { font-size: 11px; color: var(--gt-on-surface-variant); flex: 0 0 auto; }

        .gc__slider {
          flex: 1 1 auto;
          min-width: 0;
          height: 4px;
          border-radius: 4px;
          background: linear-gradient(to right, var(--gt-primary) 0 var(--qc-chat-fill, 30%), var(--gt-state-pressed) var(--qc-chat-fill, 30%) 100%);
          appearance: none;
          -webkit-appearance: none;
          outline: none;
          cursor: pointer;
        }
        .gc__slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--gt-primary);
          border: 2px solid var(--gt-surface);
          box-shadow: 0 0 0 1px var(--gt-primary);
        }
        .gc__slider:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px color-mix(in srgb, var(--gt-primary) 24%, transparent); }

        .gc__settingsFooter {
          flex: 0 0 auto;
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 16px;
          border-top: 1px solid var(--gt-outline-variant);
          background: var(--gt-surface);
        }
        .gc__settingsFooter .gt-btn { height: 34px; min-width: 84px; }

        /* ────────────────────────────────────────
           MODO AGENT: toggle, "Editing…" y tarjeta de cambios
        ──────────────────────────────────────── */
        .gc__modeSeg {
          display: inline-flex;
          flex: 0 0 auto;
          align-items: center;
          gap: 1px;
          height: 24px;
          margin: 0 4px 0 2px;
          padding: 2px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-state-hover);
        }
        .gc__modeOpt {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 20px;
          padding: 0 7px;
          border: 0;
          border-radius: var(--gt-shape-xs);
          background: transparent;
          color: var(--gt-on-surface-variant);
          font-size: 11.5px;
          font-weight: 500;
          white-space: nowrap;
          cursor: pointer;
          transition: background-color .12s, color .12s, box-shadow .12s;
        }
        .gc__modeOpt:hover { color: var(--gt-on-surface); }
        .gc__modeOpt[aria-checked="true"] {
          background: var(--gt-surface-bright);
          color: var(--gt-on-surface);
          box-shadow: 0 0 0 1px var(--gt-outline), 0 1px 2px rgba(0,0,0,.12);
        }
        .gc__modeOpt[data-mode="agent"][aria-checked="true"] { color: var(--gt-primary); }
        .gc__modeOpt .gt-icon { opacity: .9; }
        /* Barras estrechas: el toggle queda solo con iconos */
        /* Con el toggle Ask|Agent el espacio se prioriza para el modelo */
        @container (max-width: 400px) {
          .gc__pillLabel { display: none; }
          .gc__modeOpt .gt-icon { display: none; }
        }
        @container (max-width: 250px) {
          .gc__modeOpt span { display: none; }
          .gc__modeOpt .gt-icon { display: block; }
          .gc__modeOpt { padding: 0 5px; }
        }

        .gc__spinner {
          width: 12px;
          height: 12px;
          flex: 0 0 auto;
          border-radius: 50%;
          border: 1.5px solid var(--gt-outline);
          border-top-color: var(--gt-primary);
          animation: gc__spin .8s linear infinite;
        }

        .gc__editingList { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
        .gc__assistantBody > .gc__editingList:first-child { margin-top: 0; }
        .gc__editingRow {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          height: 30px;
          padding: 0 10px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-container);
          font-size: 12px;
          color: var(--gt-on-surface-variant);
        }
        .gc__editingRow--card { border: 0; background: transparent; }
        .gc__editingLabel { flex: 0 0 auto; }
        .gc__editingPath {
          display: flex;
          align-items: baseline;
          gap: 6px;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          font-family: var(--gt-font-mono);
          font-size: 11.5px;
          color: var(--gt-on-surface);
        }

        .gc__changes {
          margin-top: 10px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-m);
          background: var(--gt-surface-container);
          overflow: hidden;
        }
        .gc__chHead {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px 8px 12px;
          border-bottom: 1px solid var(--gt-outline-variant);
        }
        .gc__chTitle { font-size: 12.5px; font-weight: 600; color: var(--gt-on-surface); }
        .gc__chTotals, .gc__chStat {
          display: inline-flex;
          gap: 5px;
          font-family: var(--gt-font-mono);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        .gc__chAdd { color: var(--gt-success); }
        .gc__chDel { color: var(--gt-error); }

        .gc__chList { list-style: none; margin: 0; padding: 4px; }
        .gc__chRow {
          border-radius: var(--gt-shape-s);
          transition: background-color .12s;
        }
        .gc__chRow:hover { background: var(--gt-state-hover); }
        .gc__chRow[data-focus="true"] { background: color-mix(in srgb, var(--gt-primary) 12%, transparent); }
        .gc__chMain {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          min-height: 32px;
          padding: 2px 4px 2px 8px;
        }
        .gc__chIcon { color: var(--gt-outline); }
        .gc__chPath {
          display: flex;
          align-items: baseline;
          gap: 6px;
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
        }
        .gc__chBase {
          flex: 0 0 auto;
          max-width: 100%;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          font-family: var(--gt-font-mono);
          font-size: 12px;
          color: var(--gt-on-surface);
        }
        .gc__chDir {
          flex: 1 1 0;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          direction: rtl;
          text-align: left;
          font-size: 11px;
          color: var(--gt-on-surface-variant);
        }
        .gc__chStat { flex: 0 0 auto; }
        .gc__chActions { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
        .gc__chTip { display: inline-flex; }
        .gc__chBtn {
          width: 26px;
          height: 26px;
          padding: 0;
          display: grid;
          place-items: center;
          border: 0;
          border-radius: var(--gt-shape-s);
          background: transparent;
          color: var(--gt-on-surface-variant);
          cursor: pointer;
          transition: background-color .12s, color .12s;
        }
        .gc__chBtn:hover:not(:disabled) { background: var(--gt-state-pressed); color: var(--gt-on-surface); }
        .gc__chBtn--accept { color: var(--gt-success); }
        .gc__chBtn--accept:hover:not(:disabled) { color: var(--gt-success); background: color-mix(in srgb, var(--gt-success) 12%, transparent); }
        .gc__chBtn--reject:hover:not(:disabled) { color: var(--gt-error); background: color-mix(in srgb, var(--gt-error) 8%, transparent); }
        .gc__chBtn:disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }
        .gc__chRow[data-status="accepted"] .gc__chBase,
        .gc__chRow[data-status="rejected"] .gc__chBase { color: var(--gt-on-surface-variant); }
        .gc__chRow[data-status="rejected"] .gc__chBase { text-decoration: line-through; text-decoration-color: var(--gt-outline); }
        .gc__chRow[data-status="rejected"] .gc__chStat,
        .gc__chRow[data-status="rejected"] .gc__chStat > span { color: var(--gt-on-surface-variant); }
        .gc__chRow[data-status="accepted"] .gc__chIcon { color: var(--gt-success); }
        .gc__chRow[data-status="error"] .gc__chIcon { color: var(--gt-error); }

        .gc__chNote {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 2px 6px;
          margin: 0 6px 6px 30px;
          font-size: 11.5px;
          line-height: 1.4;
          color: var(--gt-warning);
        }
        .gc__chNote .gt-icon { flex: 0 0 auto; }
        .gc__chNote > span { flex: 1 1 0; min-width: 0; }
        .gc__chNote .gc__linkBtn { height: 20px; font-size: 11.5px; }
        .gc__chNote--error { color: var(--gt-error); }
        .gc__chNote--muted { flex-wrap: nowrap; align-items: flex-start; color: var(--gt-on-surface-variant); overflow-wrap: anywhere; }
        .gc__chNote--muted .gt-icon { margin-top: 2px; color: var(--gt-outline); }
        .gc__chNote--muted > span { min-width: 0; }

        .gc__chFoot {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px;
          padding: 8px 10px;
          border-top: 1px solid var(--gt-outline-variant);
        }
        .gc__chFootBtns { display: inline-flex; gap: 6px; margin-left: auto; }
        .gc__chFoot .gt-btn--sm { height: 26px; padding: 0 9px; font-size: 11.5px; gap: 5px; }
        .gc__chFoot .gt-btn:disabled { opacity: .5; cursor: not-allowed; }
        .gc__chFoot .gt-btn--filled:disabled { pointer-events: none; }
        .gc__chHint {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 0;
          padding: 7px 12px;
          border-top: 1px solid var(--gt-outline-variant);
          font-size: 11px;
          color: var(--gt-on-surface-variant);
        }
        .gc__badge--danger { color: var(--gt-error); background: color-mix(in srgb, var(--gt-error) 8%, transparent); }

        /* ── Pasos del modelo (motor tools) ── */
        .gc__steps { display: flex; flex-direction: column; gap: 4px; }
        .gc__stepsToggle {
          align-self: flex-start;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 22px;
          padding: 0 6px 0 2px;
          border: 0;
          border-radius: var(--gt-shape-s);
          background: transparent;
          color: var(--gt-on-surface-variant);
          font: inherit;
          font-size: 11.5px;
          cursor: pointer;
        }
        .gc__stepsToggle:hover { background: var(--gt-state-hover); color: var(--gt-on-surface); }
        .gc__stepsToggle:focus-visible { outline: 2px solid color-mix(in srgb, var(--gt-primary) 24%, transparent); outline-offset: 1px; }
        .gc__stepsChev { display: grid; place-items: center; transition: transform .12s; }
        .gc__steps[data-open="true"] .gc__stepsChev { transform: rotate(90deg); }
        .gc__stepsCount { font-variant-numeric: tabular-nums; }
        .gc__spinner--xs { width: 10px; height: 10px; margin-left: 2px; }
        .gc__stepList {
          list-style: none;
          margin: 0 0 2px 7px;
          padding: 2px 0 2px 10px;
          border-left: 1px solid var(--gt-outline-variant);
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .gc__step {
          display: flex;
          align-items: flex-start;
          gap: 7px;
          min-width: 0;
          font-size: 12px;
          line-height: 18px;
          color: var(--gt-on-surface-variant);
        }
        .gc__stepIcon { flex: 0 0 auto; display: grid; place-items: center; height: 18px; color: var(--gt-outline); }
        .gc__stepText { min-width: 0; overflow-wrap: anywhere; }
        .gc__stepPath {
          font-family: var(--gt-font-mono);
          font-size: 11px;
          padding: 0 4px;
          border-radius: var(--gt-shape-xs);
          background: color-mix(in srgb, var(--gt-on-surface) 8%, transparent);
          color: var(--gt-on-surface);
        }
        .gc__stepExtra { color: var(--gt-on-surface-variant); }
        .gc__stepFail { color: var(--gt-error); }
        .gc__step--error, .gc__step--error .gc__stepIcon { color: var(--gt-error); }
        .gc__step--working { align-items: center; }
        .gc__step--working .gc__spinner { margin: 0 1px; }

        /* ── Aviso dentro de la tarjeta de cambios (crear archivos) ── */
        .gc__chNotice {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          margin: 0 8px 8px;
          padding: 8px 10px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
          font-size: 12px;
          line-height: 1.45;
          color: var(--gt-on-surface);
        }
        .gc__chNotice--ok { border-color: color-mix(in srgb, var(--gt-success) 30%, transparent); background: color-mix(in srgb, var(--gt-success) 12%, transparent); }
        .gc__chNotice--warn { border-color: color-mix(in srgb, var(--gt-warning) 30%, transparent); background: color-mix(in srgb, var(--gt-warning) 10%, transparent); }
        .gc__chNotice--error { border-color: color-mix(in srgb, var(--gt-error) 28%, transparent); background: color-mix(in srgb, var(--gt-error) 8%, transparent); }
        .gc__chNoticeIcon { flex: 0 0 auto; display: grid; place-items: center; height: 17px; }
        .gc__chNotice--ok .gc__chNoticeIcon { color: var(--gt-success); }
        .gc__chNotice--warn .gc__chNoticeIcon { color: var(--gt-warning); }
        .gc__chNotice--error .gc__chNoticeIcon { color: var(--gt-error); }
        .gc__chNoticeMain { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; }
        .gc__chNoticeHint { font-size: 11.5px; color: var(--gt-on-surface-variant); }
        .gc__chNoticeErr { font-size: 11.5px; color: var(--gt-error); }
        .gc__chLink { color: var(--gt-primary); text-decoration: none; }
        .gc__chLink:hover { text-decoration: underline; }
        .gc__chNoticeActions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
        .gc__chNoticeActions .gt-btn--sm { height: 26px; padding: 0 9px; font-size: 11.5px; gap: 5px; }
        .gc__chNoticeWait { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--gt-on-surface-variant); }

        /* ── Historial de conversaciones ── */
        .gc__history .gc__settingsHeader .gt-btn--sm { height: 26px; padding: 0 9px; font-size: 11.5px; gap: 5px; flex: 0 0 auto; }
        .gc__historyList { padding: 8px; }
        .gc__historyItems { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
        .gc__historyItem {
          display: flex;
          align-items: center;
          gap: 2px;
          padding-right: 4px;
          border-radius: var(--gt-shape-s);
          transition: background-color .12s;
        }
        .gc__historyItem:hover { background: var(--gt-state-hover); }
        .gc__historyItem[data-current="true"] { background: color-mix(in srgb, var(--gt-primary) 12%, transparent); }
        .gc__historyOpen {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 8px 6px 8px 10px;
          border: 0;
          border-radius: var(--gt-shape-s);
          background: transparent;
          color: var(--gt-on-surface);
          font: inherit;
          text-align: left;
          cursor: pointer;
        }
        .gc__historyOpen:focus-visible { outline: 2px solid color-mix(in srgb, var(--gt-primary) 24%, transparent); outline-offset: -2px; }
        .gc__historyIcon { flex: 0 0 auto; display: grid; place-items: center; height: 18px; color: var(--gt-outline); }
        .gc__historyText { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .gc__historyTitle { font-size: 12.5px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .gc__historyMeta { display: flex; gap: 5px; font-size: 11px; color: var(--gt-on-surface-variant); }
        .gc__historyDel { opacity: 0; flex: 0 0 auto; }
        .gc__historyItem:hover .gc__historyDel,
        .gc__historyItem:focus-within .gc__historyDel { opacity: 1; }
        @media (hover: none) { .gc__historyDel { opacity: 1; } }
        .gc__historyEmpty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          padding: 48px 16px;
          text-align: center;
        }
        .gc__historyEmptyTitle { margin: 6px 0 0; font-size: 13px; font-weight: 600; color: var(--gt-on-surface); }
        .gc__historyEmptyText { margin: 0; font-size: 12px; color: var(--gt-on-surface-variant); }

        /* Accesibilidad: sin animaciones si el usuario lo prefiere */
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: .001ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: .001ms !important;
          }
          .gc__thinkingDots span { opacity: .6; }
        }
    `;
  }

  /** Genera el HTML/CSS del panel e inserta en el Shadow DOM. */
  _render() {
    const esc = (s) => DomUtils.escapeHtml(s);
    const t   = (key, fallback) => esc(DomUtils.t(key, fallback));
    const ctxItems = this._mentionItems.map((it) => this._contextItemHtml_(it, 'menuitem')).join('');

    DomUtils.setHTML(
      this.shadowRoot,
      `<div class="gc__shell">

        <!-- ── Header ── -->
        <header class="gc__header" id="gc__header" role="banner">
          <span class="gc__mark" aria-hidden="true">${this._icon_('spark', 13)}</span>
          <div class="gc__title">${t('edChatTitle', 'AI Assistant')}</div>
          <div class="gc__headerActions">
            <button id="gc__historyBtn" class="gt-icon-btn gc__hBtn" type="button" hidden title="${t('edChatHistory', 'History')}" aria-label="${t('edChatHistory', 'History')}">
              ${this._icon_('history')}
            </button>
            <button id="gc__clearBtn" class="gt-icon-btn gc__hBtn" type="button" title="${t('edChatNewChat', 'New chat')}" aria-label="${t('edChatNewChat', 'New chat')}">
              ${this._icon_('newChat')}
            </button>
            <button id="gc__settingsBtn" class="gt-icon-btn gc__hBtn" type="button" title="${t('edChatSettingsTitle', 'Settings')}" aria-label="${t('edChatOpenSettings', 'Open settings')}">
              ${this._icon_('settings')}
            </button>
          </div>
        </header>

        <!-- ── Toast stack (alertas no intrusivas bajo el header) ── -->
        <div id="gc__toastStack" class="gt-toast-stack gc__toastStack" role="region" aria-live="polite" aria-label="${t('edChatToastRegion', 'Notifications')}"></div>

        <!-- ── Lista de mensajes ── -->
        <main id="gc__messages" class="gc__messages" role="log" aria-live="polite" aria-label="${t('edChatConversation', 'Conversation')}">
          ${this._emptyStateHtml_()}
        </main>

        <!-- ── Composer ── -->
        <footer class="gc__composer" id="gc__composer" role="contentinfo">

          <!-- Menú de autocompletado @ (al escribir) -->
          <div id="gc__mentionMenu" class="gt-menu gc__menu gc__mentionMenu" role="listbox" aria-label="${t('edChatContextOptions', 'Context options')}"></div>

          <!-- Menú "Añadir contexto" (botón del composer) -->
          <div id="gc__ctxMenu" class="gt-menu gc__menu gc__menu--ctx" role="menu" aria-label="${t('edChatAddContext', 'Add context')}">
            <div class="gc__menuHeader">${t('edChatAddContext', 'Add context')}</div>
            ${ctxItems}
            <div class="gc__menuNote">${this._icon_('info', 13)}<span>${t('edChatCtxNoEditor', 'No Apps Script editor detected. Tags will be removed when sending.')}</span></div>
          </div>

          <!-- Selector de modelo (se rellena en _renderModelMenu_) -->
          <div id="gc__modelMenu" class="gt-menu gc__menu gc__menu--model" role="menu" aria-label="${t('edChatSelectModel', 'Select model')}"></div>

          <!-- Confirmación de peticiones grandes (control de coste) -->
          <div id="gc__confirmBar" class="gc__confirmBar" role="alertdialog" aria-labelledby="gc__confirmText" hidden>
            ${this._icon_('warn', 14)}
            <span id="gc__confirmText" class="gc__confirmText"></span>
            <div class="gc__confirmBtns">
              <button id="gc__confirmCancel" class="gt-btn gt-btn--outlined" type="button">${t('edChatCancel', 'Cancel')}</button>
              <button id="gc__confirmSend" class="gt-btn gt-btn--filled" type="button">${t('edChatSendAnyway', 'Send anyway')}</button>
            </div>
          </div>

          <div class="gc__composerBox">
            <textarea
              id="gc__chatInput"
              class="gc__textarea"
              rows="1"
              placeholder="${t('edChatInputPlaceholder', 'Ask something… type @ for context')}"
              aria-label="${t('edChatMessageInput', 'Message input')}"
              autocomplete="off"
              spellcheck="true"
            ></textarea>

            <div class="gc__composerBar">
              <div id="gc__modeSeg" class="gc__modeSeg" role="radiogroup" aria-label="${t('edChatMode', 'Chat mode')}">
                <button type="button" class="gc__modeOpt" role="radio" data-mode="ask" aria-checked="false"
                        title="${t('edChatModeAskTitle', 'Ask: answers and code suggestions, no file edits')}">${this._icon_('chat', 13)}<span>${t('edChatModeAsk', 'Ask')}</span></button>
                <button type="button" class="gc__modeOpt" role="radio" data-mode="agent" aria-checked="false"
                        title="${t('edChatModeAgentTitle', 'Agent: edits project files; you review and accept each change')}">${this._icon_('pencil', 13)}<span>${t('edChatModeAgent', 'Agent')}</span></button>
              </div>
              <button id="gc__ctxBtn" class="gc__pill" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="gc__ctxMenu"
                      title="${t('edChatAddContext', 'Add context')}" aria-label="${t('edChatAddContext', 'Add context')}">
                ${this._icon_('at', 15)}<span class="gc__pillLabel">${t('edChatContext', 'Context')}</span>${this._chevron_()}
              </button>
              <button id="gc__modelBtn" class="gc__pill gc__pill--model" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="gc__modelMenu">
                <span id="gc__providerDot" class="gc__providerDot" aria-hidden="true"></span>
                <span id="gc__modelName" class="gc__modelName"></span>${this._chevron_()}
              </button>
              <span class="gc__spacer"></span>
              <span id="gc__tokenEstimate" class="gc__tokenEstimate" aria-live="polite"
                    title="${t('edChatTokenEstimateTitle', 'Estimated tokens for this request (message + context + history, ~4 chars/token)')}" hidden></span>
              <button id="gc__sendBtn" class="gc__sendBtn" type="button" disabled
                      title="${t('edChatSendMessage', 'Send message')}" aria-label="${t('edChatSendMessage', 'Send message')}">
                <span class="gc__sendIcon">${this._icon_('send', 15)}</span>
                <span class="gc__stopIcon">${this._icon_('stop', 14)}</span>
              </button>
            </div>
          </div>
        </footer>

        <!-- ── Settings (vista a panel completo) ── -->
        <div id="gc__settings" class="gc__settings" role="dialog" aria-modal="true" aria-labelledby="gc__settingsTitle">

          <div class="gc__settingsHeader">
            <button id="gc__settingsBack" class="gt-icon-btn gc__settingsBack" type="button" title="${t('edChatBack', 'Back')}" aria-label="${t('edChatCloseSettings', 'Close settings')}">
              ${this._icon_('back')}
            </button>
            <span class="gc__settingsTitle" id="gc__settingsTitle">${t('edChatSettingsTitle', 'Settings')}</span>
          </div>

          <div class="gc__settingsBody">

            <section class="gc__section">
              <div class="gc__sectionHead">
                <h3 class="gc__sectionLabel" id="gc__providerListLabel">${t('edChatProvider', 'Provider')}</h3>
              </div>
              <div id="gc__providerList" class="gc__providerList" role="radiogroup" aria-labelledby="gc__providerListLabel"></div>
              <div id="gc__activeProvBanner" class="gc__activeProvBanner"></div>
            </section>

            <section class="gc__section">
              <div class="gc__sectionHead">
                <h3 class="gc__sectionLabel">${t('edChatModel', 'Model')}</h3>
                <span class="gc__sectionScope" data-scope></span>
              </div>
              <div class="gc__settingsField">
                <div class="gc__fieldLabel">
                  <label for="gc__settingsModelSelect">${t('edChatDefaultModel', 'Default model')}</label>
                  <button id="gc__fetchModelsBtn" class="gc__linkBtn gc__linkBtn--icon" type="button"
                          title="${t('edChatFetchModelsTooltip', 'Fetch latest coding and chat models from provider API')}"
                          aria-label="${t('edChatFetchModels', 'Fetch models')}">
                    ${this._icon_('refresh', 13)}
                    <span id="gc__fetchModelsText">${t('edChatFetchModels', 'Fetch models')}</span>
                  </button>
                </div>
                <select id="gc__settingsModelSelect" class="gt-select gc__select"></select>
                <div id="gc__fetchStatus" class="gc__fetchStatus" hidden aria-live="polite" role="status"></div>
              </div>
              <div class="gc__settingsField">
                <label class="gc__fieldLabel" for="gc__customModelInput">${t('edChatAdditionalModels', 'Additional models')}</label>
                <div id="gc__customModelChips" class="gc__chips" role="list" aria-label="${t('edChatCustomModelsAria', 'Custom models, one per line')}"></div>
                <div class="gc__inputRow">
                  <input id="gc__customModelInput" class="gt-input gc__textInput gc__textInput--mono" type="text" autocomplete="off" spellcheck="false"
                         placeholder="${t('edChatAddModelPlaceholder', 'Model ID, e.g. gpt-4o')}">
                  <button id="gc__addModelBtn" class="gt-icon-btn gt-icon-btn--outlined gc__iconBtn" type="button" title="${t('edChatAddModel', 'Add model')}" aria-label="${t('edChatAddModel', 'Add model')}">
                    ${this._icon_('plus')}
                  </button>
                </div>
                <p class="gc__fieldHint">${t('edChatCustomModelsHint2', 'Added to this provider\'s list in the model picker.')}</p>
              </div>
            </section>

            <section class="gc__section" id="gc__keySection">
              <div class="gc__sectionHead">
                <h3 class="gc__sectionLabel" id="gc__keySectionLabel">${t('edChatApiKey', 'API Key')}</h3>
                <span class="gc__sectionScope" data-scope></span>
              </div>
              <div class="gc__settingsField" id="gc__apiKeyField">
                <label class="gc__fieldLabel" id="gc__apiKeyLabel" for="gc__apiKeyInput">${t('edChatApiKey', 'API Key')}</label>
                <div class="gc__inputRow">
                  <input id="gc__apiKeyInput" class="gt-input gc__textInput gc__textInput--mono" type="password" autocomplete="off" spellcheck="false"
                         aria-labelledby="gc__apiKeyLabel" placeholder="sk-...">
                  <button id="gc__toggleKeyBtn" class="gt-icon-btn gt-icon-btn--outlined gc__iconBtn" type="button" title="${t('edChatShowHideKey', 'Show / hide key')}" aria-label="${t('edChatToggleKey', 'Toggle key visibility')}" aria-pressed="false">
                    ${this._icon_('eye')}
                  </button>
                </div>
                <div class="gc__keyStatus">
                  <span id="gc__keyBadge" class="gc__badge"></span>
                  <button id="gc__clearKeyBtn" class="gc__linkBtn gc__linkBtn--danger" type="button" hidden>${t('edChatRemoveKey', 'Remove saved key')}</button>
                </div>
                <p class="gc__fieldHint">${t('edChatKeyHint', 'Stored by the extension, never exposed to the page. Leave empty to keep the saved key.')}</p>
              </div>
            </section>

            <!-- Endpoint (solo proveedor local / custom) -->
            <section class="gc__section" id="gc__endpointField" hidden>
              <div class="gc__sectionHead">
                <h3 class="gc__sectionLabel">${t('edChatEndpoint', 'Endpoint')}</h3>
              </div>
              <div class="gc__settingsField">
                <label class="gc__fieldLabel" for="gc__endpointUrl">${t('edChatEndpointUrl', 'Endpoint URL')}</label>
                <input id="gc__endpointUrl" class="gt-input gc__textInput gc__textInput--mono" type="url" autocomplete="off" spellcheck="false"
                       placeholder="http://localhost:1234/v1/chat/completions">
                <p class="gc__fieldHint">${t('edChatEndpointHint', 'Full endpoint URL (e.g., LM Studio, Ollama).')}</p>
                <p class="gc__fieldHint">${t('edChatLmStudioHint', 'LM Studio: start the server in Developer → Start Server.')}</p>
              </div>
            </section>

            <section class="gc__section">
              <div class="gc__sectionHead">
                <h3 class="gc__sectionLabel">${t('edChatGeneration', 'Generation')}</h3>
                <span class="gc__sectionScope" data-scope></span>
              </div>
              <div class="gc__settingsField">
                <label class="gc__fieldLabel" for="gc__tempInput">
                  ${t('edChatTemperature', 'Temperature')}
                  <span id="gc__tempVal" class="gc__tempValue">0.3</span>
                </label>
                <div class="gc__sliderWrap">
                  <span class="gc__sliderEdge">${t('edChatPrecise', 'Precise')}</span>
                  <input id="gc__tempInput" class="gc__slider" type="range" min="0" max="1" step="0.1" value="0.3" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.3">
                  <span class="gc__sliderEdge">${t('edChatCreative', 'Creative')}</span>
                </div>
              </div>
              <div class="gc__settingsField">
                <label class="gc__fieldLabel" for="gc__maxTokensInput">
                  ${t('edChatMaxTokens', 'Max output tokens')}
                </label>
                <input id="gc__maxTokensInput" class="gt-input gc__textInput gc__textInput--mono" type="number" min="256" max="8192" step="256"
                       placeholder="${t('edChatMaxTokensPlaceholder', 'Default (auto)')}">
                <p class="gc__fieldHint">${t('edChatMaxTokensHint', 'Limits response length (e.g. 2048, 4096). Leave blank for default.')}</p>
              </div>
              <div class="gc__settingsField">
                <label class="gc__fieldLabel" for="gc__contextWindowInput">
                  ${t('edChatContextWindow', 'Context length (tokens)')}
                </label>
                <input id="gc__contextWindowInput" class="gt-input gc__textInput gc__textInput--mono" type="number" min="1024" step="1024"
                       placeholder="${t('edChatContextWindowPlaceholder', 'Unknown (no limit)')}">
                <p class="gc__fieldHint">${t('edChatContextWindowHint', "Must match the model's context length (LM Studio: Context Length). Bigger requests are trimmed.")}</p>
              </div>
              <div class="gc__settingsField">
                <div class="gc__fieldLabel">
                  <label for="gc__systemPrompt">${t('edChatSystemPrompt', 'System prompt')}</label>
                  <button id="gc__resetPromptBtn" class="gc__linkBtn" type="button">${t('edChatResetDefault', 'Reset to default')}</button>
                </div>
                <textarea id="gc__systemPrompt" class="gt-input gc__textareaCfg" rows="6"></textarea>
              </div>
              <div class="gc__settingsField">
                <label class="gc__fieldLabel" for="gc__agentEngineSelect">${t('edChatAgentEngine', 'Agent engine')}</label>
                <select id="gc__agentEngineSelect" class="gt-select gc__select">
                  <option value="auto">${t('edChatAgentEngineAuto', 'Auto')}</option>
                  <option value="tools">${t('edChatAgentEngineTools', 'Tools (function calling)')}</option>
                  <option value="blocks">${t('edChatAgentEngineBlocks', 'Edit blocks')}</option>
                </select>
                <p class="gc__fieldHint">${t('edChatAgentEngineHint', 'Auto uses tools for OpenAI, Anthropic, Gemini and OpenRouter, and edit blocks for other providers.')}</p>
              </div>
            </section>

          </div><!-- /.gc__settingsBody -->

          <div class="gc__settingsFooter">
            <button id="gc__cancelSettings" class="gt-btn gt-btn--outlined" type="button">${t('edChatCancel', 'Cancel')}</button>
            <button id="gc__saveSettings" class="gt-btn gt-btn--filled" type="button">${t('edChatSave', 'Save')}</button>
          </div>

        </div><!-- /.gc__settings -->

        <!-- ── Historial de conversaciones (vista a panel completo) ── -->
        <div id="gc__history" class="gc__settings gc__history" role="dialog" aria-modal="true" aria-labelledby="gc__historyTitle">
          <div class="gc__settingsHeader">
            <button id="gc__historyBack" class="gt-icon-btn gc__settingsBack" type="button" title="${t('edChatBack', 'Back')}" aria-label="${t('edChatHistoryClose', 'Close history')}">
              ${this._icon_('back')}
            </button>
            <span class="gc__settingsTitle" id="gc__historyTitle">${t('edChatHistory', 'History')}</span>
            <button id="gc__historyNew" class="gt-btn gt-btn--sm gt-btn--outlined" type="button">${this._icon_('plus', 13)}<span>${t('edChatNewChat', 'New chat')}</span></button>
          </div>
          <div id="gc__historyList" class="gc__settingsBody gc__historyList"></div>
        </div><!-- /.gc__history -->

      </div><!-- /.gc__shell -->
    `
    );
    // Base GM3 + CSS propio como hojas adoptadas: se construyen una sola vez por página.
    GasChatPanel._css_ ??= this._styles_();
    GasUi.adopt(this.shadowRoot, GasChatPanel._css_);
  }

  /** Chevron pequeño para los botones con menú. */
  _chevron_() {
    return `<span class="gc__chev">${this._icon_('chevronDown', 12)}</span>`;
  }

  /**
   * HTML de un item de contexto (@selection/@file/@project) con icono,
   * título, tag y descripción de una línea.
   * @param {{tag:string, title:string, hint:string, icon:string}} it
   * @param {string} role
   * @param {string} [extra] Atributos/clases adicionales.
   * @returns {string}
   * @private
   */
  _contextItemHtml_(it, role, extra = '') {
    const esc = (s) => DomUtils.escapeHtml(s);
    return `
          <button type="button" class="gt-menu-item gc__menuItem gc__menuItem--ctx" role="${role}" data-tag="${it.tag}" ${extra}>
            <span class="gc__menuIcon" aria-hidden="true">${this._icon_(it.icon, 15)}</span>
            <span class="gc__menuText">
              <span class="gc__menuTitle">${esc(it.title)}<span class="gc__menuTag">${it.tag}</span></span>
              <span class="gc__menuDesc">${esc(it.hint)}</span>
            </span>
          </button>`;
  }

  /**
   * HTML del estado vacío: título, ayuda y sugerencias que rellenan el composer.
   * @returns {string}
   * @private
   */
  _emptyStateHtml_() {
    const esc = (s) => DomUtils.escapeHtml(s);
    const suggestions = [
      { icon: 'file',      label: DomUtils.t('edChatSuggestExplain', 'Explain the active file'),   prompt: DomUtils.t('edChatSuggestExplainPrompt', '@file Explain what this file does') },
      { icon: 'bug',       label: DomUtils.t('edChatSuggestBugs', 'Find bugs in my selection'),   prompt: DomUtils.t('edChatSuggestBugsPrompt', '@selection Find bugs and suggest fixes') },
      { icon: 'code',      label: DomUtils.t('edChatSuggestFunction', 'Write a function…'),       prompt: DomUtils.t('edChatSuggestFunctionPrompt', 'Write an Apps Script function that ') },
      { icon: 'book',      label: DomUtils.t('edChatSuggestDocs', 'Document the project'),        prompt: DomUtils.t('edChatSuggestDocsPrompt', '@project Write documentation for this project: purpose, files and main functions') },
    ];
    const chips = suggestions.map((s) => `
        <button type="button" class="gc__suggestion" data-prompt="${esc(s.prompt)}">
          <span class="gc__suggestionIcon" aria-hidden="true">${this._icon_(s.icon, 14)}</span><span class="gc__suggestionText">${esc(s.label)}</span>
        </button>`).join('');
    return `
      <div class="gc__empty">
        <div class="gc__emptyMark" aria-hidden="true">${this._icon_('spark', 18)}</div>
        <h2 class="gc__emptyTitle">${esc(DomUtils.t('edChatEmptyTitle', 'How can I help with your Apps Script project?'))}</h2>
        <p class="gc__emptyText">${esc(DomUtils.t('edChatIntroPrefix', 'Ask about your code · Use'))} <span class="gc__kbd">@</span> ${esc(DomUtils.t('edChatIntroSuffix', 'to insert context: selection, file or project'))}</p>
        <div class="gc__suggestions">${chips}</div>
      </div>`;
  }

  /**
   * Fila de etiqueta del asistente ("Assistant · modelo").
   * @param {string} [model]
   * @returns {string}
   * @private
   */
  _assistantMetaHtml_(model) {
    const name = DomUtils.escapeHtml(DomUtils.t('edChatAssistantLabel', 'Assistant'));
    const modelHtml = model
      ? `<span class="gc__metaSep" aria-hidden="true">·</span><span class="gc__assistantModel" title="${DomUtils.escapeHtml(model)}">${DomUtils.escapeHtml(model)}</span>`
      : '';
    return `<div class="gc__assistantMeta"><span class="gc__assistantAvatar" aria-hidden="true">${this._icon_('spark', 11)}</span><span class="gc__assistantName">${name}</span>${modelHtml}</div>`;
  }

  /**
   * Tarjeta de error de una respuesta: título, mensaje, pista opcional
   * (resto de líneas) y botón Reintentar si es el último mensaje.
   * @param {{_error?:string}} m
   * @param {boolean} canRetry
   * @returns {string}
   * @private
   */
  _errorCardHtml_(m, canRetry) {
    const esc = (s) => DomUtils.escapeHtml(s);
    const raw = String(m._error || DomUtils.t('edChatUnknownResponse', 'Empty or unknown response')).trim();
    const [first, ...rest] = raw.split(/\r?\n/);
    const hint = rest.join('\n').trim();
    const retry = canRetry
      ? `<button type="button" class="gt-btn gt-btn--sm gt-btn--outlined" data-action="retry">${this._icon_('retry', 13)}<span>${esc(DomUtils.t('edChatRetry', 'Retry'))}</span></button>`
      : '';
    return `
          <div class="gc__errorCard" role="alert">
            <span class="gc__errorIcon" aria-hidden="true">${this._icon_('error', 16)}</span>
            <div class="gc__errorMain">
              <div class="gc__errorTitle">${esc(DomUtils.t('edChatRequestFailed', 'Request failed'))}</div>
              <div class="gc__errorMsg">${esc(first)}</div>
              ${hint ? `<div class="gc__errorHint">${esc(hint)}</div>` : ''}
              ${retry ? `<div class="gc__errorActions">${retry}</div>` : ''}
            </div>
          </div>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // LISTENERS
  // ──────────────────────────────────────────────────────────────────

  /** Conecta todos los event listeners del panel. */
  _setupListeners() {
    const sr = this.shadowRoot;

    const input       = sr.getElementById('gc__chatInput');
    const apiKeyInput = sr.getElementById('gc__apiKeyInput');
    const customInput = sr.getElementById('gc__customModelInput');

    sr.getElementById('gc__sendBtn')?.addEventListener('click', () => this._handleSendClick());
    input?.addEventListener('keydown', (e) => this._onInputKeyDown(e));
    input?.addEventListener('input', () => this._onInputChange());
    sr.addEventListener('click', (e) => this._onShadowRootClick(e));

    sr.getElementById('gc__clearBtn')?.addEventListener('click', () => this._newChat_());

    // Historial de conversaciones (vista a panel completo).
    sr.getElementById('gc__historyBtn')?.addEventListener('click', () => this._openHistory_());
    sr.getElementById('gc__historyBack')?.addEventListener('click', () => this._closeHistory_());
    sr.getElementById('gc__historyNew')?.addEventListener('click', () => { this._newChat_(); this._closeHistory_(); });
    sr.getElementById('gc__historyList')?.addEventListener('click', (e) => this._onHistoryClick_(e));

    // Menús del composer: contexto y selector de modelo.
    const ctxBtn   = sr.getElementById('gc__ctxBtn');
    const modelBtn = sr.getElementById('gc__modelBtn');
    ctxBtn?.addEventListener('click', () => this._toggleMenu_('ctx'));
    modelBtn?.addEventListener('click', () => this._toggleMenu_('model'));
    for (const btn of [ctxBtn, modelBtn]) {
      btn?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this._openMenu_(btn === ctxBtn ? 'ctx' : 'model');
        }
      });
    }
    sr.getElementById('gc__ctxMenu')?.addEventListener('click', (e) => {
      const item = e.target.closest('.gc__menuItem[data-tag]');
      if (!item) return;
      this._closeMenu_({ focusTrigger: false });
      if (input) this._insertTagAtCursor_(input, item.dataset.tag);
    });
    sr.getElementById('gc__modelMenu')?.addEventListener('click', (e) => this._onModelMenuClick_(e));
    for (const id of ['gc__ctxMenu', 'gc__modelMenu']) {
      sr.getElementById(id)?.addEventListener('keydown', (e) => this._onMenuKeyDown_(e));
    }

    // Toggle Ask | Agent (radiogroup: flechas cambian el modo).
    const modeSeg = sr.getElementById('gc__modeSeg');
    modeSeg?.addEventListener('click', (e) => {
      const opt = e.target.closest('.gc__modeOpt');
      if (opt) this._setMode_(opt.dataset.mode);
    });
    modeSeg?.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      this._setMode_(this._mode_() === 'agent' ? 'ask' : 'agent');
      modeSeg.querySelector('.gc__modeOpt[aria-checked="true"]')?.focus();
    });
    this._syncModeToggle_();

    sr.getElementById('gc__confirmSend')?.addEventListener('click', () => {
      const pending = this._pendingSend;
      this._hideSendConfirm_();
      this._sendMessage({ confirmed: true, ...(pending || {}) });
    });
    sr.getElementById('gc__confirmCancel')?.addEventListener('click', () => {
      this._hideSendConfirm_();
      input?.focus();
    });

    // Settings.
    sr.getElementById('gc__settingsBtn')?.addEventListener('click', () => this._openSettings_());
    sr.getElementById('gc__settingsBack')?.addEventListener('click', () => this._closeSettings_());
    sr.getElementById('gc__cancelSettings')?.addEventListener('click', () => this._closeSettings_());
    sr.getElementById('gc__saveSettings')?.addEventListener('click', () => this._onSettingsSave());
    sr.getElementById('gc__toggleKeyBtn')?.addEventListener('click', () => this._onToggleKeyClick());
    sr.getElementById('gc__tempInput')?.addEventListener('input', () => this._onTempInput());
    sr.getElementById('gc__clearKeyBtn')?.addEventListener('click', () => this._onClearKeyClick_());
    sr.getElementById('gc__resetPromptBtn')?.addEventListener('click', () => {
      const prompt = sr.getElementById('gc__systemPrompt');
      if (prompt) { prompt.value = GasChatPanel.DEFAULT_SYSTEM_PROMPT; prompt.focus(); }
    });
    sr.getElementById('gc__fetchModelsBtn')?.addEventListener('click', () => this._onFetchModelsClick_());
    sr.getElementById('gc__addModelBtn')?.addEventListener('click', () => this._addCustomModel_());
    customInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._addCustomModel_(); }
    });
    sr.getElementById('gc__customModelChips')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.gc__chipRemove');
      if (btn) this._removeCustomModel_(btn.dataset.model);
    });

    const providerList = sr.getElementById('gc__providerList');
    providerList?.addEventListener('click', (e) => {
      const card = e.target.closest('.gc__provCard');
      if (card) this._selectSettingsProvider_(card.dataset.provider);
    });
    providerList?.addEventListener('keydown', (e) => this._onProviderListKeyDown_(e));

    sr.getElementById('gc__messages')?.addEventListener('click', (e) => this._onMessagesClick(e));
    apiKeyInput?.addEventListener('input', () => {
      // Escribir una key nueva anula la eliminación pendiente.
      if (apiKeyInput.value && this._apiKeyRemovalFor) {
        this._apiKeyRemovalFor = null;
        this._syncKeyStatus_(this._settingsProvider);
      }
    });
    // `window` keydown y `document` pointerdown se registran en connectedCallback.
  }

  /** Maneja las teclas en el input de chat. */
  _onInputKeyDown(e) {
    if (this._isStreaming && e.key === 'Escape') {
      e.preventDefault();
      this._cancelRequest();
      return;
    }
    if (e.key === 'Escape' && this._isSendConfirmOpen_()) {
      e.preventDefault();
      e.stopPropagation();
      this._hideSendConfirm_();
      return;
    }
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (menu?.classList.contains('gc__open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._navigateMention_(1);  return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this._navigateMention_(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this._selectMention_(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); this._hideMentionMenu_(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._sendMessage();
    }
  }

  /** Maneja el click en el botón de enviar: envía o cancela. */
  _handleSendClick() {
    if (this._isStreaming) {
      this._cancelRequest();
    } else {
      this._sendMessage();
    }
  }

  /** Cancela la solicitud en curso. */
  _cancelRequest() {
    const turn = this._toolTurn;
    if (turn) {
      // Motor tools: se aborta la petición en curso y se conserva lo propuesto.
      turn.cancelled = true;
      if (turn.requestId) {
        document.dispatchEvent(new CustomEvent('GAS_LLM_CANCEL', {
          detail: JSON.stringify({ requestId: turn.requestId }),
        }));
      }
      turn.abort.abort();
      this._finishToolsTurn_(turn, { final: '' });
      this._appendSystemNotice_(DomUtils.t('edChatRequestCancelled', 'Request cancelled'));
      return;
    }
    if (!this._isStreaming || !this._currentRequestId) return;
    // Aborta el stream en curso en el background (el error `aborted` posterior se ignora).
    document.dispatchEvent(new CustomEvent('GAS_LLM_CANCEL', {
      detail: JSON.stringify({ requestId: this._currentRequestId }),
    }));
    // Se conserva en el historial lo recibido hasta el momento.
    const partial = this._stream?.text || '';
    this._finishStream_(partial ? { role: 'assistant', content: partial } : null);
    this._appendSystemNotice_(DomUtils.t('edChatRequestCancelled', 'Request cancelled'));
  }

  /** Auto-resize del textarea y detección del menú @. */
  _onInputChange() {
    const input = this.shadowRoot.getElementById('gc__chatInput');
    if (!input) return;
    // Crece con el contenido hasta ~40% del alto del panel.
    const maxHeight = Math.max(120, Math.round((this.clientHeight || 600) * 0.4));
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, maxHeight) + 'px';
    this._updateSendButton_();
    this._detectMention_(input);
    // El contenido cambió: la confirmación pendiente ya no aplica.
    this._hideSendConfirm_();
    this._refreshTokenEstimate_();
  }

  /** Cierra el menú @ al hacer clic fuera. */
  _onShadowRootClick(e) {
    const input = this.shadowRoot.getElementById('gc__chatInput');
    if (!e.target.closest('.gc__mentionMenu') && e.target !== input) {
      this._hideMentionMenu_();
    }
  }

  /**
   * Cierra el menú abierto (contexto/modelo) si el puntero se pulsa fuera
   * del menú y de su botón disparador.
   * @param {PointerEvent} e
   */
  _onDocPointerDown(e) {
    if (!this._openMenu) return;
    const { menu, trigger } = this._menuEls_(this._openMenu);
    const path = e.composedPath();
    if (path.includes(menu) || path.includes(trigger)) return;
    this._closeMenu_({ focusTrigger: false });
  }

  /** Maneja clics en los mensajes: sugerencias, reintento y botones de código. */
  _onMessagesClick(e) {
    // Sugerencias del estado vacío: rellenan el composer sin enviar.
    const suggestion = e.target.closest('.gc__suggestion');
    if (suggestion) {
      const input = this.shadowRoot.getElementById('gc__chatInput');
      if (!input) return;
      input.value = suggestion.dataset.prompt || '';
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event('input'));
      return;
    }
    if (e.target.closest('[data-action="retry"]')) {
      this._retryLast_();
      return;
    }
    const stepsBtn = e.target.closest('[data-steps-toggle]');
    if (stepsBtn) {
      const msg = this._messages.find((m) => String(m._id) === stepsBtn.dataset.stepsToggle);
      if (msg) { msg._stepsOpen = !msg._stepsOpen; this._refreshAssistantMessage_(msg); }
      return;
    }
    const chBtn = e.target.closest('[data-ch]');
    if (chBtn) {
      if (!chBtn.disabled) this._onChangesAction_(chBtn);
      return;
    }
    const btn = e.target.closest('.gc__codeBtn');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const code   = btn.closest('.gc__codeWrap')?.querySelector('.gc__codeBlock')?.textContent || '';
    if (!code) return;
    if (action === 'copy')    this._copyToClipboard_(code, btn);
    if (action === 'insert')  this._insertAtCursor_(code);
    if (action === 'replace') this._replaceSelection_(code);
    if (action === 'apply')   this._applyCodeBlock_(code, btn.closest('.gc__codeWrap'));
  }

  /**
   * Reenvía el último mensaje del usuario tras una respuesta con error
   * (mismo texto y tags; el contexto se vuelve a recolectar).
   * @private
   */
  _retryLast_() {
    if (this._isStreaming || this._isGatheringContext) return;
    const last = this._messages[this._messages.length - 1];
    if (!last?._isError) return;
    let userIdx = -1;
    for (let i = this._messages.length - 2; i >= 0; i--) {
      if (this._messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const prev = this._messages[userIdx];
    this._sendMessage({ text: prev._raw ?? prev.content, replaceFrom: userIdx, display: prev._raw ? prev.content : undefined });
  }

  /**
   * Maneja Escape: cierra menús, la confirmación o settings (en ese orden).
   * El side panel no se cierra con Escape (Chrome gestiona su cierre).
   * @param {KeyboardEvent} e
   */
  _onWindowKeyDown(e) {
    if (e.key !== 'Escape') return;
    const settings = this.shadowRoot.getElementById('gc__settings');
    const history = this.shadowRoot.getElementById('gc__history');
    if (this._openMenu) this._closeMenu_();
    else if (this._isSendConfirmOpen_()) this._hideSendConfirm_();
    else if (settings?.classList.contains('gc__open')) this._closeSettings_();
    else if (history?.classList.contains('gc__open')) this._closeHistory_();
  }

  // ──────────────────────────────────────────────────────────────────
  // HISTORIAL DE CONVERSACIONES
  // ──────────────────────────────────────────────────────────────────

  /** Limpia el estado de la conversación actual (sin tocar el composer). */
  _resetChatState_() {
    this._chatSeq++;
    this._scheduleSave_.cancel();
    this._messages = [];
    this._conversationId = null;
    this._previewSet = null;
    this._hideSendConfirm_();
  }

  /** "New chat": guarda la conversación actual y empieza una nueva (nuevo id). */
  _newChat_() {
    if (this._isStreaming) this._cancelRequest();
    // Guardado inmediato de lo pendiente antes de soltar la conversación.
    this._saveConversation_();
    this._resetChatState_();
    this._renderMessages_();
    this._updateTokenEstimate_();
    this.shadowRoot.getElementById('gc__chatInput')?.focus();
  }

  /** Muestra el botón de historial solo si el host aporta un store. */
  _syncHistoryButton_() {
    const btn = this.shadowRoot?.getElementById('gc__historyBtn');
    if (btn) btn.hidden = !this._host.store;
  }

  /**
   * Guarda la conversación actual en el historial del proyecto. Se omite
   * mientras hay un turno en curso (al terminar se vuelve a agendar).
   * @private
   */
  async _saveConversation_() {
    const store = this._host.store;
    if (!store || this._isStreaming || !this._messages.length) return;
    const seq = this._chatSeq;
    const messages = this._messages.map(({ _running: _r, _stepsOpen: _o, ...rest }) => rest);
    try {
      const entry = await store.save(this._host.scriptId, { id: this._conversationId || undefined, messages });
      if (entry && seq === this._chatSeq) this._conversationId = entry.id;
    } catch (err) {
      console.warn('[GASTools] Chat history save failed:', err);
    }
  }

  /**
   * Prepara un mensaje guardado para mostrarlo: id nuevo y ChangeSet en
   * solo lectura (los archivos `stale` no tienen original/propuesto).
   * @private
   */
  _restoreMessage_(m) {
    const out = { ...m };
    if (out.role === 'assistant') out._id = ++this._msgSeq;
    if (out._changes) {
      out._changes = {
        ...out._changes, loading: false, busy: false, focus: null, notice: null,
        files: (out._changes.files || []).map((f) => ({ ...f, busy: false, failed: Array.isArray(f.failed) ? f.failed : [] })),
      };
    }
    return out;
  }

  /** Abre la vista de historial y la rellena. */
  _openHistory_() {
    this._closeMenu_({ focusTrigger: false });
    const view = this.shadowRoot.getElementById('gc__history');
    if (!view) return;
    view.classList.add('gc__open');
    this._renderHistory_();
    setTimeout(() => this.shadowRoot.getElementById('gc__historyBack')?.focus(), 60);
  }

  /** Cierra la vista de historial. */
  _closeHistory_() {
    const view = this.shadowRoot.getElementById('gc__history');
    if (!view?.classList.contains('gc__open')) return;
    view.classList.remove('gc__open');
    setTimeout(() => this.shadowRoot.getElementById('gc__chatInput')?.focus(), 30);
  }

  /**
   * Tiempo relativo localizado ("5 min ago" / "hace 5 min").
   * @param {number} ts
   * @returns {string}
   * @private
   */
  _relativeTime_(ts) {
    const diff = (Number(ts) || Date.now()) - Date.now();
    const sec = Math.round(diff / 1000);
    let rtf;
    try { rtf = new Intl.RelativeTimeFormat(DomUtils.lang(), { numeric: 'auto', style: 'short' }); }
    catch (_) { return new Date(ts).toLocaleString(); }
    const abs = Math.abs(sec);
    if (abs < 60) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
    return new Date(ts).toLocaleDateString(DomUtils.lang());
  }

  /** Rellena la lista de conversaciones del proyecto (o el estado vacío). */
  async _renderHistory_() {
    const list = this.shadowRoot.getElementById('gc__historyList');
    if (!list) return;
    const esc = (s) => DomUtils.escapeHtml(s);
    const items = this._host.store ? await this._host.store.list(this._host.scriptId) : [];
    if (!items.length) {
      DomUtils.setHTML(list, `
        <div class="gc__historyEmpty">
          <span class="gc__emptyMark" aria-hidden="true">${this._icon_('history', 18)}</span>
          <p class="gc__historyEmptyTitle">${esc(DomUtils.t('edChatHistoryEmpty', 'No saved conversations yet'))}</p>
          <p class="gc__historyEmptyText">${esc(DomUtils.t('edChatHistoryEmptyHint', 'Conversations for this project are saved automatically.'))}</p>
        </div>`);
      return;
    }
    const delLabel = DomUtils.t('edChatHistoryDelete', 'Delete conversation');
    DomUtils.setHTML(list, `<ul class="gc__historyItems" role="list">${items.map((c) => {
      const current = c.id === this._conversationId;
      const count = (c.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').length;
      return `
        <li class="gc__historyItem"${current ? ' data-current="true"' : ''}>
          <button type="button" class="gc__historyOpen" data-history-open="${esc(c.id)}"${current ? ' aria-current="true"' : ''}>
            <span class="gc__historyIcon" aria-hidden="true">${this._icon_('chat', 14)}</span>
            <span class="gc__historyText">
              <span class="gc__historyTitle" title="${esc(c.title || '')}">${esc(c.title || DomUtils.t('edChatNewChat', 'New chat'))}</span>
              <span class="gc__historyMeta">${esc(this._relativeTime_(c.updatedAt))}<span class="gc__metaSep" aria-hidden="true">·</span>${esc(count === 1 ? DomUtils.t('edChatHistoryOneMessage', '1 message') : DomUtils.t('edChatHistoryMessages', '$1 messages', count))}</span>
            </span>
          </button>
          <button type="button" class="gc__chBtn gc__chBtn--reject gc__historyDel" data-history-del="${esc(c.id)}" title="${esc(delLabel)}" aria-label="${esc(`${delLabel}: ${c.title || ''}`)}">${this._icon_('trash', 14)}</button>
        </li>`;
    }).join('')}</ul>`);
  }

  /** Clicks en la lista del historial: abrir o eliminar. */
  async _onHistoryClick_(e) {
    const del = e.target.closest('[data-history-del]');
    if (del) {
      const id = del.dataset.historyDel;
      await this._host.store?.remove(this._host.scriptId, id);
      if (id === this._conversationId) this._conversationId = null;
      this._renderHistory_();
      return;
    }
    const open = e.target.closest('[data-history-open]');
    if (open) this.loadConversation(open.dataset.historyOpen);
  }

  // ──────────────────────────────────────────────────────────────────
  // MENÚS DEL COMPOSER (contexto / modelo)
  // ──────────────────────────────────────────────────────────────────

  /**
   * @param {'ctx'|'model'} kind
   * @returns {{menu:HTMLElement|null, trigger:HTMLElement|null}}
   * @private
   */
  _menuEls_(kind) {
    const sr = this.shadowRoot;
    return kind === 'model'
      ? { menu: sr.getElementById('gc__modelMenu'), trigger: sr.getElementById('gc__modelBtn') }
      : { menu: sr.getElementById('gc__ctxMenu'),   trigger: sr.getElementById('gc__ctxBtn') };
  }

  /** Abre o cierra el menú indicado. */
  _toggleMenu_(kind) {
    if (this._openMenu === kind) this._closeMenu_();
    else this._openMenu_(kind);
  }

  /**
   * Abre un menú anclado encima de su botón y enfoca el item seleccionado.
   * @param {'ctx'|'model'} kind
   * @private
   */
  _openMenu_(kind) {
    if (this._openMenu && this._openMenu !== kind) this._closeMenu_({ focusTrigger: false });
    this._hideMentionMenu_();
    const { menu, trigger } = this._menuEls_(kind);
    if (!menu || !trigger) return;

    if (kind === 'model') this._renderModelMenu_({ reset: true });
    if (kind === 'ctx') this._refreshContextAvailability_();

    menu.classList.add('gc__open');
    trigger.setAttribute('aria-expanded', 'true');
    this._openMenu = kind;
    this._positionMenu_(menu, trigger);

    // Selector de modelo: foco en el buscador y el modelo activo a la vista.
    if (kind === 'model') {
      menu.querySelector('.gc__menuItem[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
      menu.querySelector('.gc__mpSearchInput')?.focus();
      return;
    }

    const items = this._menuItems_(menu);
    const target = menu.querySelector('.gc__menuItem[aria-checked="true"]') || items[0];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Cierra el menú abierto.
   * @param {{focusTrigger?:boolean}} [opts]
   * @private
   */
  _closeMenu_({ focusTrigger = true } = {}) {
    const kind = this._openMenu;
    if (!kind) return;
    const { menu, trigger } = this._menuEls_(kind);
    menu?.classList.remove('gc__open');
    trigger?.setAttribute('aria-expanded', 'false');
    this._openMenu = null;
    if (focusTrigger) trigger?.focus();
  }

  /**
   * Coloca el menú encima del botón, alineado a su borde izquierdo y sin
   * salirse del composer.
   * @private
   */
  _positionMenu_(menu, trigger) {
    const composer = this.shadowRoot.getElementById('gc__composer');
    if (!composer) return;
    const cRect = composer.getBoundingClientRect();
    const tRect = trigger.getBoundingClientRect();
    const gutter = 12;
    const width  = menu.offsetWidth;
    const maxLeft = Math.max(gutter, cRect.width - width - gutter);
    const left = Math.min(Math.max(tRect.left - cRect.left, gutter), maxLeft);
    menu.style.left   = `${Math.round(left)}px`;
    menu.style.bottom = `${Math.round(cRect.bottom - tRect.top + 6)}px`;
  }

  /** Items navegables de un menú. */
  _menuItems_(menu) {
    // En el selector de modelo: cabeceras + modelos de grupos abiertos (los plegados son `inert`).
    return [...menu.querySelectorAll('.gc__mpHead, .gc__menuItem:not([disabled])')]
      .filter((el) => !el.closest('[inert]'));
  }

  /**
   * Teclado del selector de modelo: el buscador forma parte del ciclo de
   * flechas; Escape limpia la búsqueda antes de cerrar; Enter en el buscador
   * elige el primer modelo visible; escribir sobre un item redirige al buscador.
   * @param {KeyboardEvent} e
   * @returns {boolean} true si el evento quedó atendido.
   * @private
   */
  _onModelMenuKeyDown_(e) {
    const menu   = e.currentTarget;
    const input  = menu.querySelector('.gc__mpSearchInput');
    if (!input) return false;
    const active = this.shadowRoot.activeElement;
    const inInput = active === input;
    const stops  = [input, ...this._menuItems_(menu)];
    const idx    = stops.indexOf(active);
    const focusAt = (i) => {
      const el = stops[(i + stops.length) % stops.length];
      el?.focus();
      if (el !== input) el?.scrollIntoView({ block: 'nearest' });
    };

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(idx + 1); return true;
      case 'ArrowUp':   e.preventDefault(); focusAt(idx < 0 ? 0 : idx - 1); return true;
      case 'Home':
      case 'End':
        // En el buscador con texto, Home/End mueven el cursor.
        if (inInput && input.value) return true;
        e.preventDefault();
        focusAt(e.key === 'Home' ? 1 : -1);
        return true;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (input.value) { this._setModelPickerQuery_(''); input.focus(); }
        else this._closeMenu_();
        return true;
      case 'Enter':
        if (!inInput || !input.value.trim()) return false;   // En botones, Enter dispara el click nativo.
        e.preventDefault();
        menu.querySelector('#gc__mpList .gc__menuItem--model[data-model]:not([disabled])')?.click();
        return true;
      default:
        if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
          input.focus();   // El carácter se inserta en el buscador.
          return true;
        }
        return false;
    }
  }

  /** Navegación con teclado dentro de los menús (flechas, Home/End, Escape, Tab). */
  _onMenuKeyDown_(e) {
    if (e.currentTarget.id === 'gc__modelMenu' && this._onModelMenuKeyDown_(e)) return;
    const menu  = e.currentTarget;
    const items = this._menuItems_(menu);
    const idx   = items.indexOf(this.shadowRoot.activeElement);
    const focusAt = (i) => {
      const el = items[(i + items.length) % items.length];
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown')      { e.preventDefault(); focusAt(idx + 1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); focusAt(idx < 0 ? -1 : idx - 1); }
    else if (e.key === 'Home')      { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End')       { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Escape')    { e.preventDefault(); e.stopPropagation(); this._closeMenu_(); }
    else if (e.key === 'Tab')       { this._closeMenu_({ focusTrigger: false }); }
  }

  /** Atenúa los items de contexto si no hay editor de Apps Script disponible. */
  async _refreshContextAvailability_() {
    const menu = this.shadowRoot.getElementById('gc__ctxMenu');
    if (!menu) return;
    // Sin adaptador no se puede saber: se dejan los items normales.
    if (!this._editorAdapter) { menu.classList.remove('gc__menu--unavailable'); return; }
    const available = await this._callAdapter_('isAvailable');
    menu.classList.toggle('gc__menu--unavailable', available === false);
    if (available !== null && this._editorAvailable !== !!available) {
      this._editorAvailable = !!available;
      this._syncModeToggle_();
    }
  }

  /**
   * Lista de modelos de un proveedor (catálogo + personalizados).
   * @param {string} providerId
   * @param {string[]} [customModels] Override (borrador de settings).
   * @returns {string[]}
   * @private
   */
  _modelsFor_(providerId, customModels) {
    const base    = GAS_LLM_PROVIDERS[providerId]?.models || [];
    const provSet = this._getProviderSettings_(providerId);
    const fetched = provSet.fetchedModels || [];
    const custom  = customModels || provSet.customModels || [];
    return [...new Set([...base, ...fetched, ...custom])];
  }

  /**
   * Estado de la key de un proveedor para badges.
   * @param {string} providerId
   * @returns {{kind:'ok'|'none'|'local', label:string}}
   * @private
   */
  _keyState_(providerId) {
    if (providerId === 'custom') return { kind: 'local', label: DomUtils.t('edChatBadgeLocal', 'Local') };
    return this._config.apiKeysSet?.[providerId]
      ? { kind: 'ok',   label: DomUtils.t('edChatBadgeKeySaved', 'Key saved') }
      : { kind: 'none', label: DomUtils.t('edChatBadgeNoKey', 'No key') };
  }

  /**
   * Construye el selector de modelo: buscador fijo + acordeón de proveedores
   * + pie "Manage models…".
   * @param {{reset?:boolean}} [opts] `reset` limpia la búsqueda y expande solo
   *   el proveedor activo (al abrir). Sin él se conserva el estado actual.
   * @private
   */
  _renderModelMenu_({ reset = false } = {}) {
    const menu = this.shadowRoot.getElementById('gc__modelMenu');
    if (!menu) return;
    if (reset || this._modelPickerQuery === undefined) {
      this._modelPickerQuery = '';
      this._modelPickerOpenProvider = GAS_LLM_PROVIDERS[this._config.provider] ? this._config.provider : null;
    }
    // Si el shell ya existe (re-render con el menú abierto) solo se rehace la lista.
    if (!reset && menu.querySelector('.gc__mpSearchInput')) {
      this._renderModelList_();
      return;
    }
    const esc = (s) => DomUtils.escapeHtml(s);
    const placeholder = esc(DomUtils.t('edChatSearchModels', 'Search models…'));
    const clearLabel  = esc(DomUtils.t('edChatClearSearch', 'Clear search'));
    DomUtils.setHTML(menu, `
        <div class="gc__mpSearch">
          <span class="gc__mpSearchIcon" aria-hidden="true">${this._icon_('search', 14)}</span>
          <input type="search" class="gc__mpSearchInput" placeholder="${placeholder}" aria-label="${placeholder}"
                 autocomplete="off" spellcheck="false" aria-controls="gc__mpList">
          <button type="button" class="gc__mpClear" title="${clearLabel}" aria-label="${clearLabel}" hidden>${this._icon_('close', 13)}</button>
        </div>
        <div class="gc__menuScroll" id="gc__mpList"></div>
        <div class="gc__menuFooter">
          <button type="button" class="gt-menu-item gc__menuItem" role="menuitem" data-action="manage">
            ${this._icon_('sliders', 15)}<span>${esc(DomUtils.t('edChatManageModels', 'Manage models…'))}</span>
          </button>
        </div>`);
    const input = menu.querySelector('.gc__mpSearchInput');
    input.value = this._modelPickerQuery;
    input.addEventListener('input', () => this._setModelPickerQuery_(input.value));
    this._renderModelList_();
  }

  /**
   * Resalta (con `<mark>`) la primera aparición de `query` (en minúsculas)
   * dentro de `text`. Devuelve HTML escapado.
   * @private
   */
  _highlightMatch_(text, query) {
    const esc = (s) => DomUtils.escapeHtml(s);
    const i = query ? text.toLowerCase().indexOf(query) : -1;
    if (i < 0) return esc(text);
    const end = i + query.length;
    return `${esc(text.slice(0, i))}<mark class="gc__mpMark">${esc(text.slice(i, end))}</mark>${esc(text.slice(end))}`;
  }

  /** Renderiza los grupos de proveedores según la búsqueda o el acordeón. */
  _renderModelList_() {
    const sr   = this.shadowRoot;
    const list = sr.getElementById('gc__mpList');
    if (!list) return;
    const esc = (s) => DomUtils.escapeHtml(s);
    const raw = (this._modelPickerQuery || '').trim();
    const q   = raw.toLowerCase();
    const searching = q.length > 0;

    const clear = sr.querySelector('#gc__modelMenu .gc__mpClear');
    if (clear) clear.hidden = !this._modelPickerQuery;

    const groups = Object.entries(GAS_LLM_PROVIDERS).map(([id, p]) => {
      const all = this._modelsFor_(id);
      const labelMatch = searching && p.label.toLowerCase().includes(q);
      // Si coincide el nombre del proveedor se muestran todos sus modelos.
      const models = !searching || labelMatch ? all : all.filter((m) => m.toLowerCase().includes(q));
      if (searching && !labelMatch && !models.length) return '';

      const open    = searching || id === this._modelPickerOpenProvider;
      const state   = this._keyState_(id);
      const metaCls = state.kind === 'ok' ? ' gc__menuGroupMeta--ok' : '';
      const items = models.length
        ? models.map((m) => {
          const checked = id === this._config.provider && m === this._config.model;
          return `
            <button type="button" class="gt-menu-item gc__menuItem gc__menuItem--model" role="menuitemradio" aria-checked="${checked}"
                    data-provider="${id}" data-model="${esc(m)}" title="${esc(`${p.label} · ${m}`)}">
              <span class="gc__menuCheck" aria-hidden="true">${this._icon_('check', 14)}</span>
              <span class="gc__menuModel">${searching ? this._highlightMatch_(m, q) : esc(m)}</span>
            </button>`;
        }).join('')
        : `
            <button type="button" class="gt-menu-item gc__menuItem gc__menuItem--model gc__menuItem--muted" role="menuitem" data-action="manage" data-provider="${id}">
              <span class="gc__menuCheck" aria-hidden="true"></span>
              <span class="gc__menuModel">${esc(DomUtils.t('edChatSetUpProvider', 'Set up in Settings…'))}</span>
            </button>`;
      const countLabel = esc(models.length === 1
        ? DomUtils.t('edChatModelCountOne', '1 model')
        : DomUtils.t('edChatModelCount', '$1 models', models.length));
      return `
          <div class="gc__mpGroup${open ? ' gc__mpGroup--open' : ''}" data-provider="${id}" role="group" aria-labelledby="gc__mg_${id}">
            <button type="button" class="gc__mpHead" id="gc__mg_${id}" data-provider="${id}"
                    aria-expanded="${open}" aria-controls="gc__mb_${id}">
              <span class="gc__mpChev" aria-hidden="true">${this._icon_('chevronRight', 12)}</span>
              <span class="gc__providerDot" style="--qc-chat-dot:${p.color}" aria-hidden="true"></span>
              <span class="gc__mpLabel">${searching ? this._highlightMatch_(p.label, q) : esc(p.label)}</span>
              <span class="gc__mpCount" title="${countLabel}" aria-label="${countLabel}">${models.length}</span>
              <span class="gc__menuGroupMeta${metaCls}">${esc(state.label)}</span>
            </button>
            <div class="gc__mpBody" id="gc__mb_${id}"${open ? '' : ' inert'}>
              <div class="gc__mpBodyInner">${items}</div>
            </div>
          </div>`;
    }).join('');

    const empty = esc(DomUtils.t('edChatNoModelsMatch', 'No models match "$1"', raw));
    DomUtils.setHTML(list, groups || `<div class="gc__mpEmpty" role="status">${empty}</div>`);
  }

  /** Actualiza la búsqueda del selector y re-renderiza la lista. */
  _setModelPickerQuery_(value) {
    this._modelPickerQuery = value || '';
    const input = this.shadowRoot.querySelector('#gc__modelMenu .gc__mpSearchInput');
    if (input && input.value !== this._modelPickerQuery) input.value = this._modelPickerQuery;
    this._renderModelList_();
    const list = this.shadowRoot.getElementById('gc__mpList');
    if (list) list.scrollTop = 0;
  }

  /**
   * Pliega/despliega un proveedor. Sin búsqueda funciona como acordeón de
   * un único grupo abierto; con búsqueda cada grupo se pliega por separado.
   * Se alternan clases (sin re-render) para que la transición se vea.
   * @param {string} providerId
   * @private
   */
  _toggleModelGroup_(providerId) {
    const list = this.shadowRoot.getElementById('gc__mpList');
    if (!list) return;
    const searching = !!(this._modelPickerQuery || '').trim();
    if (!searching) {
      this._modelPickerOpenProvider = this._modelPickerOpenProvider === providerId ? null : providerId;
    }
    for (const group of list.querySelectorAll('.gc__mpGroup')) {
      const id = group.dataset.provider;
      const wasOpen = group.classList.contains('gc__mpGroup--open');
      const open = searching ? (id === providerId ? !wasOpen : wasOpen) : id === this._modelPickerOpenProvider;
      group.classList.toggle('gc__mpGroup--open', open);
      group.querySelector('.gc__mpHead')?.setAttribute('aria-expanded', String(open));
      group.querySelector('.gc__mpBody')?.toggleAttribute('inert', !open);
    }
    list.querySelector(`.gc__mpHead[data-provider="${providerId}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  /** Click en el selector de modelo: elige modelo, pliega grupo o abre settings. */
  _onModelMenuClick_(e) {
    if (e.target.closest('.gc__mpClear')) {
      this._setModelPickerQuery_('');
      this.shadowRoot.querySelector('#gc__modelMenu .gc__mpSearchInput')?.focus();
      return;
    }
    const head = e.target.closest('.gc__mpHead');
    if (head) {
      this._toggleModelGroup_(head.dataset.provider);
      return;
    }
    const item = e.target.closest('.gc__menuItem');
    if (!item) return;
    if (item.dataset.action === 'manage') {
      this._closeMenu_({ focusTrigger: false });
      this._openSettings_(item.dataset.provider);
      return;
    }
    const { provider, model } = item.dataset;
    if (!provider || !model) return;
    this._config.provider = provider;
    this._config.model    = model;
    this._saveConfig();
    this._closeMenu_();
    this._refreshComposerProviderUI_();
    this._refreshTokenEstimate_();
  }

  // ──────────────────────────────────────────────────────────────────
  // RENDER DE MENSAJES + MARKDOWN
  // ──────────────────────────────────────────────────────────────────

  /**
   * Acceso corto a un elemento del Shadow DOM por id.
   * @param {string} id
   * @returns {HTMLElement|null}
   * @private
   */
  _$(id) {
    return this.shadowRoot.getElementById(id);
  }

  /**
   * Construye el HTML de `<option>` a partir de una lista de modelos.
   * @param {string[]} models
   * @returns {string}
   * @private
   */
  _modelsAsOptions_(models) {
    // Los modelos personalizados los escribe el usuario: escapar siempre.
    return (models || []).map((m) => {
      const safe = DomUtils.escapeHtml(m);
      return `<option value="${safe}">${safe}</option>`;
    }).join('');
  }

  /**
   * Re-renderiza la lista completa de mensajes y hace scroll al final.
   * Solo procesa mensajes user/assistant; los system notices se manejan
   * con `_appendSystemNotice_` y no persisten en `_messages`.
   * Si hay un stream en curso, re-añade su burbuja parcial (o el "thinking").
   * @param {{preserveScroll?:boolean}} [opts] Mantener la posición de scroll actual.
   * @private
   */
  _renderMessages_({ preserveScroll = false } = {}) {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;
    const prevScrollTop = container.scrollTop;

    // Sin mensajes ni stream: estado vacío con sugerencias.
    const isEmpty = !this._messages.length && !this._isStreaming;
    const lastIdx = this._messages.length - 1;

    const html = this._messages.map((m, idx) => {
      if (m.role === 'user') {
        return `<div class="gc__msg--user">${DomUtils.escapeHtml(m.content)}</div>`;
      }
      return `
        <div class="gc__msg--assistant" data-msg-id="${m._id ?? ''}"${m._running ? ' aria-busy="true"' : ''}>
          ${this._assistantInnerHtml_(m, idx, lastIdx)}
        </div>`;
    }).join('');

    DomUtils.setHTML(container, isEmpty ? this._emptyStateHtml_() : html);
    if (this._isStreaming && this._stream?.text) {
      DomUtils.setHTML(this._ensureStreamBubble_(container), this._streamBodyHtml_());
    } else if (this._isStreaming && !this._toolTurn) {
      this._appendThinking_();
    }
    container.scrollTop = preserveScroll ? prevScrollTop : container.scrollHeight;
    this._syncApplyButtons_();
  }

  /**
   * Contenido de un mensaje del asistente: etiqueta, pasos del modelo,
   * texto, tarjeta de cambios y error.
   * @param {object} m
   * @param {number} idx
   * @param {number} lastIdx
   * @returns {string}
   * @private
   */
  _assistantInnerHtml_(m, idx, lastIdx) {
    // Modo Agent: los bloques de edición se muestran como tarjeta de cambios, no como texto.
    const text = m._agent ? this._agentProse_(m.content) : m.content;
    const body = text
      ? `<div class="gc__assistantBody">${this._renderMarkdown_(text)}</div>`
      : '';
    const error = m._isError
      ? this._errorCardHtml_(m, idx === lastIdx && !this._isStreaming)
      : '';
    const changes = m._changes
      ? `<div class="gc__changesSlot" data-msg-id="${m._id}">${this._changesCardHtml_(m)}</div>`
      : '';
    const notice = m._notice
      ? `<div class="gc__notice gc__notice--info" role="status">${this._icon_('info', 14)}<span>${DomUtils.escapeHtml(m._notice)}</span></div>`
      : '';
    // Aviso de recorte por la ventana de contexto del modelo.
    const warning = m._warning
      ? `<div class="gc__notice gc__notice--warn" role="status">${this._icon_('warn', 14)}<span>${DomUtils.escapeHtml(m._warning)}</span></div>`
      : '';
    return `${this._assistantMetaHtml_(m._model)}${notice}${warning}${this._stepsHtml_(m)}${body}${changes}${error}`;
  }

  /** Añade el indicador animado de "pensando" (sin duplicar). */
  _appendThinking_() {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container || container.querySelector('.gc__thinking')) return;
    container.querySelector('.gc__empty')?.remove();

    const div = document.createElement('div');
    div.className = 'gc__thinking';
    div.setAttribute('aria-label', DomUtils.t('edChatThinking', 'AI is thinking'));
    div.setAttribute('role', 'status');
    // Al recolectar contexto aún no hay stream: se usa el modelo activo.
    const model = this._stream?.model || this._config.model;
    DomUtils.setHTML(div, `${this._assistantMetaHtml_(model)}
       <div class="gc__thinkingDots" aria-hidden="true"><span></span><span></span><span></span></div>`);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Muestra un toast no intrusivo bajo el header del panel.
   * @param {string} text
   * @param {'info'|'warn'|'error'|'success'} [kind='info']
   * @param {number} [durationMs=5000]  0 = no auto-cierra.
   * @private
   */
  _showToast_(text, kind = 'info', durationMs = 5000) {
    const stack = this.shadowRoot?.getElementById('gc__toastStack');
    if (!stack) return;
    GasUi.toast(stack, { text, kind, durationMs, closeLabel: DomUtils.t('edChatToastClose', 'Dismiss') });
  }

  /**
   * Muestra un aviso temporal del sistema (errores, "request cancelled",
   * etc.) sin agregarlo al historial de la conversación.
   * @param {string} text
   * @param {'info'|'warn'|'error'|'success'} [kind]
   * @private
   */
  _appendSystemNotice_(text, kind = 'info') {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;
    container.querySelector('.gc__empty')?.remove();
    const safeKind = ['info', 'warn', 'error', 'success'].includes(kind) ? kind : 'info';
    const div = document.createElement('div');
    div.className = `gc__notice gc__notice--${safeKind}`;
    div.setAttribute('role', safeKind === 'error' || safeKind === 'warn' ? 'alert' : 'status');
    DomUtils.setHTML(div, `${this._icon_(safeKind, 14)}<span>${DomUtils.escapeHtml(text)}</span>`);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /** Actualiza el botón Send según si hay una petición en curso. */
  _updateSendButton_() {
    const btn   = this.shadowRoot.getElementById('gc__sendBtn');
    const input = this.shadowRoot.getElementById('gc__chatInput');
    if (!btn) return;
    const hasText = (input?.value || '').trim().length > 0;

    if (this._isStreaming) {
      btn.classList.add('gc__sendBtn--loading');
      btn.classList.add('gc__sendBtn--cancel');
      btn.disabled = false;
      btn.title = DomUtils.t('edChatCancelRequest', 'Cancel request');
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.classList.remove('gc__sendBtn--loading');
      btn.classList.remove('gc__sendBtn--cancel');
      btn.disabled = !hasText;
      btn.title = DomUtils.t('edChatSendMessage', 'Send message');
      btn.setAttribute('aria-label', btn.title);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // AUTOCOMPLETADO @
  // ──────────────────────────────────────────────────────────────────

  /**
   * Detecta si el cursor está después de "@" y, si es así, abre o actualiza
   * el menú de menciones.
   * @param {HTMLTextAreaElement} input
   * @private
   */
  _detectMention_(input) {
    const cursor = input.selectionStart ?? 0;
    const text   = input.value;
    let atPos    = -1;

    for (let i = cursor - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') { atPos = i; break; }
      if (/\s/.test(ch)) break;
    }

    if (atPos === -1) { this._hideMentionMenu_(); return; }

    // Si el "@" cambió de posición (nuevo trigger), reiniciamos el índice.
    if (this._mentionStart !== atPos) this._mentionIndex = 0;

    this._mentionStart = atPos;
    this._mentionQuery = text.slice(atPos + 1, cursor).toLowerCase();
    this._showMentionMenu_();
  }

  /** Filtra los items y renderiza el menú flotante de menciones. */
  _showMentionMenu_() {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!menu) return;
    if (this._openMenu) this._closeMenu_({ focusTrigger: false });

    const q = this._mentionQuery;
    const filtered = this._mentionItems.filter(
      (it) => it.tag.toLowerCase().includes(q) || it.label.toLowerCase().includes(q) || it.title.toLowerCase().includes(q)
    );

    if (!filtered.length) { this._hideMentionMenu_(); return; }

    // Mantener el índice dentro de rango tras un filtrado.
    if (this._mentionIndex < 0 || this._mentionIndex >= filtered.length) {
      this._mentionIndex = 0;
    }

    const html = `
      <div class="gc__menuHeader">${DomUtils.escapeHtml(DomUtils.t('edChatAddContext', 'Add context'))}</div>
      ${filtered.map((it, idx) => this._contextItemHtml_(
        { ...it },
        'option',
        `data-index="${idx}" tabindex="-1" aria-selected="${idx === this._mentionIndex}"`
      ).replace('gc__menuItem--ctx', `gc__menuItem--ctx${idx === this._mentionIndex ? ' gc__active' : ''}`)).join('')}`;

    DomUtils.setHTML(menu, html);
    menu.classList.add('gc__open');
    menu.style.left = '12px';
    menu.style.bottom = '';

    menu.onclick = (e) => {
      const btn = e.target.closest('.gc__menuItem');
      if (!btn) return;
      this._insertTagAtCursor_(
        this.shadowRoot.getElementById('gc__chatInput'),
        btn.dataset.tag,
        this._mentionStart
      );
      this._hideMentionMenu_();
    };
  }

  /** Oculta el menú de menciones y resetea su estado. */
  _hideMentionMenu_() {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (menu) { menu.classList.remove('gc__open'); menu.onclick = null; }
    this._mentionStart = -1;
    this._mentionQuery = '';
    this._mentionIndex = -1;
  }

  /**
   * Mueve el item activo del menú de menciones.
   * @param {number} dir - +1 abajo, -1 arriba
   */
  _navigateMention_(dir) {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!menu) return;
    const items = menu.querySelectorAll('.gc__menuItem');
    if (!items.length) return;
    this._mentionIndex = (this._mentionIndex + dir + items.length) % items.length;
    items.forEach((el, i) => {
      el.classList.toggle('gc__active', i === this._mentionIndex);
      el.setAttribute('aria-selected', i === this._mentionIndex);
    });
    items[this._mentionIndex]?.scrollIntoView({ block: 'nearest' });
  }

  /** Inserta el tag del item activo en el textarea y cierra el menú. */
  _selectMention_() {
    const input = this.shadowRoot.getElementById('gc__chatInput');
    const menu  = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!input || !menu) return;
    const tag = menu.querySelector('.gc__menuItem.gc__active')?.dataset.tag;
    if (!tag) return;
    this._insertTagAtCursor_(input, tag, this._mentionStart);
    this._hideMentionMenu_();
  }

  /**
   * Inserta un tag en el textarea, opcionalmente reemplazando desde replaceFrom hasta el cursor.
   * @param {HTMLTextAreaElement} input
   * @param {string} tag
   * @param {number} [replaceFrom]
   */
  _insertTagAtCursor_(input, tag, replaceFrom) {
    const start  = typeof replaceFrom === 'number' && replaceFrom >= 0 ? replaceFrom : (input.selectionStart ?? input.value.length);
    const end    = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after  = input.value.slice(end);
    const sep    = before && !/\s$/.test(before) ? ' ' : '';
    input.value  = before + sep + tag + ' ' + after;
    const caret  = (before + sep + tag + ' ').length;
    input.focus();
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input'));
  }

  // ──────────────────────────────────────────────────────────────────
  // MARKDOWN RENDERER
  // ──────────────────────────────────────────────────────────────────

  /**
   * Renderiza Markdown a HTML seguro delegando en `GasMarkdown`
   * (extension/js/services/markdown-render.js). Si el servicio no se
   * inyectó, cae a texto escapado.
   * @param {string} src
   * @returns {string}
   * @private
   */
  _renderMarkdown_(src) {
    if (typeof GasMarkdown !== 'undefined') return GasMarkdown.render(src);
    return `<p>${DomUtils.escapeHtml(src).replace(/\r?\n/g, '<br>')}</p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // ACCIONES EN BLOQUES DE CÓDIGO
  // ──────────────────────────────────────────────────────────────────

  /**
   * Copia texto al portapapeles con feedback visual en el botón.
   * @param {string} text
   * @param {HTMLButtonElement} btn
   */
  _copyToClipboard_(text, btn) {
    try {
      navigator.clipboard.writeText(text);
      // Solo se cambia la etiqueta (el icono SVG del botón se conserva).
      if (btn.classList.contains('gc__codeBtn--success')) return;
      const label = btn.querySelector('.gc__codeBtnLabel') || btn;
      const original = label.textContent;
      label.textContent = DomUtils.t('edChatCopied', '✓ Copied').replace(/^✓\s*/, '');
      btn.classList.add('gc__codeBtn--success');
      setTimeout(() => {
        label.textContent = original;
        btn.classList.remove('gc__codeBtn--success');
      }, 1400);
    } catch (_) {
      this._appendSystemNotice_(DomUtils.t('edChatCopyFailed', 'Could not copy to clipboard.'), 'error');
    }
  }

  /**
   * Inserta texto en la posición del cursor del editor (vía adaptador).
   * @param {string} text
   */
  async _insertAtCursor_(text) {
    const res = await this._callAdapter_('insertAtCursor', text);
    if (!res?.ok) {
      this._appendSystemNotice_(DomUtils.t('edChatEditorUnavailable', 'Editor not available.'), 'warn');
    }
  }

  /**
   * Reemplaza la selección activa del editor con el texto dado (vía adaptador).
   * @param {string} text
   */
  async _replaceSelection_(text) {
    const res = await this._callAdapter_('replaceSelection', text);
    if (res?.ok) return;
    if (res?.error === 'no-selection') {
      this._appendSystemNotice_(DomUtils.t('edChatNoSelection', 'Select some code in the editor first to replace it.'), 'warn');
    } else {
      this._appendSystemNotice_(DomUtils.t('edChatEditorUnavailable', 'Editor not available.'), 'warn');
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // MODO AGENT: CHANGESET (tarjeta de cambios por archivo)
  // ──────────────────────────────────────────────────────────────────

  /** Prosa de una respuesta del modo Agent (sin bloques de edición). */
  _agentProse_(content) {
    if (typeof GasEditBlocks === 'undefined' || !GasEditBlocks.hasBlocks?.(content)) return content;
    try { return (GasEditBlocks.parse(content).prose || '').trim(); } catch (_) { return content; }
  }

  /**
   * Construye `msg._changes` a partir de los bloques de edición: lee los
   * archivos en un solo viaje, resuelve los hunks y calcula +/−. Varias
   * ediciones al mismo archivo se encadenan (un lote de hunks por bloque).
   * @param {object} msg Mensaje del asistente.
   * @param {Array<{name:string, type?:string}>} projectFiles Lista de `listFiles`.
   * @private
   */
  async _buildChangeSet_(msg, projectFiles) {
    if (typeof GasEditBlocks === 'undefined' || typeof GasEditApplier === 'undefined') return;
    let parsed;
    try { parsed = GasEditBlocks.parse(msg.content); } catch (_) { parsed = null; }
    const blocks = parsed?.files || [];
    // Modelos pequeños ignoran el formato de edición y pegan la función
    // completa en un bloque normal: se intenta convertirla en un ChangeSet.
    if (!blocks.length) return this._buildConvertedChangeSet_(msg);

    msg._changes = { loading: true, files: [], focus: null, busy: false };
    this._refreshChangesCard_(msg, { scroll: true });

    const editNames = [...new Set(blocks
      .filter((bl) => bl.path && bl.action !== 'create')
      .map((bl) => this._resolveFileName_(bl.path, projectFiles)))];
    const reads = await this._readFiles_(editNames);

    const byPath = new Map();
    for (const block of blocks) {
      const kind = block.action === 'create' ? 'create' : 'edit';
      // Bloque sin ruta o `create` truncado (respuesta cortada): no se ofrece.
      if (!block.path || (kind === 'create' && block.partial)) continue;
      const name = kind === 'edit' ? this._resolveFileName_(block.path, projectFiles) : block.path;
      let entry = byPath.get(name);
      if (!entry) {
        entry = { path: block.path, name, kind, original: '', proposed: '', added: 0, removed: 0, failed: [], hunks: 0, status: 'pending', error: '' };
        if (kind === 'edit') Object.assign(entry, { mode: 'hunks', batches: [], fuzzy: 0, key: this._newChangeKey_() });
        byPath.set(name, entry);
        if (kind === 'edit') {
          const res = reads.get(name);
          if (!res?.found) {
            entry.status = 'error';
            entry.error = res?.available === false
              ? DomUtils.t('edChatEditorUnavailable', 'Editor not available.')
              : DomUtils.t('edChatAgentFileNotFound', 'File not found');
            continue;
          }
          entry.name = res.name || name;
          entry.original = res.text || '';
          entry.proposed = entry.original;
          entry.baseVersionId = res.versionId;
        }
      }
      if (entry.status === 'error') continue;
      if (kind === 'create') {
        entry.proposed = String(block.content || '');
        continue;
      }
      const hunks = (Array.isArray(block.hunks) ? block.hunks : [])
        .map((h) => ({ search: String(h?.search ?? ''), replace: String(h?.replace ?? '') }));
      const result = GasEditApplier.resolveHunks(entry.proposed, hunks);
      // Solo los hunks resueltos se guardan para el rebase al aceptar
      const done = new Set(result.edits.map((e) => e.index));
      const ok = hunks.filter((_, i) => done.has(i));
      if (ok.length) entry.batches.push(ok);
      entry.proposed = result.proposed;
      entry.hunks += hunks.length;
      entry.fuzzy += result.edits.filter((e) => e.tier === 'fuzzy').length;
      entry.failed.push(...(result.failed || []));
    }

    for (const entry of byPath.values()) {
      if (entry.status === 'error') continue;
      const s = typeof GasLineDiff !== 'undefined'
        ? GasLineDiff.stats(GasLineDiff.diffLines(entry.original, entry.proposed))
        : { added: 0, removed: 0 };
      entry.added = s.added || 0;
      entry.removed = s.removed || 0;
    }

    msg._changes = byPath.size ? { loading: false, files: [...byPath.values()], focus: null, busy: false } : null;
    if (msg._changes) this._refreshChangesCard_(msg, { scroll: true });
    else this._renderMessages_({ preserveScroll: true });
  }

  /**
   * Lee varios archivos en un solo viaje (`readFiles`); si el adaptador no
   * lo soporta, uno a uno.
   * @param {string[]} names
   * @returns {Promise<Map<string, object|null>>} nombre pedido → `{available, found, name, text, versionId}`.
   * @private
   */
  async _readFiles_(names) {
    const out = new Map();
    if (!names.length) return out;
    const res = await this._callAdapter_('readFiles', names);
    if (res && Array.isArray(res.files)) {
      names.forEach((n, i) => out.set(n, { available: !!res.available, ...(res.files[i] || { found: false }) }));
      return out;
    }
    for (const n of names) out.set(n, await this._callAdapter_('readFile', n));
    return out;
  }

  /** Clave única de un archivo del ChangeSet (idempotencia al aplicar). @private */
  _newChangeKey_() {
    return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Spec de `applyChangeSet`/`previewChanges` de un archivo editable.
   * Sin `mode` (historial antiguo) se trata como archivo completo.
   * @private
   */
  _changeSpec_(f) {
    if (!f.key) f.key = this._newChangeKey_();
    const hunks = f.mode === 'hunks' && Array.isArray(f.batches) && f.batches.length;
    return {
      name: f.name,
      kind: f.kind,
      mode: hunks ? 'hunks' : 'full',
      ...(hunks ? { batches: f.batches } : {}),
      proposed: f.proposed,
      ...(f.baseVersionId != null ? { baseVersionId: f.baseVersionId } : {}),
      key: f.key,
    };
  }

  /**
   * Aplica el resultado de `applyChangeSet` a las entradas del ChangeSet.
   * @returns {boolean} true si todo se aplicó.
   * @private
   */
  _applyChangeResults_(files, res) {
    const byName = new Map((res?.results || []).map((r) => [r.name, r]));
    files.forEach((f) => {
      const r = byName.get(f.name);
      if (!r) return;
      if (r.status === 'applied' || r.status === 'unchanged') {
        f.status = 'accepted';
        f.conflict = null;
      } else if (r.status === 'conflict') {
        f.conflict = { reason: r.reason === 'hunks' ? 'hunks' : 'changed', failed: Array.isArray(r.failed) ? r.failed : [] };
      } else if (r.status === 'not-found') {
        f.status = 'error';
        f.error = DomUtils.t('edChatAgentFileNotFound', 'File not found');
      }
    });
    return !!res?.ok;
  }

  /** Indica si un archivo del ChangeSet se puede aceptar desde el panel. */
  _canAcceptChange_(f) {
    if (f.status !== 'pending' || f.stale) return false;
    if (f.kind === 'create') return typeof GasProjectFiles !== 'undefined' && typeof f.proposed === 'string';
    return f.kind === 'edit' && f.proposed !== f.original;
  }

  /** Archivo editable que se puede abrir en la revisión del editor. */
  _canPreviewChange_(f) {
    return f.status === 'pending' && !f.stale && f.kind === 'edit' && f.proposed !== f.original;
  }

  /**
   * HTML de la tarjeta de cambios de un mensaje del modo Agent.
   * @param {object} msg
   * @returns {string}
   * @private
   */
  _changesCardHtml_(msg) {
    const esc = (s) => DomUtils.escapeHtml(s);
    const t = (k, f, ...a) => esc(DomUtils.t(k, f, ...a));
    const ch = msg._changes;
    if (!ch) return '';

    if (ch.loading) {
      return `<section class="gc__changes" aria-busy="true">
          <div class="gc__editingRow gc__editingRow--card" role="status">
            <span class="gc__spinner" aria-hidden="true"></span>
            <span class="gc__editingLabel">${t('edChatAgentPreparing', 'Preparing changes…')}</span>
          </div>
        </section>`;
    }

    const files = ch.files;
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const title = files.length === 1
      ? t('edChatAgentOneFile', '1 file changed')
      : t('edChatAgentFilesChanged', '$1 files changed', files.length);
    const anyPending = files.some((f) => this._canAcceptChange_(f));
    const anyPreview = files.some((f) => this._canPreviewChange_(f));
    const anyRejectable = files.some((f) => f.status === 'pending' && !f.stale);
    const anyAccepted = files.some((f) => f.status === 'accepted' && f.kind === 'edit' && !f.stale);
    const busy = ch.busy ? ' disabled' : '';

    const rows = files.map((f, i) => this._changeRowHtml_(f, i, ch)).join('');
    const footer = anyRejectable ? `
        <footer class="gc__chFoot">
          <button type="button" class="gt-btn gt-btn--sm gt-btn--outlined" data-ch="review"${anyPreview ? busy : ` disabled title="${t('edChatAgentReviewUnavailable', 'Only edits to existing files can be reviewed in the editor')}"`}>${this._icon_('eye', 13)}<span>${t('edChatAgentReview', 'Review in editor')}</span></button>
          <span class="gc__chFootBtns">
            <button type="button" class="gt-btn gt-btn--sm gt-btn--outlined" data-ch="rejectAll"${busy}>${t('edChatAgentRejectAll', 'Reject all')}</button>
            <button type="button" class="gt-btn gt-btn--sm gt-btn--filled" data-ch="acceptAll"${anyPending ? busy : ' disabled'}>${t('edChatAgentAcceptAll', 'Accept all')}</button>
          </span>
        </footer>` : '';
    const hint = anyAccepted
      ? `<p class="gc__chHint">${this._icon_('info', 12)}<span>${t('edChatAgentUndoHint', 'Use Ctrl+Z in the editor to undo')}</span></p>`
      : '';

    return `<section class="gc__changes" aria-label="${t('edChatAgentChanges', 'Proposed changes')}">
        <header class="gc__chHead">
          <span class="gc__chTitle">${title}</span>
          <span class="gc__chTotals"><span class="gc__chAdd">+${added}</span><span class="gc__chDel">−${removed}</span></span>
        </header>
        <ul class="gc__chList">${rows}</ul>
        ${this._changesNoticeHtml_(ch)}${footer}${hint}
      </section>`;
  }

  /**
   * Fila de un archivo del ChangeSet: icono, ruta, +/−, estado y acciones.
   * @private
   */
  _changeRowHtml_(f, i, ch) {
    const esc = (s) => DomUtils.escapeHtml(s);
    const t = (k, fb, ...a) => esc(DomUtils.t(k, fb, ...a));
    const { base, dir } = this._splitPath_(f.path);
    const isCreate = f.kind === 'create';
    const noChanges = f.status === 'pending' && !isCreate && !f.stale && f.proposed === f.original;

    const badges = {
      accepted: `<span class="gc__badge gc__badge--ok">${t('edChatAgentAccepted', 'Accepted')}</span>`,
      rejected: `<span class="gc__badge gc__badge--none">${t('edChatAgentRejected', 'Rejected')}</span>`,
      error:    `<span class="gc__badge gc__badge--danger">${t('edChatAgentError', 'Error')}</span>`,
    };
    let badge = badges[f.status] || '';
    if (!badge && isCreate && !f.stale) badge = `<span class="gc__badge gc__badge--local">${t('edChatAgentNew', 'New')}</span>`;
    if (!badge && noChanges) badge = `<span class="gc__badge gc__badge--none">${t('edChatAgentNoChanges', 'No changes')}</span>`;
    const live = f.status === 'pending' && !f.stale;
    if (live && f.conflict) badge = `<span class="gc__badge gc__badge--warn">${t('edChatAgentConflict', 'Conflict')}</span>` + badge;
    // Historial: sin contenido no se puede aplicar; solo se informa el estado.
    if (f.stale && f.status === 'pending') badge += `<span class="gc__badge gc__badge--none">${t('edChatAgentNotApplied', 'Not applied')}</span>`;

    let actions = '';
    if (f.status === 'pending' && !f.stale) {
      const busy = ch.busy || f.busy ? ' disabled' : '';
      const canView = !isCreate && !noChanges;
      const canAccept = this._canAcceptChange_(f);
      const acceptLabel = isCreate
        ? t('edChatAgentCreateFile', 'Create file')
        : t('edChatAgentAccept', 'Accept');
      // Deshabilitado: el tooltip explica por qué no se puede aceptar.
      const acceptTip = canAccept ? acceptLabel : (isCreate
        ? t('edChatAgentCreateUnavailable', 'Open the Apps Script editor to create files')
        : t('edChatAgentAcceptUnavailable', 'There are no changes to apply'));
      actions = f.busy
        ? '<span class="gc__spinner" aria-hidden="true"></span>'
        : `<span class="gc__chActions">
            ${canView ? `<button type="button" class="gc__chBtn" data-ch="view" data-i="${i}" title="${t('edChatAgentView', 'View in editor')}" aria-label="${t('edChatAgentView', 'View in editor')}"${busy}>${this._icon_('eye', 14)}</button>` : ''}
            <button type="button" class="gc__chBtn gc__chBtn--reject" data-ch="reject" data-i="${i}" title="${t('edChatAgentReject', 'Reject')}" aria-label="${t('edChatAgentReject', 'Reject')}"${busy}>${this._icon_('close', 14)}</button>
            <span class="gc__chTip" title="${acceptTip}"><button type="button" class="gc__chBtn gc__chBtn--accept" data-ch="accept" data-i="${i}" aria-label="${acceptLabel}"${canAccept ? busy : ' disabled'}>${this._icon_('check', 14)}</button></span>
          </span>`;
    }

    let note = '';
    if (f.status === 'error') {
      note = `<div class="gc__chNote gc__chNote--error">${this._icon_('error', 12)}<span>${esc(f.error || DomUtils.t('edChatAgentApplyFailed', 'Could not apply the changes'))}</span></div>`;
    } else if (live && f.conflict) {
      const n = f.conflict.failed?.length || 0;
      const text = f.conflict.reason === 'hunks' && n
        ? t('edChatAgentConflictHunks', 'File changed: $1 edits no longer match. Review or regenerate.', n)
        : t('edChatAgentConflictChanged', 'File changed, review/regenerate');
      note = `<div class="gc__chNote" role="status">${this._icon_('warn', 12)}<span>${text}</span>
          <button type="button" class="gc__linkBtn" data-ch="fix" data-i="${i}"${this._isStreaming ? ' disabled' : ''}>${t('edChatAgentRegenerate', 'Ask to regenerate')}</button></div>`;
    } else if (f.failed.length && live) {
      const ambiguous = f.failed.filter((x) => x.reason === 'ambiguous').length;
      const detail = ambiguous ? ` · ${t('edChatAgentAmbiguousCount', 'ambiguous: $1', ambiguous)}` : '';
      note = `<div class="gc__chNote">${this._icon_('warn', 12)}<span>${t('edChatAgentHunksFailed', '$1 of $2 edits could not be applied', f.failed.length, f.hunks)}${detail}</span>
          <button type="button" class="gc__linkBtn" data-ch="fix" data-i="${i}"${this._isStreaming ? ' disabled' : ''}>${t('edChatAgentAskFix', 'Ask to fix')}</button></div>`;
    }
    // Hunks localizados de forma aproximada: revisar antes de aceptar.
    if (live && !f.conflict && f.fuzzy > 0) {
      const text = f.fuzzy === 1
        ? t('edChatAgentFuzzyOne', '1 edit matched approximately. Review it before accepting.')
        : t('edChatAgentFuzzyMany', '$1 edits matched approximately. Review them before accepting.', f.fuzzy);
      note += `<div class="gc__chNote gc__chNote--muted">${this._icon_('info', 12)}<span>${text}</span></div>`;
    }

    // Cambio deducido del código de la respuesta (sin bloques de edición).
    if (f.converted) {
      note += `<div class="gc__chNote gc__chNote--muted">${this._icon_('info', 12)}<span>${esc(
        [DomUtils.t('edChatAgentConverted', 'Converted from the code in the answer'), this._unitsSummary_(f.units)].filter(Boolean).join(' · ')
      )}</span></div>`;
    }

    const focus = ch.focus && ch.focus === f.name ? ' data-focus="true"' : '';
    return `<li class="gc__chRow" data-status="${f.status}"${focus}>
        <div class="gc__chMain">
          <span class="gc__chIcon" aria-hidden="true">${this._icon_(isCreate ? 'fileNew' : 'file', 14)}</span>
          <span class="gc__chPath" title="${esc(f.path)}"><span class="gc__chBase">${esc(base)}</span>${dir ? `<span class="gc__chDir">${esc(dir)}</span>` : ''}</span>
          ${f.status !== 'error' ? `<span class="gc__chStat"><span class="gc__chAdd">+${f.added}</span><span class="gc__chDel">−${f.removed}</span></span>` : ''}
          ${badge}${actions}
        </div>${note}
      </li>`;
  }

  /**
   * Re-renderiza solo la tarjeta de cambios de un mensaje (sin tocar el
   * resto de la conversación). Si aún no existe el slot, re-renderiza todo.
   * @private
   */
  _refreshChangesCard_(msg, { scroll = false } = {}) {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container || !this._messages.includes(msg)) return;
    const slot = container.querySelector(`.gc__changesSlot[data-msg-id="${msg._id}"]`);
    if (!slot) {
      this._renderMessages_({ preserveScroll: !scroll || !this._isNearBottom_(container) });
      return;
    }
    const stick = scroll && this._isNearBottom_(container);
    DomUtils.setHTML(slot, this._changesCardHtml_(msg));
    if (stick) container.scrollTop = container.scrollHeight;
    // Estados aceptado/rechazado: se guardan en el historial (con debounce).
    if (!msg._changes?.loading) this._scheduleSave_();
  }

  /** Último mensaje con ChangeSet listo. */
  _latestChangesMessage_() {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const ch = this._messages[i]._changes;
      if (ch && !ch.loading) return this._messages[i];
    }
    return null;
  }

  /** Busca un archivo del ChangeSet por nombre real o ruta del modelo. */
  _findChangeFile_(msg, name) {
    if (!name) return null;
    const files = msg?._changes?.files || [];
    return files.find((f) => f.name === name || f.path === name)
      || files.find((f) => this._resolveFileName_(name, [{ name: f.name }]) === f.name)
      || null;
  }

  /** Resalta la fila del archivo que se está revisando en el editor. */
  _setChangesFocus_(name) {
    const msg = this._latestChangesMessage_();
    if (!msg || msg._changes.focus === name) return;
    msg._changes.focus = name;
    this._refreshChangesCard_(msg);
  }

  /**
   * Clicks en la tarjeta de cambios (`data-ch`).
   * @param {HTMLElement} btn
   * @private
   */
  async _onChangesAction_(btn) {
    const slot = btn.closest('.gc__changesSlot');
    const msg = this._messages.find((m) => String(m._id) === slot?.dataset.msgId);
    const ch = msg?._changes;
    if (!ch || ch.loading) return;
    const file = btn.dataset.i != null ? ch.files[Number(btn.dataset.i)] : null;

    switch (btn.dataset.ch) {
      case 'review': return this._previewChanges_(msg, null);
      case 'view':   return file && this._previewChanges_(msg, file);
      case 'accept':
        if (!file) return;
        await this._acceptChange_(msg, file);
        return this._syncPreviewAfterDecision_(msg, file);
      case 'reject':
        if (file?.status === 'pending') { file.status = 'rejected'; this._refreshChangesCard_(msg); }
        return this._syncPreviewAfterDecision_(msg, file);
      case 'acceptAll': return this._acceptAllChanges_(msg);
      case 'rejectAll':
        ch.files.forEach((f) => { if (f.status === 'pending') f.status = 'rejected'; });
        this._refreshChangesCard_(msg);
        if (this._previewSet?.msgId === msg._id) { this._previewSet = null; this._callAdapter_('closePreview'); }
        return;
      case 'fix': return file && this._askToFix_(file);
      case 'reload':
        ch.notice = null;
        this._refreshChangesCard_(msg);
        return this._callAdapter_('reloadPage');
      case 'connect': return this._connectGoogleAndRetry_(msg);
      case 'dismiss':
        ch.notice = null;
        return this._refreshChangesCard_(msg);
      default: return;
    }
  }

  /**
   * Abre la revisión en el editor con todos los archivos pendientes
   * editables, empezando por `file` (o el primero).
   * @private
   */
  async _previewChanges_(msg, file) {
    const list = msg._changes.files.filter((f) => this._canPreviewChange_(f));
    if (!list.length) return;
    const index = Math.max(0, file ? list.indexOf(file) : 0);
    const res = await this._callAdapter_('previewChanges', list.map((f) => this._changeSpec_(f)), index);
    // Archivos en conflicto: el editor los excluye de la revisión
    const conflicts = Array.isArray(res?.conflicts) ? res.conflicts : [];
    if (conflicts.length) {
      this._applyChangeResults_(list, { results: conflicts.map((c) => ({ ...c, status: 'conflict' })) });
      this._showToast_(DomUtils.t('edChatAgentConflictToast', 'Some files changed after the proposal. Review or regenerate them.'), 'warn', 5000);
    }
    if (!res?.ok) {
      if (!conflicts.length) this._showToast_(DomUtils.t('edChatEditorUnavailable', 'Editor not available.'), 'warn', 4000);
      this._refreshChangesCard_(msg);
      return;
    }
    const shown = list.filter((f) => !conflicts.some((c) => c.name === f.name));
    this._previewSet = { msgId: msg._id, names: shown.map((f) => f.name) };
    msg._changes.focus = (shown.includes(list[index]) ? list[index] : shown[0])?.name || null;
    this._refreshChangesCard_(msg);
  }

  /**
   * Mantiene la vista previa del editor coherente con lo decidido desde la
   * tarjeta del chat: si se revisaba este ChangeSet, pasa al siguiente
   * archivo pendiente o cierra la vista previa cuando ya no queda ninguno.
   * (Aceptar desde la tarjeta cierra la vista previa en el editor al
   * aplicar; aquí se reabre con los pendientes restantes.)
   * @param {object} msg
   * @param {object|null} decidedFile Archivo recién aceptado/rechazado.
   * @private
   */
  async _syncPreviewAfterDecision_(msg, decidedFile) {
    if (this._previewSet?.msgId !== msg._id) return;
    const pending = msg._changes.files.filter((f) => this._canPreviewChange_(f));
    if (!pending.length) {
      this._previewSet = null;
      msg._changes.focus = null;
      await this._callAdapter_('closePreview');
      this._refreshChangesCard_(msg);
      return;
    }
    // Siguiente pendiente después del decidido (en el orden de la tarjeta).
    const all = msg._changes.files;
    const from = decidedFile ? all.indexOf(decidedFile) : -1;
    const next = all.slice(from + 1).find((f) => pending.includes(f)) || pending[0];
    await this._previewChanges_(msg, next);
  }

  /**
   * Aplica un archivo en el editor (deshacible con Ctrl+Z allí).
   * @returns {Promise<boolean>} true si se aplicó.
   * @private
   */
  async _acceptChange_(msg, file, { quiet = false } = {}) {
    if (!this._canAcceptChange_(file) || file.busy) return false;
    if (file.kind === 'create') return this._acceptCreates_(msg, [file], { quiet });
    file.busy = true;
    if (!quiet) this._refreshChangesCard_(msg);
    const ok = await this._applyEditFiles_([file]);
    file.busy = false;
    if (!ok && file.status === 'pending' && !file.conflict) {
      this._showToast_(DomUtils.t('edChatAgentApplyFailedFile', 'Could not apply the changes to $1', file.path), 'error', 4000);
    }
    if (!quiet) this._refreshChangesCard_(msg);
    return file.status === 'accepted';
  }

  /**
   * Aplica archivos editables en un solo viaje, todo o nada (`applyChangeSet`).
   * @param {Array<object>} files
   * @returns {Promise<boolean>} true si todos se aplicaron.
   * @private
   */
  async _applyEditFiles_(files) {
    files.forEach((f) => { f.conflict = null; });
    const res = await this._callAdapter_('applyChangeSet', files.map((f) => this._changeSpec_(f)));
    const ok = this._applyChangeResults_(files, res);
    if (!ok && res?.results?.some((r) => r.status === 'conflict')) {
      this._showToast_(DomUtils.t('edChatAgentConflictToast', 'Some files changed after the proposal. Review or regenerate them.'), 'warn', 5000);
    }
    return ok;
  }

  /**
   * Aplica todos los archivos pendientes: un solo `applyChangeSet` (todo o
   * nada), después los archivos nuevos vía API y por último una sola
   * `closePreview`. Si las ediciones fallan, no se crean archivos.
   */
  async _acceptAllChanges_(msg) {
    const ch = msg._changes;
    if (ch.busy) return;
    ch.busy = true;
    this._refreshChangesCard_(msg);
    const edits = ch.files.filter((f) => f.kind === 'edit' && this._canAcceptChange_(f));
    let editsOk = true;
    if (edits.length) {
      edits.forEach((f) => { f.busy = true; });
      this._refreshChangesCard_(msg);
      editsOk = await this._applyEditFiles_(edits);
      edits.forEach((f) => { f.busy = false; });
      if (!editsOk && !edits.some((f) => f.conflict || f.status === 'error')) {
        this._showToast_(DomUtils.t('edChatAgentApplyAllFailed', 'Could not apply the changes. Nothing was modified.'), 'error', 5000);
      }
      this._refreshChangesCard_(msg);
    }
    const creates = ch.files.filter((f) => f.kind === 'create' && this._canAcceptChange_(f));
    if (editsOk && creates.length) await this._acceptCreates_(msg, creates, { quiet: true });
    ch.busy = false;
    this._previewSet = null;
    ch.focus = null;
    await this._callAdapter_('closePreview');
    this._refreshChangesCard_(msg);
  }

  /**
   * Pide al modelo que corrija los hunks que no se pudieron aplicar o que
   * regenere un archivo en conflicto (con el texto actual del editor).
   */
  async _askToFix_(file) {
    const conflict = file.conflict;
    const failed = conflict ? (conflict.failed || []) : file.failed;
    if (this._isStreaming || this._isGatheringContext || (!conflict && !failed.length)) return;
    if (typeof GasEditBlocks === 'undefined') return;
    let current = file.original;
    if (conflict) {
      const res = await this._callAdapter_('readFile', file.name);
      if (res?.found) current = res.text || '';
    }
    const feedback = failed.length
      ? GasEditBlocks.formatFeedback(failed, current)
      : 'The file changed after your proposal, so the edit was not applied. Read the current content again and resend the edit.';
    if (!feedback) return;
    this._sendMessage({
      text: `File: ${file.path}

${feedback}`,
      display: DomUtils.t('edChatAgentFixDisplay', 'Fix the edits that could not be applied to $1', file.path),
    });
  }

  /**
   * Crea archivos nuevos del ChangeSet con la Apps Script API: guarda el
   * proyecto (la API lee lo guardado) y crea el lote. El resultado se
   * muestra como aviso dentro de la tarjeta (recargar / conectar Google).
   * @param {object} msg
   * @param {Array<object>} files Entradas `kind:'create'` pendientes.
   * @returns {Promise<boolean>} true si se crearon.
   * @private
   */
  async _acceptCreates_(msg, files) {
    const ch = msg._changes;
    const list = files.filter((f) => f.kind === 'create' && this._canAcceptChange_(f) && !f.busy);
    if (!ch || !list.length) return false;
    list.forEach((f) => { f.busy = true; });
    ch.notice = null;
    this._refreshChangesCard_(msg);

    let res;
    try {
      const saved = await this._callAdapter_('saveProject');
      res = saved?.ok
        ? await GasProjectFiles.createFiles({
          scriptId: this._host.scriptId,
          files: list.map((f) => ({ path: f.path, content: f.proposed })),
          sendToBackground: this._host.sendToBackground || (async (_m, fallback = null) => fallback),
        })
        : { ok: false, error: 'save-failed' };
    } catch (err) {
      res = { ok: false, error: `api-error: ${err?.message || err}` };
    }
    list.forEach((f) => { f.busy = false; });

    const error = String(res?.error || '');
    if (res?.ok) {
      list.forEach((f) => { f.status = 'accepted'; });
      ch.notice = { kind: 'created', count: list.length };
    } else if (error === 'auth-required') {
      ch.notice = { kind: 'auth', paths: list.map((f) => f.path) };
    } else if (error === 'exists') {
      const existing = new Set(res.existing || []);
      list.forEach((f) => {
        if (!existing.has(f.path)) return;
        f.status = 'error';
        f.error = DomUtils.t('edChatAgentFileExists', 'File already exists');
      });
    } else if (error === 'no-script-id') {
      ch.notice = { kind: 'error', text: DomUtils.t('edChatAgentNoProject', "Couldn't detect the Apps Script project. Open the project editor in this tab and try again.") };
    } else if (error === 'save-failed') {
      ch.notice = { kind: 'error', text: DomUtils.t('edChatAgentSaveFailed', "Couldn't save the project before creating files. Save it in the editor (Ctrl+S) and try again.") };
    } else {
      ch.notice = { kind: 'error', api: true, text: error.replace(/^api-error:\s*/, '') || DomUtils.t('edChatAgentCreateFailed', "Couldn't create the files") };
    }
    this._refreshChangesCard_(msg);
    return !!res?.ok;
  }

  /** "Connect Google": login interactivo y reintento de los archivos pendientes. */
  async _connectGoogleAndRetry_(msg) {
    const ch = msg._changes;
    const send = this._host.sendToBackground;
    if (!ch || !send || ch.notice?.kind === 'connecting') return;
    const paths = ch.notice?.paths || [];
    ch.notice = { kind: 'connecting', paths };
    this._refreshChangesCard_(msg);
    const auth = await send({ type: 'GOOGLE_AUTHENTICATE' }, null);
    if (!auth?.ok) {
      ch.notice = { kind: 'auth', paths, error: auth?.error || DomUtils.t('edChatAgentAuthFailed', 'Google sign-in failed') };
      this._refreshChangesCard_(msg);
      return;
    }
    ch.notice = null;
    await this._acceptCreates_(msg, ch.files.filter((f) => paths.includes(f.path)));
  }

  /**
   * Aviso dentro de la tarjeta de cambios tras crear archivos (éxito,
   * login de Google requerido o error de la API).
   * @param {object} ch
   * @returns {string}
   * @private
   */
  _changesNoticeHtml_(ch) {
    const n = ch?.notice;
    if (!n) return '';
    const esc = (s) => DomUtils.escapeHtml(s);
    const t = (k, f, ...a) => esc(DomUtils.t(k, f, ...a));
    const url = GasChatPanel.APPS_SCRIPT_API_URL;
    const apiHint = `<span class="gc__chNoticeHint">${t('edChatAgentApiHint', 'The Apps Script API must be enabled at')} <a class="gc__chLink" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.replace(/^https:\/\//, ''))}</a></span>`;
    const box = (kind, icon, body, actions = '') => `<div class="gc__chNotice gc__chNotice--${kind}" role="${kind === 'error' ? 'alert' : 'status'}">
        <span class="gc__chNoticeIcon" aria-hidden="true">${icon}</span>
        <div class="gc__chNoticeMain">${body}${actions ? `<div class="gc__chNoticeActions">${actions}</div>` : ''}</div>
      </div>`;

    if (n.kind === 'created') {
      const text = n.count === 1
        ? t('edChatAgentCreatedOne', 'File created. Reload the editor to see it.')
        : t('edChatAgentCreatedMany', '$1 files created. Reload the editor to see them.', n.count);
      return box('ok', this._icon_('success', 14), `<span>${text}</span>`,
        `<button type="button" class="gt-btn gt-btn--sm gt-btn--filled" data-ch="reload">${this._icon_('refresh', 13)}<span>${t('edChatAgentReload', 'Reload editor')}</span></button>`);
    }
    if (n.kind === 'auth' || n.kind === 'connecting') {
      const connecting = n.kind === 'connecting';
      const btn = connecting
        ? `<span class="gc__chNoticeWait"><span class="gc__spinner" aria-hidden="true"></span>${t('edChatAgentConnecting', 'Waiting for Google sign-in…')}</span>`
        : `<button type="button" class="gt-btn gt-btn--sm gt-btn--filled" data-ch="connect">${this._icon_('google', 13)}<span>${t('edChatAgentConnectGoogle', 'Connect Google')}</span></button>`;
      return box('warn', this._icon_('warn', 14),
        `<span>${t('edChatAgentAuthRequired', 'Connect your Google account to create files in this project.')}</span>${apiHint}${n.error ? `<span class="gc__chNoticeErr">${esc(n.error)}</span>` : ''}`,
        btn);
    }
    return box('error', this._icon_('error', 14),
      `<span>${esc(n.text || '')}</span>${n.api ? apiHint : ''}`,
      `<button type="button" class="gt-btn gt-btn--sm gt-btn--outlined" data-ch="dismiss">${t('edChatToastClose', 'Dismiss')}</button>`);
  }

  // ──────────────────────────────────────────────────────────────────
  // PREVIEW DE BLOQUES DE CÓDIGO EN EL EDITOR
  // ──────────────────────────────────────────────────────────────────

  /**
   * Decide (con caché) si el bloque parece una versión completa del archivo
   * activo, el único caso en el que tiene sentido revisarlo como diff.
   * @param {{name:string, text:string}} file
   * @param {string} code
   * @returns {boolean}
   * @private
   */
  _isPreviewable_(file, code) {
    if (!this._previewCache) this._previewCache = new Map();
    const key = `${file.name}\u0000${file.text.length}\u0000${code}`;
    let ok = this._previewCache.get(key);
    if (ok === undefined) {
      ok = typeof GasLineDiff !== 'undefined' && GasChatContext.isFullFileCandidate(file.text, code, GasLineDiff);
      if (this._previewCache.size > 200) this._previewCache.clear();
      this._previewCache.set(key, ok);
    }
    return ok;
  }

  /**
   * Muestra el botón "Apply" de los bloques de código solo cuando hay un
   * editor con archivo activo. Se evalúa de forma diferida tras renderizar
   * (los bloques de un mensaje en curso se ignoran); sin archivo, oculto.
   * @private
   */
  async _syncApplyButtons_() {
    const container = this.shadowRoot?.getElementById('gc__messages');
    if (!container || !this._editorAdapter) return;
    const pending = () => [...container.querySelectorAll('.gc__codeBtn[data-action="apply"]:not([data-checked])')]
      .filter((b) => !b.closest('[aria-busy="true"]'));
    if (!pending().length) return;
    const seq = this._applySyncSeq = (this._applySyncSeq || 0) + 1;
    const file = await this._callAdapter_('getFile');
    if (seq !== this._applySyncSeq || !file?.available || !file.name) return;
    for (const btn of pending()) {
      const code = btn.closest('.gc__codeWrap')?.querySelector('.gc__codeBlock')?.textContent || '';
      btn.dataset.checked = '1';
      btn.classList.toggle('gc__codeBtn--fits', !!code.trim());
    }
  }

  /**
   * Fusiona un bloque de código con el texto de un archivo (`GasCodeMerge`).
   * @returns {{proposed:string, replaced:string[], added:string[]}|null}
   * @private
   */
  _mergeCode_(text, code) {
    if (typeof GasCodeMerge === 'undefined') return null;
    try { return GasCodeMerge.merge(text, code) || null; } catch (_) { return null; }
  }

  /**
   * Texto "replaces a, b · adds c" de las unidades de código fusionadas.
   * @param {{replaced?:string[], added?:string[]}} [units]
   * @returns {string} Texto sin escapar ('' si no hay unidades).
   * @private
   */
  _unitsSummary_(units) {
    const list = (a) => (Array.isArray(a) ? a.filter(Boolean).join(', ') : '');
    const replaced = list(units?.replaced);
    const added = list(units?.added);
    return [
      replaced && DomUtils.t('edChatUnitsReplaces', 'replaces $1', replaced),
      added && DomUtils.t('edChatUnitsAdds', 'adds $1', added),
    ].filter(Boolean).join(' · ');
  }

  /**
   * Bloques de código cerrados de una respuesta cuyo lenguaje puede ser
   * Apps Script (js/gs/ts o sin lenguaje).
   * @param {string} text
   * @returns {string[]}
   * @private
   */
  _mergeableCodeBlocks_(text) {
    const langs = new Set(['', 'js', 'javascript', 'gs', 'gas', 'ts', 'typescript']);
    const out = [];
    for (const m of String(text || '').matchAll(/```([\w+#.-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/g)) {
      if (langs.has(m[1].trim().toLowerCase()) && m[2].trim()) out.push(m[2]);
    }
    return out;
  }

  /**
   * Fallback del modo Agent: la respuesta no trae bloques de edición ni
   * cambios propuestos, pero sí código. Se fusionan los bloques (en orden)
   * con el archivo activo y, si alguno encaja, se crea un ChangeSet normal
   * marcado como `converted`.
   * @param {object} msg Mensaje del asistente.
   * @private
   */
  async _buildConvertedChangeSet_(msg) {
    if (typeof GasCodeMerge === 'undefined' || msg._changes || msg._isError) return;
    const blocks = this._mergeableCodeBlocks_(msg.content);
    if (!blocks.length) return;
    const file = await this._callAdapter_('getFile');
    if (!file?.available || !file.name || msg._changes || !this._messages.includes(msg)) return;

    const original = file.text || '';
    let proposed = original;
    const replaced = [];
    const added = [];
    const push = (list, names) => (names || []).forEach((n) => { if (!list.includes(n)) list.push(n); });
    for (const code of blocks) {
      const res = this._mergeCode_(proposed, code);
      if (!res) continue;
      proposed = res.proposed;
      push(replaced, res.replaced);
      push(added, res.added);
    }
    if (proposed === original) return;

    const s = typeof GasLineDiff !== 'undefined'
      ? GasLineDiff.stats(GasLineDiff.diffLines(original, proposed))
      : { added: 0, removed: 0 };
    msg._changes = {
      loading: false, focus: null, busy: false,
      files: [{
        path: file.name, name: file.name, kind: 'edit', original, proposed,
        added: s.added || 0, removed: s.removed || 0, failed: [], hunks: 0,
        status: 'pending', error: '', converted: true,
        mode: 'full', baseVersionId: file.versionId, key: this._newChangeKey_(),
        // Una función añadida y luego reescrita cuenta solo como añadida.
        units: { replaced: replaced.filter((n) => !added.includes(n)), added },
      }],
    };
    this._refreshChangesCard_(msg, { scroll: true });
  }

  /**
   * "Apply": fusiona el bloque con el archivo activo (funciones por nombre)
   * y abre el diff en el editor, donde el usuario acepta o rechaza. Si no
   * hay unidades con nombre pero el bloque parece el archivo completo, se
   * revisa como archivo completo.
   * @param {string} code
   * @param {HTMLElement|null} wrap `.gc__codeWrap` del bloque (para el aviso).
   * @private
   */
  async _applyCodeBlock_(code, wrap) {
    const notify = (text, kind) => this._showCodeNotice_(wrap, text, kind);
    const file = await this._callAdapter_('getFile');
    if (!file?.available || !file.name) {
      notify(DomUtils.t('edChatEditorUnavailable', 'Editor not available.'), 'warn');
      return;
    }
    const text = file.text || '';
    const merged = this._mergeCode_(text, code);
    let proposed = null;
    let summary = '';
    if (merged) {
      proposed = merged.proposed;
      summary = this._unitsSummary_(merged);
    } else if (this._isPreviewable_({ name: file.name, text }, code)) {
      proposed = code;
      summary = DomUtils.t('edChatApplyFullFile', 'full version of $1', file.name);
    }
    if (proposed === null) {
      notify(DomUtils.t('edChatApplyNoMatch',
        "Couldn't match this code to functions in $1. Use Insert or Replace instead.", file.name), 'warn');
      return;
    }
    if (proposed === text) {
      notify(DomUtils.t('edChatApplyNoChanges', '$1 already contains this code.', file.name), 'info');
      return;
    }
    const res = await this._callAdapter_('previewChanges', [{ name: file.name, kind: 'edit', proposed }], 0);
    if (!res?.ok) {
      notify(DomUtils.t('edChatEditorUnavailable', 'Editor not available.'), 'warn');
      return;
    }
    // Revisión ajena a los ChangeSets del modo Agent.
    this._previewSet = { msgId: null, source: 'code', names: [file.name] };
    notify(summary
      ? DomUtils.t('edChatApplyOpened', 'Opened in the editor: $1', summary)
      : DomUtils.t('edChatPreviewOpened', 'Review the changes in the editor and accept or reject them.'), 'info');
  }

  /**
   * Aviso fino bajo un bloque de código (resultado de "Apply"). Sustituye
   * al anterior del mismo bloque y se retira solo; sin bloque, usa un toast.
   * @param {HTMLElement|null} wrap
   * @param {string} text
   * @param {'info'|'warn'} [kind]
   * @private
   */
  _showCodeNotice_(wrap, text, kind = 'info') {
    if (!wrap?.isConnected) { this._showToast_(text, kind, 4500); return; }
    const prev = wrap.nextElementSibling;
    if (prev?.classList.contains('gc__codeNotice')) { clearTimeout(prev._timer); prev.remove(); }
    const div = document.createElement('div');
    div.className = `gc__notice gc__notice--${kind === 'warn' ? 'warn' : 'info'} gc__codeNotice`;
    div.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
    DomUtils.setHTML(div, `${this._icon_(kind === 'warn' ? 'warn' : 'info', 14)}<span>${DomUtils.escapeHtml(text)}</span>`);
    wrap.after(div);
    div._timer = setTimeout(() => div.remove(), 8000);
  }

  /**
   * Abre la vista de settings y sincroniza sus campos.
   * @param {string} [providerId] Proveedor a mostrar (por defecto el activo).
   */
  _openSettings_(providerId) {
    this._closeMenu_({ focusTrigger: false });
    this._refreshSettingsUI_(providerId);
    this.shadowRoot.getElementById('gc__settings')?.classList.add('gc__open');
    setTimeout(() => {
      this.shadowRoot.querySelector('.gc__provCard[aria-checked="true"]')?.focus();
    }, 120);
  }

  /** Cierra la vista de settings. */
  _closeSettings_() {
    this.shadowRoot.getElementById('gc__settings')?.classList.remove('gc__open');
    setTimeout(() => {
      this.shadowRoot.getElementById('gc__chatInput')?.focus();
    }, 30);
  }

  /** Sincroniza el botón del selector de modelo con this._config. */
  _refreshComposerProviderUI_() {
    const sr       = this.shadowRoot;
    const nameEl   = sr.getElementById('gc__modelName');
    const btn      = sr.getElementById('gc__modelBtn');
    if (!nameEl || !btn) return;

    const id       = GAS_LLM_PROVIDERS[this._config.provider] ? this._config.provider : 'gemini';
    const provider = GAS_LLM_PROVIDERS[id];
    const model    = this._config.model || this._modelsFor_(id)[0] || '';

    nameEl.textContent = model || DomUtils.t('edChatChooseModel', 'Choose model');
    const label = `${provider.label} · ${model || '—'}`;
    btn.title = label;
    btn.setAttribute('aria-label', `${DomUtils.t('edChatSelectModel', 'Select model')}: ${label}`);
    this._syncProviderDot_(id);
    if (this._openMenu === 'model') this._renderModelMenu_();
  }

  /**
   * Pinta el punto del botón de modelo con el color del proveedor.
   * @param {string} providerId
   * @private
   */
  _syncProviderDot_(providerId) {
    const dot = this.shadowRoot.getElementById('gc__providerDot');
    if (dot) dot.style.setProperty('--qc-chat-dot', GAS_LLM_PROVIDERS[providerId]?.color || '');
  }

  /**
   * Descripción corta de cada proveedor para las tarjetas de settings.
   * @param {string} id
   * @returns {string}
   * @private
   */
  _providerDesc_(id) {
    const map = {
      gemini:     ['edChatProvDescGemini', 'Google AI Studio models'],
      openai:     ['edChatProvDescOpenai', 'GPT-4o, GPT-4.1 and o-series models'],
      anthropic:  ['edChatProvDescAnthropic', 'Claude models'],
      kimi:       ['edChatProvDescKimi', 'Moonshot AI Kimi models'],
      chatllm:    ['edChatProvDescChatllm', 'Abacus.AI ChatLLM models'],
      nvidia:     ['edChatProvDescNvidia', 'Models hosted on NVIDIA NIM'],
      openrouter: ['edChatProvDescOpenrouter', 'Hundreds of models with one key'],
      custom:     ['edChatProvDescCustom', 'LM Studio, Ollama or compatible server'],
    };
    const [key, fallback] = map[id] || ['', ''];
    return key ? DomUtils.t(key, fallback) : '';
  }

  /** Renderiza las tarjetas de proveedor en formato compacto (2 columnas). */
  _renderProviderList_() {
    const list = this.shadowRoot.getElementById('gc__providerList');
    if (!list) return;
    const esc = (s) => DomUtils.escapeHtml(s);
    const html = Object.entries(GAS_LLM_PROVIDERS).map(([id, p]) => {
      const checked = id === this._settingsProvider;
      const state = this._keyState_(id);
      return `
        <button type="button" class="gc__provCard" role="radio" data-provider="${id}"
                aria-checked="${checked}" tabindex="${checked ? 0 : -1}" title="${esc(`${p.label}: ${this._providerDesc_(id)}`)}">
          <span class="gc__provText">
            <span class="gc__provName"><span class="gc__providerDot" style="--qc-chat-dot:${p.color}" aria-hidden="true"></span>${esc(p.label)}</span>
            <span class="gc__provStatusDot gc__provStatusDot--${state.kind}" role="img" aria-label="${esc(state.label)}" title="${esc(state.label)}"></span>
          </span>
        </button>`;
    }).join('');
    DomUtils.setHTML(list, html);
    this._syncActiveProvBanner_();
  }

  /** Sincroniza el banner de información contextual del proveedor en edición. */
  _syncActiveProvBanner_() {
    const banner = this.shadowRoot.getElementById('gc__activeProvBanner');
    if (!banner) return;
    const id = this._settingsProvider;
    const p = GAS_LLM_PROVIDERS[id];
    if (!p) { banner.hidden = true; return; }
    banner.hidden = false;
    const state = this._keyState_(id);
    const esc = (s) => DomUtils.escapeHtml(s);
    DomUtils.setHTML(banner, `
      <div class="gc__activeProvBannerInfo">
        <span class="gc__activeProvBannerTitle">
          <span class="gc__providerDot" style="--qc-chat-dot:${p.color}" aria-hidden="true"></span>
          ${esc(p.label)}
        </span>
        <span class="gc__activeProvBannerDesc">${esc(this._providerDesc_(id))}</span>
      </div>
      <span class="gc__badge gc__badge--${state.kind}">${esc(state.label)}</span>
    `);
  }

  /** Flechas dentro del radiogroup de proveedores: mueven selección y foco. */
  _onProviderListKeyDown_(e) {
    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const ids = Object.keys(GAS_LLM_PROVIDERS);
    const idx = ids.indexOf(this._settingsProvider);
    const next = ids[(idx + keys[e.key] + ids.length) % ids.length];
    this._selectSettingsProvider_(next);
    this.shadowRoot.querySelector(`.gc__provCard[data-provider="${next}"]`)?.focus();
  }

  /**
   * Cambia el proveedor en edición en settings y rellena sus campos.
   * Los cambios no guardados del proveedor anterior se descartan.
   * @param {string} providerId
   * @private
   */
  _selectSettingsProvider_(providerId) {
    if (!GAS_LLM_PROVIDERS[providerId]) return;
    this._settingsProvider = providerId;
    for (const card of this.shadowRoot.querySelectorAll('.gc__provCard')) {
      const on = card.dataset.provider === providerId;
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = on ? 0 : -1;
    }
    this._syncActiveProvBanner_();
    this._onSettingsProviderChange();
  }

  /**
   * Rellena los campos dependientes del proveedor en edición: modelos,
   * API key, endpoint, temperatura, maxTokens y system prompt.
   * @private
   */
  _onSettingsProviderChange() {
    const sr = this.shadowRoot;
    const id = this._settingsProvider;
    const provider = GAS_LLM_PROVIDERS[id];
    const provSettings = this._getProviderSettings_(id);

    // Etiqueta de alcance ("Gemini") en las secciones dependientes.
    for (const el of sr.querySelectorAll('[data-scope]')) el.textContent = provider?.label || id;

    this._draftCustomModels = [...(provSettings.customModels || [])];
    const modelSel = sr.getElementById('gc__settingsModelSelect');
    const preferred = this._config.provider === id ? this._config.model : '';
    this._syncSettingsModels_(preferred);
    if (modelSel && !modelSel.value && preferred) modelSel.value = preferred;

    const customInput = sr.getElementById('gc__customModelInput');
    if (customInput) customInput.value = '';

    // Ocultar el banner de estado del fetch al cambiar de proveedor.
    const fetchStatus = sr.getElementById('gc__fetchStatus');
    if (fetchStatus) { clearTimeout(this._fetchStatusTimer_); fetchStatus.setAttribute('hidden', ''); }

    this._syncApiKeyField_(id);
    const keyLabel = sr.getElementById('gc__apiKeyLabel');
    if (keyLabel) {
      keyLabel.textContent = id === 'custom'
        ? DomUtils.t('edChatKeyOptional', 'API Key (Optional)')
        : DomUtils.t('edChatApiKeyFor', 'API Key — $1', provider?.label || id);
    }

    const tempInput = sr.getElementById('gc__tempInput');
    if (tempInput) tempInput.value = String(provSettings.temperature ?? 0.3);
    this._onTempInput();

    const maxTokensInput = sr.getElementById('gc__maxTokensInput');
    if (maxTokensInput) maxTokensInput.value = provSettings.maxTokens || '';

    const contextWindowInput = sr.getElementById('gc__contextWindowInput');
    if (contextWindowInput) contextWindowInput.value = provSettings.contextWindow || '';

    const systemPrompt = sr.getElementById('gc__systemPrompt');
    if (systemPrompt) systemPrompt.value = provSettings.systemPrompt || '';

    const engineSel = sr.getElementById('gc__agentEngineSelect');
    if (engineSel) engineSel.value = ['tools', 'blocks'].includes(provSettings.agentEngine) ? provSettings.agentEngine : 'auto';

    const endpointUrlInput = sr.getElementById('gc__endpointUrl');
    if (endpointUrlInput) endpointUrlInput.value = provSettings.endpointUrl || '';
    const endpointField = sr.getElementById('gc__endpointField');
    if (endpointField) endpointField.hidden = id !== 'custom';

    this._syncActiveProvBanner_();
  }

  /**
   * Muestra un mensaje de estado en el banner inline de fetch de modelos.
   * @param {'loading'|'success'|'info'|'error'} type
   * @param {string} text
   * @param {number} [autohideMs] Si > 0, oculta el banner tras ese tiempo.
   * @private
   */
  _setFetchStatus_(type, text, autohideMs = 0) {
    const el = this.shadowRoot?.getElementById('gc__fetchStatus');
    if (!el) return;
    clearTimeout(this._fetchStatusTimer_);
    el.removeAttribute('hidden');
    el.className = `gc__fetchStatus gc__fetchStatus--${type}`;
    const dot = type === 'loading' ? '<span class="gc__fetchStatusDot"></span>' : '';
    DomUtils.setHTML(el, `${dot}<span>${DomUtils.escapeHtml(text)}</span>`);
    if (autohideMs > 0) {
      this._fetchStatusTimer_ = setTimeout(() => { el.setAttribute('hidden', ''); }, autohideMs);
    }
  }

  /**
   * Repuebla el select de modelo por defecto y los chips de modelos
   * personalizados a partir del borrador.
   * @param {string} [preferred] Modelo a seleccionar si existe.
   * @private
   */
  _syncSettingsModels_(preferred) {
    const sr = this.shadowRoot;
    const modelSel = sr.getElementById('gc__settingsModelSelect');
    const chips    = sr.getElementById('gc__customModelChips');
    const models   = this._modelsFor_(this._settingsProvider, this._draftCustomModels);
    if (modelSel) {
      const current = preferred || modelSel.value;
      DomUtils.setHTML(modelSel, this._modelsAsOptions_(models));
      modelSel.disabled = !models.length;
      modelSel.value = models.includes(current) ? current : (models[0] || '');
    }
    if (chips) {
      const esc = (s) => DomUtils.escapeHtml(s);
      const removeLabel = DomUtils.t('edChatRemoveModel', 'Remove model');
      DomUtils.setHTML(chips, this._draftCustomModels.map((m) => `
        <span class="gc__chip" role="listitem" title="${esc(m)}">
          <span class="gc__chipText">${esc(m)}</span>
          <button type="button" class="gc__chipRemove" data-model="${esc(m)}" aria-label="${esc(`${removeLabel}: ${m}`)}">${this._icon_('close', 12)}</button>
        </span>`).join(''));
    }
  }

  /** Añade el modelo escrito a los personalizados del borrador. */
  _addCustomModel_() {
    const input = this.shadowRoot.getElementById('gc__customModelInput');
    const value = (input?.value || '').trim();
    if (!value) { input?.focus(); return; }
    if (!this._draftCustomModels.includes(value)) this._draftCustomModels.push(value);
    input.value = '';
    this._syncSettingsModels_(value);
    input.focus();
  }

  /**
   * Quita un modelo personalizado del borrador.
   * @param {string} model
   * @private
   */
  _removeCustomModel_(model) {
    this._draftCustomModels = this._draftCustomModels.filter((m) => m !== model);
    this._syncSettingsModels_();
    this.shadowRoot.getElementById('gc__customModelInput')?.focus();
  }

  /**
   * Consulta el API del proveedor para sincronizar modelos disponibles orientados a código/chat.
   * Mantiene siempre los modelos base originales y los modelos personalizados añadidos por el usuario.
   */
  async _onFetchModelsClick_() {
    const id = this._settingsProvider || this._config.provider;
    if (!id) return;
    const provSettings = this._getProviderSettings_(id);
    const hasKey = !!this._config.apiKeysSet?.[id];

    if (id !== 'custom' && id !== 'openrouter' && !hasKey) {
      this._setFetchStatus_(
        'error',
        DomUtils.t('edChatFetchModelsKeyRequired', 'Save your API key first to fetch models')
      );
      this.shadowRoot.getElementById('gc__apiKeyInput')?.focus();
      return;
    }

    const btn = this.shadowRoot.getElementById('gc__fetchModelsBtn');
    const label = this.shadowRoot.getElementById('gc__fetchModelsText');
    if (btn) { btn.classList.add('gc__spinning'); btn.disabled = true; }
    if (label) label.textContent = DomUtils.t('edChatFetchingModels', 'Fetching…');
    this._setFetchStatus_('loading', DomUtils.t('edChatFetchingModelsStatus', 'Fetching models from provider API…'));

    try {
      const res = await DomUtils.bridgeRequest(
        'GAS_LLM_FETCH_MODELS',
        'GAS_LLM_FETCH_MODELS_RESULT',
        { provider: id, endpointUrl: provSettings.endpointUrl },
        { timeoutMs: 20000 }
      );

      if (!res?.ok) {
        if (res?.permissionOrigin) {
          this._setFetchStatus_(
            'error',
            DomUtils.t(
              'edChatPermissionMissing',
              'Access to $1 has not been granted. Open the extension popup → AI Context → "Provider access", allow this provider and try again.',
              res.permissionOrigin
            )
          );
        } else {
          this._setFetchStatus_('error', res?.error || 'Error fetching models');
        }
        return;
      }

      const incoming = Array.isArray(res.models) ? res.models : [];
      const currentFetched = provSettings.fetchedModels || [];
      const combined = [...new Set([...currentFetched, ...incoming])];
      const newCount = combined.length - currentFetched.length;

      // Actualizar fetchedModels del proveedor y persistir
      this._config = {
        ...this._config,
        providerSettings: {
          ...this._config.providerSettings,
          [id]: {
            ...provSettings,
            fetchedModels: combined,
          },
        },
      };

      this._saveConfig();
      this._syncSettingsModels_();
      this._refreshComposerProviderUI_();

      if (newCount > 0) {
        this._setFetchStatus_(
          'success',
          DomUtils.t('edChatModelsUpdated', 'Done — $1 new model(s) added to the list', newCount),
          6000
        );
      } else {
        this._setFetchStatus_(
          'info',
          DomUtils.t('edChatNoNewModels', 'All models are already up to date'),
          5000
        );
      }
    } catch (err) {
      this._setFetchStatus_('error', err?.message || 'Error fetching models');
    } finally {
      if (btn) { btn.classList.remove('gc__spinning'); btn.disabled = false; }
      if (label) label.textContent = DomUtils.t('edChatFetchModels', 'Fetch models');
    }
  }

  /** Maneja el guardado de settings. */
  _onSettingsSave() {
    const sr = this.shadowRoot;
    const settingsModelSel = sr.getElementById('gc__settingsModelSelect');
    const apiKeyInput      = sr.getElementById('gc__apiKeyInput');
    const tempInput        = sr.getElementById('gc__tempInput');
    const maxTokensInput   = sr.getElementById('gc__maxTokensInput');
    const systemPrompt     = sr.getElementById('gc__systemPrompt');
    const endpointUrlInput = sr.getElementById('gc__endpointUrl');
    const customInput      = sr.getElementById('gc__customModelInput');

    try {
      // Un modelo escrito pero no añadido también se guarda.
      if ((customInput?.value || '').trim()) this._addCustomModel_();

      const activeProvider  = this._settingsProvider || this._config.provider || 'gemini';
      const activeModel     = settingsModelSel?.value || (activeProvider === this._config.provider ? this._config.model : '') || '';
      const apiKey          = (apiKeyInput?.value || '').trim();
      const tempVal         = parseFloat(tempInput?.value ?? 0.3);
      const maxTokensVal    = (maxTokensInput?.value || '').trim() ? parseInt(maxTokensInput.value, 10) : '';
      const sysPromptVal    = systemPrompt?.value || '';
      const ctxWindowRaw    = parseInt(sr.getElementById('gc__contextWindowInput')?.value || '', 10);
      const contextWindowVal = Number.isFinite(ctxWindowRaw) && ctxWindowRaw > 0 ? ctxWindowRaw : '';
      const customModelsVal = [...this._draftCustomModels];
      const endpointUrlVal  = (endpointUrlInput?.value || '').trim();
      const engineVal       = sr.getElementById('gc__agentEngineSelect')?.value || 'auto';

      // Solo se envían las keys que el usuario cambió: texto = guardar, null = eliminar.
      // Campo vacío sin eliminación pendiente = conservar la key existente.
      const apiKeyUpdates = {};
      if (apiKey) {
        apiKeyUpdates[activeProvider] = apiKey;
      } else if (this._apiKeyRemovalFor === activeProvider) {
        apiKeyUpdates[activeProvider] = null;
      }

      this._config = {
        ...this._config,
        provider: activeProvider,
        model: activeModel,
        // Propiedades raíz sincronizadas con el proveedor activo
        temperature: tempVal,
        systemPrompt: sysPromptVal,
        customModels: customModelsVal,
        providerSettings: {
          ...this._config.providerSettings,
          [activeProvider]: {
            // Se conservan los campos que no se editan aquí (p. ej. fetchedModels).
            ...((this._config.providerSettings || {})[activeProvider] || {}),
            temperature: tempVal,
            systemPrompt: sysPromptVal,
            customModels: customModelsVal,
            endpointUrl: endpointUrlVal,
            maxTokens: maxTokensVal,
            contextWindow: contextWindowVal,
            agentEngine: ['tools', 'blocks'].includes(engineVal) ? engineVal : 'auto',
          },
        },
      };

      this._saveConfig(apiKeyUpdates);

      // Refleja localmente qué proveedores tienen key, sin conservar el texto.
      const apiKeysSet = { ...(this._config.apiKeysSet || {}) };
      for (const [id, value] of Object.entries(apiKeyUpdates)) {
        if (value) apiKeysSet[id] = true;
        else delete apiKeysSet[id];
      }
      this._config.apiKeysSet = apiKeysSet;
      this._syncApiKeyField_(activeProvider);
      this._syncActiveProvBanner_();

      this._closeSettings_();
      this._refreshComposerProviderUI_();
      this._refreshTokenEstimate_();
      this._showToast_(DomUtils.t('edChatSettingsSaved', 'Settings saved ✓'), 'success', 3500);
    } catch (err) {
      console.error('Error guardando settings:', err);
      this._showToast_(DomUtils.t('edChatSaveError', 'Error saving: $1', err.message), 'error', 0);
    }
  }

  /** Alterna visibilidad de la API key. */
  _onToggleKeyClick() {
    const apiKeyInput  = this.shadowRoot.getElementById('gc__apiKeyInput');
    const toggleKeyBtn = this.shadowRoot.getElementById('gc__toggleKeyBtn');
    if (!apiKeyInput || !toggleKeyBtn) return;
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    const hidden = apiKeyInput.type === 'password';
    DomUtils.setHTML(toggleKeyBtn, this._icon_(hidden ? 'eye' : 'eyeOff'));
    toggleKeyBtn.setAttribute('aria-pressed', String(!hidden));
  }

  /**
   * Prepara el campo de API key para `providerId`: siempre vacío (la key
   * nunca vuelve al MAIN world); el placeholder indica si hay una guardada.
   * @param {string} providerId
   * @private
   */
  _syncApiKeyField_(providerId) {
    const apiKeyInput = this.shadowRoot.getElementById('gc__apiKeyInput');
    if (!apiKeyInput) return;
    const provider = GAS_LLM_PROVIDERS[providerId];
    const hasKey   = !!this._config.apiKeysSet?.[providerId];
    this._apiKeyRemovalFor  = null;
    apiKeyInput.value       = '';
    apiKeyInput.placeholder = hasKey
      ? DomUtils.t('edChatKeySaved', '•••••• (saved — type to replace)')
      : (provider?.keyHint || DomUtils.t('edChatApiKeyLower', 'API key'));
    this._syncKeyStatus_(providerId);
  }

  /**
   * Pinta la insignia de estado de la key y el botón "Eliminar".
   * @param {string} providerId
   * @private
   */
  _syncKeyStatus_(providerId) {
    const badge   = this.shadowRoot.getElementById('gc__keyBadge');
    const clear   = this.shadowRoot.getElementById('gc__clearKeyBtn');
    const hasKey  = !!this._config.apiKeysSet?.[providerId];
    const removing = this._apiKeyRemovalFor === providerId;
    let kind = hasKey ? 'ok' : 'none';
    let label = hasKey
      ? DomUtils.t('edChatBadgeKeySaved', 'Key saved')
      : (providerId === 'custom' ? DomUtils.t('edChatBadgeKeyOptional', 'Not required') : DomUtils.t('edChatBadgeNoKey', 'No key'));
    if (removing) { kind = 'warn'; label = DomUtils.t('edChatKeyWillBeRemoved', 'Key will be removed on save'); }
    if (badge) {
      badge.className = `gc__badge gc__badge--${kind}`;
      badge.textContent = label;
    }
    if (clear) clear.hidden = !hasKey || removing;
  }

  /** Marca la key guardada del proveedor en edición para eliminarla al guardar. */
  _onClearKeyClick_() {
    const apiKeyInput = this.shadowRoot.getElementById('gc__apiKeyInput');
    const providerId  = this._settingsProvider || this._config.provider;
    if (!apiKeyInput || !providerId) return;
    this._apiKeyRemovalFor  = providerId;
    apiKeyInput.value       = '';
    apiKeyInput.placeholder = DomUtils.t('edChatKeyWillBeRemoved', 'Key will be removed on save');
    this._syncKeyStatus_(providerId);
  }

  /** Actualiza el valor de temperatura (y el relleno del slider) en tiempo real. */
  _onTempInput() {
    const tempInput = this.shadowRoot.getElementById('gc__tempInput');
    const tempVal   = this.shadowRoot.getElementById('gc__tempVal');
    if (!tempInput) return;
    const value = Number(tempInput.value);
    if (tempVal) tempVal.textContent = value.toFixed(1);
    tempInput.setAttribute('aria-valuenow', tempInput.value);
    tempInput.style.setProperty('--qc-chat-fill', `${Math.round(value * 100)}%`);
  }

  /**
   * Sincroniza la vista de settings con this._config.
   * @param {string} [providerId] Proveedor a mostrar (por defecto el activo).
   */
  _refreshSettingsUI_(providerId) {
    const id = GAS_LLM_PROVIDERS[providerId] ? providerId
      : (GAS_LLM_PROVIDERS[this._config.provider] ? this._config.provider : 'gemini');
    this._settingsProvider = id;
    this._renderProviderList_();
    this._onSettingsProviderChange();
    this._refreshComposerProviderUI_();
  }
}

// Registro idempotente del Web Component.
if (!customElements.get('gas-chat-panel')) {
  customElements.define('gas-chat-panel', GasChatPanel);
}