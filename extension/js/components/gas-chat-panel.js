/**
 * @fileoverview <gas-chat-panel> - Panel de chat con LLM para el IDE de GAS.
 *
 * Características:
 *  - Web Component en Shadow DOM (aislado de estilos del IDE).
 *  - Proveedores soportados: OpenAI, Anthropic, Google Gemini, DeepSeek, Kimi, ChatLLM.
 *  - Selector de proveedor/modelo siempre visible en el composer.
 *  - Menú @ para insertar contexto del editor (@selection / @file / @project).
 *  - Renderizado de Markdown básico con botones Copy/Insert/Replace en bloques de código.
 *  - Persistencia de API keys y preferencias en chrome.storage.sync (vía bridge).
 *  - Drag & resize manual.
 *
 * Flujo de comunicación:
 *   panel → CustomEvent('GAS_LLM_REQUEST')  → bridge → background → fetch LLM
 *   background → CustomEvent('GAS_LLM_RESPONSE') → panel
 *
 * Persistencia (vía bridge, ya que MAIN world no tiene chrome.runtime):
 *   GAS_LLM_GET_CONFIG / GAS_LLM_CONFIG_RESULT / GAS_LLM_SAVE_CONFIG
 */

// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGO DE PROVEEDORES
// ─────────────────────────────────────────────────────────────────────────────
const GAS_LLM_PROVIDERS = {
  openai: {
    label: 'OpenAI',
    models: [
      'gpt-4o-mini',
      'gpt-4o',
      'o3-mini',
    ],
    keyHint: 'sk-...',
  },
  anthropic: {
    label: 'Anthropic Claude',
    models: [
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
    ],
    keyHint: 'sk-ant-...',
  },
  gemini: {
    label: 'Google Gemini',
    models: [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
    keyHint: 'AIza...',
  },
  deepseek: {
    label: 'DeepSeek',
    models: [
      'deepseek-chat',
      'deepseek-coder',
    ],
    keyHint: 'sk-...',
  },
  kimi: {
    label: 'Kimi (Moonshot AI)',
    models: [
      'kimi-k2.5',
      'kimi-k2.6',
    ],
    keyHint: 'sk-...',
  },
  chatllm: {
    label: 'ChatLLM (Abacus)',
    models: [
      'deepseek-chat',
      'deepseek-coder',
      'llama-3.3-70b-instruct',
      'qwen-2.5-72b-instruct',
      'mixtral-8x7b-instruct',
    ],
    keyHint: 's2_...',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// WEB COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
class GasChatPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** @type {object|null} Instancia activa del editor Monaco. */
    this._editor = null;

    /** @type {Array<{role:'user'|'assistant'|'system', content:string}>} Historial de conversación. */
    this._messages = [];

    /** @type {object} Configuración persistida. */
    this._config = {
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      apiKeys: {},
      systemPrompt: 'You are an expert Google Apps Script assistant. Answer concisely and prefer code examples in JavaScript.',
      aiContext: '',
      temperature: 0.3,
    };

    /** @type {boolean} Indica si hay una petición LLM en curso. */
    this._isStreaming = false;

    /** @type {string|null} ID de la petición en curso. */
    this._currentRequestId = null;

    /** @type {Map<string, Function>} Resolvers pendientes para llamadas al bridge. */
    this._pendingBridgeCalls = new Map();

    // Estado del menú de autocompletado @.
    this._mentionMenu  = null;
    this._mentionIndex = -1;
    this._mentionStart = -1;
    this._mentionQuery = '';

    // Binds explícitos para poder remover los listeners después.
    this._onLlmResponse   = this._onLlmResponse.bind(this);
    this._onBridgeResult  = this._onBridgeResult.bind(this);
    this._onWindowKeyDown = this._onWindowKeyDown.bind(this);

    // Items disponibles para el autocompletado con @.
    this._mentionItems = [
      { tag: '@selection', label: 'Selected text',    desc: 'Insert current editor selection' },
      { tag: '@file',      label: 'Active file',      desc: 'Insert full content of the open file' },
      { tag: '@project',   label: 'Entire project',   desc: 'Insert all project files' },
    ];
  }

  // ──────────────────────────────────────────────────────────────────
  // CICLO DE VIDA
  // ──────────────────────────────────────────────────────────────────

  connectedCallback() {
    this._render();
    this._setupListeners();
    document.addEventListener('GAS_LLM_RESPONSE', this._onLlmResponse);
    document.addEventListener('GAS_LLM_CONFIG_RESULT', this._onBridgeResult);
    this._loadConfig();
  }

  /**
   * Permite eliminar los eventos al eliminar el componente
   */
  disconnectedCallback() {
    document.removeEventListener('GAS_LLM_RESPONSE', this._onLlmResponse);
    document.removeEventListener('GAS_LLM_CONFIG_RESULT', this._onBridgeResult);
    window.removeEventListener('keydown', this._onWindowKeyDown);
  }

  // ──────────────────────────────────────────────────────────────────
  // API PÚBLICA
  // ──────────────────────────────────────────────────────────────────

  /**
   * Inyecta la instancia activa de Monaco. Llamado desde gasTools.js.
   * @param {object|null} editor
   */
  setEditor(editor) {
    this._editor = editor || null;
  }

  /** Abre el panel y enfoca el textarea. */
  open() {
    this.style.display = 'flex';
    this.style.pointerEvents = 'auto';
    setTimeout(() => {
      this.shadowRoot.getElementById('gc__chatInput')?.focus();
    }, 30);
  }

  /** Cierra el panel. */
  close() {
    this.style.display = 'none';
    this.style.pointerEvents = 'none';
  }

  /** Alterna abierto/cerrado. */
  toggle() {
    if (this.style.display === 'flex') this.close();
    else this.open();
  }

  // ──────────────────────────────────────────────────────────────────
  // CONFIG (persistencia vía bridge)
  // ──────────────────────────────────────────────────────────────────

  /** Carga la configuración desde chrome.storage.sync vía bridge. */
  _loadConfig() {
    this._bridgeCall_('GAS_LLM_GET_CONFIG').then((cfg) => {
      if (cfg && typeof cfg === 'object') {
        this._config = {
          ...this._config,
          ...cfg,
          apiKeys: { ...this._config.apiKeys, ...(cfg.apiKeys || {}) },
        };
      }
      this._loadAiContext_();
      this._refreshComposerProviderUI_();
      this._refreshSettingsUI_();
    });
  }

  /** Carga el AI Context global desde el background. */
  _loadAiContext_() {
    this._bridgeCall_('GAS_LLM_GET_GLOBAL_AI_CONTEXT').then((context) => {
      if (context) {
        this._config.aiContext = context;
      }
    });
  }

  /** Persiste la configuración actual en chrome.storage.sync vía bridge (fire-and-forget). */
  _saveConfig() {
    document.dispatchEvent(new CustomEvent('GAS_LLM_SAVE_CONFIG', {
      detail: JSON.stringify(this._config),
    }));
  }

  /**
   * Envía un evento al bridge y espera la respuesta correlacionada (timeout 10 s).
   * @param {string} eventName
   * @param {object} [payload]
   * @returns {Promise<any>}
   */
  _bridgeCall_(eventName, payload = {}) {
    return new Promise((resolve) => {
      const requestId = `br_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this._pendingBridgeCalls.set(requestId, resolve);
      setTimeout(() => {
        if (this._pendingBridgeCalls.has(requestId)) {
          this._pendingBridgeCalls.delete(requestId);
          resolve(null);
        }
      }, 10000);
      document.dispatchEvent(new CustomEvent(eventName, {
        detail: JSON.stringify({ requestId, ...payload }),
      }));
    });
  }

  /**
   * Recibe resultados del bridge, empareja por requestId y resuelve la promesa pendiente.
   * @param {CustomEvent} e
   */
  _onBridgeResult(e) {
    try {
      const { requestId, data } = JSON.parse(e.detail);
      const resolver = this._pendingBridgeCalls.get(requestId);
      if (resolver) {
        this._pendingBridgeCalls.delete(requestId);
        resolver(data);
      }
    } catch (_) { /* payload corrupto, ignoramos */ }
  }

  // ──────────────────────────────────────────────────────────────────
  // ENVÍO DE MENSAJES Y CONTEXTO DEL EDITOR
  // ──────────────────────────────────────────────────────────────────

  /**
   * Expande los tags @, construye los mensajes para el API y dispara la petición al LLM.
   * Lee proveedor y modelo desde los selectores del composer.
   */
  async _sendMessage() {
    const input    = this.shadowRoot.getElementById('gc__chatInput');
    const userText = (input?.value || '').trim();
    if (!userText || this._isStreaming) return;

    const provSel  = this.shadowRoot.getElementById('gc__providerSelect');
    const modelSel = this.shadowRoot.getElementById('gc__modelSelect');
    const provider = provSel?.value || this._config.provider;
    const model    = modelSel?.value || this._config.model;

    this._config.provider = provider;
    this._config.model    = model;

    const apiKey = this._config.apiKeys?.[provider] || '';
    if (!apiKey) {
      this._appendSystemNotice_(
        `Missing API key for ${GAS_LLM_PROVIDERS[provider]?.label || provider}. Configure it in ⚙ Settings.`
      );
      this._openSettings_();
      return;
    }

    const expandedContent = this._expandContextTags_(userText);

    input.value = '';
    input.style.height = 'auto';

    this._messages.push({ role: 'user', content: userText, _expanded: expandedContent });
    this._renderMessages_();

    this._isStreaming = true;
    this._appendThinking_();
    this._updateSendButton_();

    // Combinar systemPrompt con AI Context del proyecto
    let systemContent = this._config.systemPrompt;
    if (this._config.aiContext) {
      systemContent += '\n\n--- Project Context ---\n' + this._config.aiContext;
    }

    const apiMessages = [
      { role: 'system', content: systemContent },
      ...this._messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m._expanded || m.content })),
    ];
    console.log("provider", provider);

    this._currentRequestId = `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    document.dispatchEvent(new CustomEvent('GAS_LLM_REQUEST', {
      detail: JSON.stringify({
        requestId: this._currentRequestId,
        provider,
        apiKey,
        model,
        temperature: this._config.temperature,
        messages: apiMessages,
      }),
    }));
  }

  /**
   * Reemplaza los tags @selection / @file / @project por el contenido real del editor.
   * @param {string} text
   * @returns {string}
   */
  _expandContextTags_(text) {
    let result = text;
    if (/(^|\s)@selection\b/.test(result)) {
      const selText = this._getSelectionText_();
      const block = selText ? '```\n' + selText + '\n```' : '(no selection)';
      result = result.replace(/@selection\b/g, `\n[Current selection]\n${block}\n`);
    }
    if (/(^|\s)@file\b/.test(result)) {
      const fileText = this._getActiveFileText_();
      const block = fileText ? '```\n' + fileText + '\n```' : '(no active file)';
      result = result.replace(/@file\b/g, `\n[Active file]\n${block}\n`);
    }
    if (/(^|\s)@project\b/.test(result)) {
      const all = this._getAllFilesText_();
      result = result.replace(/@project\b/g, `\n[Entire project]\n${all}\n`);
    }
    return result;
  }

  /** Devuelve el texto seleccionado en Monaco, o cadena vacía. */
  _getSelectionText_() {
    if (!this._editor) return '';
    try {
      const sel   = this._editor.getSelection();
      const model = this._editor.getModel();
      if (!sel || sel.isEmpty() || !model) return '';
      return model.getValueInRange(sel);
    } catch (_) { return ''; }
  }

  /** Devuelve el contenido completo del archivo activo en Monaco. */
  _getActiveFileText_() {
    if (!this._editor) return '';
    try { return this._editor.getModel()?.getValue() || ''; }
    catch (_) { return ''; }
  }

  /**
   * Concatena todos los modelos Monaco abiertos (límite ~80k caracteres).
   * @returns {string}
   */
  _getAllFilesText_() {
    const models    = window.monaco?.editor?.getModels?.() || [];
    const MAX_TOTAL = 80000;
    let total = 0;
    const blocks = [];
    for (const m of models) {
      const content = m.getValue();
      const name    = m.uri?.path || 'unknown';
      const block   = `--- File: ${name} ---\n\`\`\`\n${content}\n\`\`\`\n`;
      if (total + block.length > MAX_TOTAL) {
        blocks.push('... (rest omitted due to size)\n');
        break;
      }
      total += block.length;
      blocks.push(block);
    }
    return blocks.join('\n');
  }

  /**
   * Maneja la respuesta del LLM: reemplaza el indicador "Thinking..." por el contenido real.
   * @param {CustomEvent} e
   */
  _onLlmResponse(e) {
    let payload;
    try { payload = JSON.parse(e.detail); } catch (_) { return; }
    if (!payload || payload.requestId !== this._currentRequestId) return;

    this._isStreaming      = false;
    this._currentRequestId = null;
    this._updateSendButton_();

    if (payload.ok) {
      this._messages.push({ role: 'assistant', content: payload.content || '' });
    } else {
      this._messages.push({
        role: 'assistant',
        content: `**Error:** ${payload.error || 'Empty or unknown response'}`,
        _isError: true,
      });
    }
    this._renderMessages_();
  }

  // ──────────────────────────────────────────────────────────────────
  // RENDER (Shadow DOM)
  // ──────────────────────────────────────────────────────────────────

  /** Genera el HTML/CSS del panel e inserta en el Shadow DOM. */
  _render() {
    DomUtils.setHTML(this.shadowRoot, `
      <style>
        :host {
          display: none;
          pointer-events: none;
          position: fixed;
          top: 50%;
          right: 14px;
          left: auto;
          transform: translateY(-50%);
          z-index: 2147483640;
          width: min(460px, calc(100vw - 28px));
          height: 100%;
          min-width: 360px;
          min-height: 360px;
          max-width: calc(100vw - 18px);
          max-height: 100vh;
          background: #ffffff;
          color: #202124;
          border: 1px solid #dadce0;
          border-radius: 0px;
          box-shadow: 0 10px 38px rgba(60,64,67,.24), 0 2px 8px rgba(60,64,67,.18);
          font-family: "Google Sans", Roboto, Arial, sans-serif;
          overflow: hidden;
          animation: gc__panelIn .16s ease-out;
        }
        @keyframes gc__panelIn {
          from { transform: translateY(calc(-50% + 8px)); opacity: 0; }
          to   { transform: translateY(-50%); opacity: 1; }
        }
        :host([theme="dark"]) {
          background: #202124;
          color: #e8eaed;
          border-color: #3c4043;
        }

        /* ── Shell ── */
        .gc__shell {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          overflow: hidden;
          min-width: 0
        }

        /* ── Header ── */
        .gc__header {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          cursor: default;
          user-select: none;
          border-bottom: 1px solid #eceff1;
          background: linear-gradient(to bottom, rgba(248,249,250,.9), rgba(248,249,250,.6));
        }
        :host([theme="dark"]) .gc__header {
          border-bottom-color: #3c4043;
          background: linear-gradient(to bottom, rgba(32,33,36,.95), rgba(32,33,36,.75));
        }
        .gc__icon {
          width: 22px; height: 22px;
          border-radius: 999px;
          display: grid; place-items: center;
          font-size: 13px;
          background: rgba(26,115,232,.12);
          color: #1a73e8;
          flex: 0 0 auto;
        }
        .gc__title {
          font-size: 13px; font-weight: 600;
          flex: 1;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .gc__providerPill {
          font-size: 10px; font-weight: 600;
          padding: 2px 8px;
          border-radius: 12px;
          background: rgba(26,115,232,.12);
          color: #1a73e8;
        }
        :host([theme="dark"]) .gc__providerPill {
          background: rgba(138,180,248,.18); color: #8ab4f8;
        }
        .gc__iconBtn {
          border: none; background: transparent; color: #5f6368;
          width: 30px; height: 30px;
          border-radius: 8px;
          cursor: pointer; font-size: 16px; line-height: 30px;
          display: grid; place-items: center;
        }
        .gc__iconBtn:hover { background: rgba(95,99,104,.14); }
        :host([theme="dark"]) .gc__iconBtn { color: #bdc1c6; }

        /* ── Mensajes ── */
        .gc__messages {
          flex: 1 1 auto; min-height: 0;
          overflow-y: auto;
          padding: 12px;
          background: #f8f9fa;
          display: flex; flex-direction: column; gap: 10px;
        }
        :host([theme="dark"]) .gc__messages { background: #1e1f22; }

        .gc__msg {
          max-width: 92%;
          padding: 9px 11px;
          border-radius: 10px;
          font-size: 13px; line-height: 1.45;
          word-wrap: break-word; white-space: normal;
        }
        .gc__msg p { margin: 0 0 6px 0; }
        .gc__msg p:last-child { margin-bottom: 0; }
        .gc__msg ul, .gc__msg ol { margin: 4px 0 4px 18px; padding: 0; }
        .gc__msg h1, .gc__msg h2, .gc__msg h3 {
          margin: 6px 0 4px 0; font-size: 14px; font-weight: 600;
        }
        .gc__msg.gc__user {
          align-self: flex-end;
          background: #1a73e8; color: #fff;
          border-bottom-right-radius: 3px;
        }
        .gc__msg.gc__assistant {
          align-self: flex-start;
          background: #ffffff; color: #202124;
          border: 1px solid #e6e9ec;
          border-bottom-left-radius: 3px;
        }
        :host([theme="dark"]) .gc__msg.gc__assistant {
          background: #2a2b2f; color: #e8eaed; border-color: #3c4043;
        }
        .gc__msg.gc__system {
          align-self: center;
          background: rgba(251,188,5,.15); color: #b06000;
          font-size: 11px; padding: 4px 8px; border-radius: 8px;
        }
        :host([theme="dark"]) .gc__msg.gc__system {
          background: rgba(251,188,5,.2); color: #fdd663;
        }
        .gc__msg.gc__error {
          background: rgba(217,48,37,.1); color: #b3261e;
          border: 1px solid rgba(217,48,37,.25);
        }
        :host([theme="dark"]) .gc__msg.gc__error {
          background: rgba(242,139,130,.1); color: #f28b82;
          border-color: rgba(242,139,130,.3);
        }
        .gc__thinking {
          align-self: flex-start;
          font-size: 12px; color: #5f6368;
          padding: 4px 8px; font-style: italic;
        }
        :host([theme="dark"]) .gc__thinking { color: #9aa0a6; }
        .gc__thinking::after {
          content: '...';
          display: inline-block;
          animation: gc__dots 1.2s steps(4, end) infinite;
        }
        @keyframes gc__dots {
          0%, 20%   { content: '.';   }
          40%       { content: '..';  }
          60%, 100% { content: '...'; }
        }

        /* ── Bloques de código ── */
        .gc__codeWrap {
          margin: 6px 0; border-radius: 8px;
          overflow: hidden; border: 1px solid #e6e9ec; background: #f6f8fa;
        }
        :host([theme="dark"]) .gc__codeWrap { background: #0d1117; border-color: #30363d; }
        .gc__codeBar {
          display: flex; align-items: center; justify-content: space-between;
          padding: 4px 8px; font-size: 10px; color: #5f6368;
          background: #eceff1; border-bottom: 1px solid #e6e9ec;
        }
        :host([theme="dark"]) .gc__codeBar {
          background: #161b22; color: #8b949e; border-bottom-color: #30363d;
        }
        .gc__codeBarBtns { display: flex; gap: 4px; }
        .gc__codeBtn {
          border: none; background: transparent; color: inherit;
          font-size: 10px; padding: 2px 6px; border-radius: 4px;
          cursor: pointer; font-family: inherit;
        }
        .gc__codeBtn:hover { background: rgba(26,115,232,.12); color: #1a73e8; }
        :host([theme="dark"]) .gc__codeBtn:hover { background: rgba(138,180,248,.15); color: #8ab4f8; }
        .gc__codeBlock {
          margin: 0; padding: 8px 10px;
          font-family: "Roboto Mono", Consolas, "Courier New", monospace;
          font-size: 12px; line-height: 1.45; color: #24292f;
          overflow-x: auto; white-space: pre;
        }
        :host([theme="dark"]) .gc__codeBlock { color: #c9d1d9; }
        .gc__inlineCode {
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 12px; padding: 1px 5px; border-radius: 4px;
          background: rgba(175,184,193,.2);
        }

        /* ── Composer ── */
        .gc__composer {
          flex: 0 0 auto;
          border-top: 1px solid #eceff1;
          padding: 8px;
          background: #fff;
          display: flex; flex-direction: column; gap: 6px;
        }
        :host([theme="dark"]) .gc__composer { background: #202124; border-top-color: #3c4043; }

        /* ── Fila de proveedor/modelo (siempre visible en el composer) ── */
        .gc__providerRow {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px;
          background: #f8f9fa;
          border: 1px solid #e8eaed;
          border-radius: 8px;
        }
        :host([theme="dark"]) .gc__providerRow { background: #2a2b2f; border-color: #3c4043; }
        .gc__providerRowLabel {
          font-size: 10px; font-weight: 600; color: #5f6368; white-space: nowrap;
        }
        :host([theme="dark"]) .gc__providerRowLabel { color: #9aa0a6; }
        .gc__providerRowSep { color: #dadce0; font-size: 11px; }
        .gc__miniSelect {
          border: none; background: transparent;
          font-size: 11px; font-weight: 600; color: #1a73e8;
          cursor: pointer; outline: none;
          padding: 0 2px;
          font-family: inherit;
          flex: 1; min-width: 0;
        }
        .gc__miniSelect:hover { color: #1765cc; }
        :host([theme="dark"]) .gc__miniSelect { color: #8ab4f8; }
        :host([theme="dark"]) .gc__miniSelect:hover { color: #aecbfa; }
        /* El selector de modelo no necesita negrita */
        #gc__modelSelect.gc__miniSelect { font-weight: 400; color: #202124; }
        :host([theme="dark"]) #gc__modelSelect.gc__miniSelect { color: #e8eaed; }

        /* ── Fila de contexto (@select + botón insertar) ── */
        .gc__ctxRow {
          display: flex; align-items: center; gap: 6px;
        }
        .gc__ctxLabel {
          font-size: 10px; color: #80868b; white-space: nowrap;
        }
        .gc__ctxSelectWrap {
          position: relative; display: inline-flex; align-items: center;
        }
        .gc__ctxSelect {
          border: 1px solid rgba(26,115,232,.25);
          background: rgba(26,115,232,.08);
          color: #1a73e8;
          font-size: 10px; font-weight: 600;
          border-radius: 11px;
          padding: 3px 22px 3px 8px;
        }
        /* ── Menú de autocompletado @ (mention) ── */
        .gc__mentionMenu {
          position: absolute;
          bottom: 100%;
          left: 8px;
          z-index: 10;
          background: #fff;
          border: 1px solid #dadce0;
          border-radius: 10px;
          box-shadow: 0 4px 16px rgba(60,64,67,.2);
          min-width: 260px;
          max-width: 320px;
          overflow: hidden;
          display: none;
          flex-direction: column;
          margin-bottom: 6px;
        }
        :host([theme="dark"]) .gc__mentionMenu {
          background: #2a2b2f;
          border-color: #3c4043;
          box-shadow: 0 4px 16px rgba(0,0,0,.4);
        }
        .gc__mentionMenu.gc__open { display: flex; }
        .gc__mentionItem {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          cursor: pointer;
          border: none;
          background: transparent;
          width: 100%;
          text-align: left;
          font-family: inherit;
          color: inherit;
          font-size: 13px;
          transition: background .08s;
        }
        .gc__mentionItem:hover,
        .gc__mentionItem.gc__active {
          background: rgba(26,115,232,.1);
        }
        :host([theme="dark"]) .gc__mentionItem:hover,
        :host([theme="dark"]) .gc__mentionItem.gc__active {
          background: rgba(138,180,248,.15);
        }
        .gc__mentionIcon {
          width: 28px; height: 28px;
          border-radius: 8px;
          background: rgba(26,115,232,.12);
          color: #1a73e8;
          display: grid; place-items: center;
          font-size: 13px; font-weight: 600;
          flex: 0 0 auto;
        }
        :host([theme="dark"]) .gc__mentionIcon {
          background: rgba(138,180,248,.18);
          color: #8ab4f8;
        }
        .gc__mentionInfo { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .gc__mentionLabel { font-weight: 600; font-size: 13px; }
        .gc__mentionDesc { font-size: 11px; color: #80868b; }
        :host([theme="dark"]) .gc__mentionDesc { color: #9aa0a6; }
        .gc__mentionHeader {
          padding: 6px 12px;
          font-size: 10px;
          font-weight: 600;
          color: #80868b;
          text-transform: uppercase;
          letter-spacing: .4px;
          border-bottom: 1px solid #eceff1;
        }
        :host([theme="dark"]) .gc__mentionHeader {
          color: #9aa0a6;
          border-bottom-color: #3c4043;
          cursor: pointer; outline: none;
          appearance: none;
          font-family: inherit;
        }
        .gc__ctxSelectWrap::after {
          content: "▾";
          position: absolute; right: 7px;
          font-size: 9px; color: #1a73e8;
          pointer-events: none;
        }
        :host([theme="dark"]) .gc__ctxSelect {
          background: rgba(138,180,248,.12); color: #8ab4f8;
          border-color: rgba(138,180,248,.3);
        }
        .gc__ctxInsertBtn {
          font-size: 10px; padding: 3px 8px; border-radius: 11px;
          background: rgba(26,115,232,.12); color: #1a73e8;
          border: 1px solid rgba(26,115,232,.25); cursor: pointer;
        }
        .gc__ctxInsertBtn:hover { background: rgba(26,115,232,.22); }
        :host([theme="dark"]) .gc__ctxInsertBtn {
          background: rgba(138,180,248,.12); color: #8ab4f8;
          border-color: rgba(138,180,248,.28);
        }

        /* ── Input row ── */
        .gc__inputRow { display: flex; align-items: flex-end; gap: 6px; }
        .gc__textarea {
          flex: 1; resize: none; min-height: 36px; max-height: 160px;
          border: 1px solid #d6dbe1; border-radius: 8px;
          outline: none; font-size: 13px; font-family: inherit;
          background: #fff; color: inherit; padding: 8px 10px; line-height: 1.4;
        }
        .gc__textarea:focus {
          border-color: #a8c7fa; box-shadow: 0 0 0 2px rgba(26,115,232,.12);
        }
        :host([theme="dark"]) .gc__textarea { background: #2a2b2f; border-color: #3c4043; color: #e8eaed; }
        .gc__sendBtn {
          background: #1a73e8; color: #fff; border: none;
          border-radius: 8px; padding: 0 14px; height: 36px;
          font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
        }
        .gc__sendBtn:hover { background: #1765cc; }
        .gc__sendBtn:disabled { background: #9aa0a6; cursor: not-allowed; }
        .gc__hint { font-size: 10px; color: #80868b; padding: 0 2px; }

        /* ── Settings overlay ── */
        .gc__settings {
          position: absolute; inset: 0;
          background: #fff;
          z-index: 2; padding: 12px; overflow-y: auto;
          display: none; flex-direction: column; gap: 10px;
        }
        :host([theme="dark"]) .gc__settings { background: #202124; }
        .gc__settings.gc__open { display: flex; }
        .gc__settingsHeader {
          display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;
        }
        .gc__settingsTitle { font-size: 14px; font-weight: 600; }
        .gc__field { display: flex; flex-direction: column; gap: 4px; }
        .gc__label { font-size: 11px; color: #5f6368; font-weight: 600; }
        :host([theme="dark"]) .gc__label { color: #9aa0a6; }
        .gc__select, .gc__textInput, .gc__textareaCfg {
          border: 1px solid #d6dbe1; border-radius: 6px;
          padding: 6px 8px; font-size: 12px; font-family: inherit;
          background: #fff; color: inherit; outline: none;
        }
        .gc__select:focus, .gc__textInput:focus, .gc__textareaCfg:focus { border-color: #a8c7fa; }
        :host([theme="dark"]) .gc__select,
        :host([theme="dark"]) .gc__textInput,
        :host([theme="dark"]) .gc__textareaCfg {
          background: #2a2b2f; border-color: #3c4043; color: #e8eaed;
        }
        .gc__textareaCfg { resize: vertical; min-height: 60px; font-family: inherit; }
        .gc__keyRow { display: flex; align-items: center; gap: 6px; }
        .gc__keyRow .gc__textInput { flex: 1; }
        .gc__settingsActions {
          display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;
        }
        .gc__btn {
          border: 1px solid #d6dbe1; background: #fff; color: inherit;
          padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
        }
        .gc__btn:hover { background: #f1f3f4; }
        .gc__btn.gc__btnPrimary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
        .gc__btn.gc__btnPrimary:hover { background: #1765cc; }
        :host([theme="dark"]) .gc__btn { background: #2a2b2f; border-color: #3c4043; }
        :host([theme="dark"]) .gc__btn:hover { background: #303134; }
      </style>

      <div class="gc__shell">

        <!-- ── Header ── -->
        <div class="gc__header" id="gc__header">
          <div class="gc__icon">🤖</div>
          <div class="gc__title">AI Assistant</div>
          <span id="gc__providerPill" class="gc__providerPill">Gemini</span>
          <button id="gc__settingsBtn" class="gc__iconBtn" title="Settings">⚙</button>
          <button id="gc__clearBtn" class="gc__iconBtn" title="Clear conversation">🗑</button>
          <button id="gc__closeBtn" class="gc__iconBtn" title="Close (Esc)">×</button>
        </div>

        <!-- ── Lista de mensajes ── -->
        <div id="gc__messages" class="gc__messages">
          <div class="gc__msg gc__system">
            Ask about your code. Use <b>@</b> to insert context: selection, file or project.
          </div>
        </div>

        <!-- ── Composer ── -->
        <div class="gc__composer" style="position:relative;">

          <!-- Fila 1: selector de proveedor + modelo (siempre visible, sin ir a Settings) -->
          <div class="gc__providerRow">
            <span class="gc__providerRowLabel">Provider</span>
            <span class="gc__providerRowSep">|</span>
            <select id="gc__providerSelect" class="gc__miniSelect"></select>
            <span class="gc__providerRowSep">|</span>
            <span class="gc__providerRowLabel">Model</span>
            <span class="gc__providerRowSep">|</span>
            <select id="gc__modelSelect" class="gc__miniSelect"></select>
          </div>

          <!-- Menú flotante de autocompletado @ (mention) -->
          <div id="gc__mentionMenu" class="gc__mentionMenu"></div>

          <!-- Fila 2: textarea + botón enviar -->
          <div class="gc__inputRow">
            <textarea id="gc__chatInput" class="gc__textarea" rows="1" placeholder="Ask something about your code... (Enter to send, Shift+Enter = new line)"></textarea>
            <button id="gc__sendBtn" class="gc__sendBtn">Send</button>
          </div>

          <div class="gc__hint">Enter: send · Shift+Enter: new line · @: context · Esc: close</div>
        </div>

        <!-- ── Settings overlay (solo API key, temperatura y system prompt) ── -->
        <div id="gc__settings" class="gc__settings">
          <div class="gc__settingsHeader">
            <div class="gc__settingsTitle">⚙ AI Settings</div>
            <button id="gc__settingsClose" class="gc__iconBtn" title="Close">×</button>
          </div>

          <!-- Selector de proveedor y modelo (también disponible en Settings) -->
          <div class="gc__field">
            <label class="gc__label">Provider</label>
            <select id="gc__settingsProviderSelect" class="gc__select"></select>
          </div>
          <div class="gc__field">
            <label class="gc__label">Model</label>
            <select id="gc__settingsModelSelect" class="gc__select"></select>
          </div>

          <!-- API Key del proveedor activo -->
          <div class="gc__field">
            <label class="gc__label" id="gc__apiKeyLabel">API Key</label>
            <div class="gc__keyRow">
              <input id="gc__apiKeyInput" class="gc__textInput" type="password" autocomplete="off" placeholder="sk-...">
              <button id="gc__toggleKeyBtn" class="gc__iconBtn" title="Mostrar/ocultar">👁</button>
            </div>
          </div>

          <!-- Temperature -->
          <div class="gc__field">
            <label class="gc__label">Temperature: <span id="gc__tempVal">0.3</span></label>
            <input id="gc__tempInput" class="gc__textInput" type="range" min="0" max="1" step="0.1" value="0.3">
          </div>

          <!-- System prompt -->
          <div class="gc__field">
            <label class="gc__label">System prompt</label>
            <textarea id="gc__systemPrompt" class="gc__textareaCfg"></textarea>
          </div>

          <!-- Administrar modelos personalizados -->
          <div class="gc__field">
            <label class="gc__label">Custom models (one per line)</label>
            <textarea id="gc__customModels" class="gc__textareaCfg" rows="4" placeholder="gpt-4o&#10;claude-sonnet-4-6&#10;gemini-2.5-pro"></textarea>
            <div class="gc__hint">These models are added to the active provider's list.</div>
          </div>

          <div class="gc__settingsActions">
            <button id="gc__cancelSettings" class="gc__btn">Cancel</button>
            <button id="gc__saveSettings" class="gc__btn gc__btnPrimary">Save</button>
          </div>
        </div>
      </div>
    `);

    // Puebla el selector de proveedores en el composer.
    const providerSelect = this.shadowRoot.getElementById('gc__providerSelect');
    if (providerSelect) {
      DomUtils.setHTML(
        providerSelect,
        Object.entries(GAS_LLM_PROVIDERS)
          .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
          .join('')
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // LISTENERS
  // ──────────────────────────────────────────────────────────────────

  /** Conecta todos los event listeners del panel. */
  _setupListeners() {
    const sr = this.shadowRoot;
    const input            = sr.getElementById('gc__chatInput');
    const sendBtn          = sr.getElementById('gc__sendBtn');
    const closeBtn         = sr.getElementById('gc__closeBtn');
    const clearBtn         = sr.getElementById('gc__clearBtn');
    const settingsBtn      = sr.getElementById('gc__settingsBtn');
    const settingsClose    = sr.getElementById('gc__settingsClose');
    const cancelBtn        = sr.getElementById('gc__cancelSettings');
    const saveBtn          = sr.getElementById('gc__saveSettings');
    const providerSel      = sr.getElementById('gc__providerSelect');
    const modelSel         = sr.getElementById('gc__modelSelect');
    const settingsProvSel  = sr.getElementById('gc__settingsProviderSelect');
    const settingsModelSel = sr.getElementById('gc__settingsModelSelect');
    const ctxSelect        = sr.getElementById('gc__ctxSelect');
    const ctxInsertBtn     = sr.getElementById('gc__ctxInsertBtn');
    const apiKeyInput      = sr.getElementById('gc__apiKeyInput');
    const toggleKeyBtn     = sr.getElementById('gc__toggleKeyBtn');
    const tempInput        = sr.getElementById('gc__tempInput');
    const tempVal          = sr.getElementById('gc__tempVal');
    const systemPrompt     = sr.getElementById('gc__systemPrompt');
    const messages         = sr.getElementById('gc__messages');

    // Enviar mensaje.
    sendBtn?.addEventListener('click', () => this._sendMessage());
    input?.addEventListener('keydown', (e) => {
      if (this._mentionMenu?.classList.contains('gc__open')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._navigateMention_(1);  return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); this._navigateMention_(-1); return; }
        if (e.key === 'Enter')     { e.preventDefault(); this._selectMention_();     return; }
        if (e.key === 'Escape')    { this._hideMentionMenu_();                        return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });

    // Auto-resize del textarea y detección de @.
    input?.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      this._updateSendButton_();
      this._detectMention_(input);
    });

    // Cierra el menú @ al hacer clic fuera.
    sr.addEventListener('click', (e) => {
      if (!e.target.closest('.gc__mentionMenu') && e.target !== input) {
        this._hideMentionMenu_();
      }
    });

    // Selector de proveedor en el composer.
    providerSel?.addEventListener('change', () => {
      const id       = providerSel.value;
      const provider = GAS_LLM_PROVIDERS[id];
      const allModels = [...(provider?.models || []), ...(this._config.customModels || [])];
      DomUtils.setHTML(modelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
      if (this._config.provider === id && this._config.model) modelSel.value = this._config.model;
      const pill = sr.getElementById('gc__providerPill');
      if (pill) pill.textContent = provider?.label || id;
      this._config.provider = id;
      apiKeyInput.value       = this._config.apiKeys?.[id] || '';
      apiKeyInput.placeholder = provider?.keyHint || 'API key';
      const keyLabel = sr.getElementById('gc__apiKeyLabel');
      if (keyLabel) keyLabel.textContent = `API Key — ${provider?.label || id}`;
    });

    // Selector de proveedor/modelo en Settings.
    if (settingsProvSel) {
      DomUtils.setHTML(
        settingsProvSel,
        Object.entries(GAS_LLM_PROVIDERS)
          .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
          .join('')
      );
    }
    settingsProvSel?.addEventListener('change', () => {
      const id        = settingsProvSel.value;
      const provider  = GAS_LLM_PROVIDERS[id];
      const allModels = [...(provider?.models || []), ...(this._config.customModels || [])];
      DomUtils.setHTML(settingsModelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
      if (this._config.provider === id && this._config.model) settingsModelSel.value = this._config.model;
    });
    settingsModelSel?.addEventListener('change', () => {
      this._config.model = settingsModelSel.value;
    });

    // Insertar contexto (@selection / @file / @project).
    ctxInsertBtn?.addEventListener('click', () => {
      const tag = ctxSelect?.value;
      if (!tag) return;
      this._insertTagAtCursor_(input, tag);
    });

    // Botones de cabecera.
    closeBtn?.addEventListener('click', () => this.close());
    clearBtn?.addEventListener('click', () => { this._messages = []; this._renderMessages_(); });
    settingsBtn?.addEventListener('click', () => this._openSettings_());

    // Settings.
    settingsClose?.addEventListener('click', () => this._closeSettings_());
    cancelBtn?.addEventListener('click',     () => this._closeSettings_());
    saveBtn?.addEventListener('click', () => {
      const activeProvider = providerSel?.value || settingsProvSel?.value || this._config.provider;
      const activeModel    = modelSel?.value    || settingsModelSel?.value || this._config.model;
      this._config.provider = activeProvider;
      this._config.model    = activeModel;
      const customModelsInput = sr.getElementById('gc__customModels');
      if (customModelsInput) {
        this._config.customModels = customModelsInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
      }
      this._config.apiKeys      = { ...this._config.apiKeys, [activeProvider]: apiKeyInput.value.trim() };
      this._config.temperature  = parseFloat(tempInput.value) || 0.3;
      this._config.systemPrompt = systemPrompt.value || this._config.systemPrompt;
      this._saveConfig();
      this._closeSettings_();
      this._refreshComposerProviderUI_();
      this._appendSystemNotice_('Settings saved.');
    });

    toggleKeyBtn?.addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    });
    tempInput?.addEventListener('input', () => { tempVal.textContent = tempInput.value; });

    // Delegación de clics en bloques de código (Copy / Insert / Replace).
    messages?.addEventListener('click', (e) => {
      const btn = e.target.closest('.gc__codeBtn');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const code   = btn.closest('.gc__codeWrap')?.querySelector('.gc__codeBlock')?.textContent || '';
      if (!code) return;
      if (action === 'copy')    this._copyToClipboard_(code, btn);
      if (action === 'insert')  this._insertAtCursor_(code);
      if (action === 'replace') this._replaceSelection_(code);
    });

    window.addEventListener('keydown', this._onWindowKeyDown);
  }

  /**
   * Maneja Escape: cierra settings si está abierto, o el panel completo.
   * @param {KeyboardEvent} e
   */
  _onWindowKeyDown(e) {
    if (e.key === 'Escape' && this.style.display === 'flex') {
      const settings = this.shadowRoot.getElementById('gc__settings');
      if (settings?.classList.contains('gc__open')) this._closeSettings_();
      else this.close();
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // RENDER DE MENSAJES + MARKDOWN
  // ──────────────────────────────────────────────────────────────────

  /** Re-renderiza la lista completa de mensajes y hace scroll al fondo. */
  _renderMessages_() {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;
    const intro = `
      <div class="gc__msg gc__system">
        Ask about your code. Use <b>@</b> to insert context: selection, file or project.
      </div>`;
    const html = this._messages.map((m) => {
      if (m.role === 'user') {
        return `<div class="gc__msg gc__user">${this._escapeHtml_(m.content)}</div>`;
      }
      if (m.role === 'system' || m._system) {
        return `<div class="gc__msg gc__system">${this._escapeHtml_(m.content)}</div>`;
      }
      const cls = m._isError ? 'gc__msg gc__assistant gc__error' : 'gc__msg gc__assistant';
      return `<div class="${cls}">${this._renderMarkdown_(m.content || '')}</div>`;
    }).join('');
    DomUtils.setHTML(container, intro + html);
    if (this._isStreaming) this._appendThinking_();
    container.scrollTop = container.scrollHeight;
  }

  /** Añade el indicador animado "Thinking..." al final de los mensajes (sin duplicar). */
  _appendThinking_() {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container || container.querySelector('.gc__thinking')) return;
    const div = document.createElement('div');
    div.className   = 'gc__thinking';
    div.textContent = 'Thinking';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Agrega un aviso de sistema al chat sin re-renderizar toda la lista.
   * @param {string} text
   */
  _appendSystemNotice_(text) {
    this._messages.push({ role: 'system', content: text, _system: true });
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className   = 'gc__msg gc__system';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /** Actualiza el botón Send según si hay una petición en curso. */
  _updateSendButton_() {
    const btn = this.shadowRoot.getElementById('gc__sendBtn');
    if (!btn) return;
    btn.disabled    = this._isStreaming;
    btn.textContent = this._isStreaming ? '...' : 'Send';
  }

  // ──────────────────────────────────────────────────────────────────
  // AUTOCOMPLETADO @
  // ──────────────────────────────────────────────────────────────────

  /**
   * Detecta si el cursor está después de un "@" y muestra el menú de mentions.
   * @param {HTMLTextAreaElement} input
   */
  _detectMention_(input) {
    const cursor = input.selectionStart ?? 0;
    const text   = input.value;
    let atPos = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') { atPos = i; break; }
      if (/\s/.test(ch)) break;
    }
    if (atPos === -1) { this._hideMentionMenu_(); return; }
    this._mentionStart = atPos;
    this._mentionQuery = text.slice(atPos + 1, cursor).toLowerCase();
    this._mentionIndex = 0;
    this._showMentionMenu_();
  }

  /** Filtra los items de mention y renderiza el menú flotante. */
  _showMentionMenu_() {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!menu) return;
    const filtered = this._mentionItems.filter((it) =>
      it.tag.toLowerCase().includes(this._mentionQuery) ||
      it.label.toLowerCase().includes(this._mentionQuery)
    );
    if (!filtered.length) { this._hideMentionMenu_(); return; }
    const html = `
      <div class="gc__mentionHeader">Context</div>
      ${filtered.map((it, idx) => `
        <button class="gc__mentionItem ${idx === this._mentionIndex ? 'gc__active' : ''}"
                data-index="${idx}" data-tag="${it.tag}">
          <div class="gc__mentionIcon">@</div>
          <div class="gc__mentionInfo">
            <div class="gc__mentionLabel">${it.label}</div>
            <div class="gc__mentionDesc">${it.desc}</div>
          </div>
        </button>`).join('')}
    `;
    DomUtils.setHTML(menu, html);
    menu.classList.add('gc__open');
    menu.onclick = (e) => {
      const btn = e.target.closest('.gc__mentionItem');
      if (!btn) return;

      this._insertTagAtCursor_(
        this.shadowRoot.getElementById('gc__chatInput'),
        btn.dataset.tag,
        this._mentionStart
      );

      this._hideMentionMenu_();
    };
  }

  /** Oculta el menú de mentions y resetea su estado. */
  _hideMentionMenu_() {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (menu) { menu.classList.remove('gc__open'); menu.onclick = null; }
    this._mentionStart = -1;
    this._mentionQuery = '';
    this._mentionIndex = -1;
  }

  /**
   * Mueve el foco entre items del menú de mentions.
   * @param {number} dir - +1 (abajo) o -1 (arriba)
   */
  _navigateMention_(dir) {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!menu) return;
    const items = menu.querySelectorAll('.gc__mentionItem');
    if (!items.length) return;
    this._mentionIndex = (this._mentionIndex + dir + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('gc__active', i === this._mentionIndex));
    items[this._mentionIndex]?.scrollIntoView({ block: 'nearest' });
  }

  /** Inserta el tag del item activo en el textarea y cierra el menú. */
  _selectMention_() {
    const input = this.shadowRoot.getElementById('gc__chatInput');
    const menu  = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!input || !menu) return;
    const tag = menu.querySelector('.gc__mentionItem.gc__active')?.dataset.tag;
    if (!tag) return;
    this._insertTagAtCursor_(input, tag, this._mentionStart);
    this._hideMentionMenu_();
  }

  /**
   * Inserta un tag en el textarea, opcionalmente reemplazando desde una posición de inicio.
   * @param {HTMLTextAreaElement} input
   * @param {string} tag
   * @param {number} [replaceFrom] - Índice desde el que reemplazar hasta el cursor actual.
   */
  _insertTagAtCursor_(input, tag, replaceFrom) {
    const start  = typeof replaceFrom === 'number' ? replaceFrom : (input.selectionStart ?? input.value.length);
    const end    = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after  = input.value.slice(end);
    const sep    = before && !before.endsWith(' ') ? ' ' : '';
    input.value  = before + sep + tag + ' ' + after;
    input.focus();
    input.dispatchEvent(new Event('input'));
  }

  /**
   * Renderiza Markdown básico a HTML seguro (escapa XSS).
   * Soporta: bloques de código, inline code, headings, listas, negrita, itálica, párrafos.
   * @param {string} src
   * @returns {string}
   */
  _renderMarkdown_(src) {
    const text = String(src || '');
    // Extrae bloques ``` para escaparlos por separado.
    const codeBlocks = [];
    let work = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: (lang || '').trim(), code });
      return `\u0000CODE${idx}\u0000`;
    });
    work = this._escapeHtml_(work);
    // Headings.
    work = work
      .replace(/^### (.*)$/gm, '<h3>$1</h3>')
      .replace(/^## (.*)$/gm,  '<h2>$1</h2>')
      .replace(/^# (.*)$/gm,   '<h1>$1</h1>');
    // Listas.
    work = work.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (_, block) => {
      const items = block.trim().split(/\n/).map((l) => l.replace(/^[-*]\s+/, ''));
      return '\n<ul>' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>';
    });
    // Inline code, negrita, itálica.
    work = work
      .replace(/`([^`]+)`/g,             '<code class="gc__inlineCode">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g,       '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // Párrafos.
    work = work.split(/\n{2,}/).map((para) => {
      if (/^\s*<(h\d|ul|ol|pre|div)/.test(para)) return para;
      return `<p>${para.replace(/\n/g, '<br>')}</p>`;
    }).join('');
    // Reinsertar bloques de código con botones de acción.
    work = work.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
      const { lang, code } = codeBlocks[Number(idx)];
      const escaped   = this._escapeHtml_(code.replace(/\n+$/, ''));
      const langLabel = lang || 'code';
      return `
        <div class="gc__codeWrap">
          <div class="gc__codeBar">
            <span>${this._escapeHtml_(langLabel)}</span>
            <div class="gc__codeBarBtns">
              <button class="gc__codeBtn" data-action="copy"    title="Copy">Copy</button>
              <button class="gc__codeBtn" data-action="insert"  title="Insert at cursor">Insert</button>
              <button class="gc__codeBtn" data-action="replace" title="Replace selection">Replace</button>
            </div>
          </div>
          <pre class="gc__codeBlock"><code>${escaped}</code></pre>
        </div>`;
    });
    return work;
  }

  /**
   * Escapa caracteres especiales de HTML para prevenir XSS.
   * @param {string} s
   * @returns {string}
   */
  _escapeHtml_(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
      const original = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch (_) {
      this._appendSystemNotice_('Could not copy to clipboard.');
    }
  }

  /**
   * Inserta texto en la posición del cursor en Monaco (sin reemplazar selección).
   * @param {string} text
   */
  _insertAtCursor_(text) {
    if (!this._editor) return this._appendSystemNotice_('Editor not available.');
    try {
      const sel = this._editor.getSelection();
      if (!sel) return;
      this._editor.executeEdits('gas-chat', [{
        range: {
          startLineNumber: sel.startLineNumber,
          startColumn:     sel.startColumn,
          endLineNumber:   sel.startLineNumber,
          endColumn:       sel.startColumn,
        },
        text,
        forceMoveMarkers: true,
      }]);
      this._editor.focus();
    } catch (_) { /* noop */ }
  }

  /**
   * Reemplaza la selección activa en Monaco con el texto dado.
   * @param {string} text
   */
  _replaceSelection_(text) {
    if (!this._editor) return this._appendSystemNotice_('Editor not available.');
    try {
      const sel = this._editor.getSelection();
      if (!sel) return;
      this._editor.executeEdits('gas-chat', [{ range: sel, text, forceMoveMarkers: true }]);
      this._editor.focus();
    } catch (_) { /* noop */ }
  }

  // ──────────────────────────────────────────────────────────────────
  // SETTINGS UI
  // ──────────────────────────────────────────────────────────────────

  /** Abre el overlay de settings y sincroniza sus campos. */
  _openSettings_() {
    this._refreshSettingsUI_();
    this.shadowRoot.getElementById('gc__settings')?.classList.add('gc__open');
  }

  /** Cierra el overlay de settings. */
  _closeSettings_() {
    this.shadowRoot.getElementById('gc__settings')?.classList.remove('gc__open');
  }

  /** Sincroniza el composer (proveedor, modelo, pill) con this._config. */
  _refreshComposerProviderUI_() {
    const sr          = this.shadowRoot;
    const providerSel = sr.getElementById('gc__providerSelect');
    const modelSel    = sr.getElementById('gc__modelSelect');
    const pill        = sr.getElementById('gc__providerPill');
    if (!providerSel) return;
    providerSel.value  = this._config.provider || 'gemini';
    const provider     = GAS_LLM_PROVIDERS[providerSel.value] || GAS_LLM_PROVIDERS.gemini;
    const allModels    = [...(provider.models || []), ...(this._config.customModels || [])];
    DomUtils.setHTML(modelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
    modelSel.value     = this._config.model || allModels[0] || '';
    if (pill) pill.textContent = provider.label;
  }

  /** Sincroniza todos los campos del overlay de settings con this._config. */
  _refreshSettingsUI_() {
    const sr              = this.shadowRoot;
    const settingsProvSel = sr.getElementById('gc__settingsProviderSelect');
    const settingsModelSel= sr.getElementById('gc__settingsModelSelect');
    const apiKeyInput     = sr.getElementById('gc__apiKeyInput');
    const tempInput       = sr.getElementById('gc__tempInput');
    const tempVal         = sr.getElementById('gc__tempVal');
    const sysPrompt       = sr.getElementById('gc__systemPrompt');
    const keyLabel        = sr.getElementById('gc__apiKeyLabel');
    const providerId = this._config.provider || 'gemini';
    const provider   = GAS_LLM_PROVIDERS[providerId] || GAS_LLM_PROVIDERS.gemini;
    if (settingsProvSel) {
      DomUtils.setHTML(
        settingsProvSel,
        Object.entries(GAS_LLM_PROVIDERS)
          .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
          .join('')
      );
      settingsProvSel.value = providerId;
    }
    const allModels = [...(provider.models || []), ...(this._config.customModels || [])];
    if (settingsModelSel) {
      DomUtils.setHTML(settingsModelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
      settingsModelSel.value = this._config.model || allModels[0] || '';
    }
    apiKeyInput.value       = this._config.apiKeys?.[providerId] || '';
    apiKeyInput.placeholder = provider.keyHint || 'API key';
    if (keyLabel) keyLabel.textContent = `API Key — ${provider.label}`;
    tempInput.value     = String(this._config.temperature ?? 0.3);
    tempVal.textContent = String(this._config.temperature ?? 0.3);
    sysPrompt.value     = this._config.systemPrompt || '';
    const customModelsInput = sr.getElementById('gc__customModels');
    if (customModelsInput) {
      customModelsInput.value = (this._config.customModels || []).join('\n');
    }
    this._refreshComposerProviderUI_();
  }
}

// Registro idempotente del Web Component.
if (!customElements.get('gas-chat-panel')) {
  customElements.define('gas-chat-panel', GasChatPanel);
}