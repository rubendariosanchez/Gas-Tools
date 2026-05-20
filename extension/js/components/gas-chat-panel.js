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
  deepseek: {
    label: 'DeepSeek',
    icon: '⬡',
    color: '#7b68ee',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'sk-...',
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
      'deepseek-chat',
      'deepseek-coder',
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
      'deepseek-ai/deepseek-v3.2',
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
      'deepseek/deepseek-v4-flash',
      'google/gemini-3-flash-preview',
      'x-ai/grok-4.1-fast',
    ],
    keyHint: 'sk-or-v1-...',
  },
  custom: {
    label: 'Local Provider',
    icon: '⚙',
    color: '#a0aec0',
    models: [],
    keyHint: 'API Key (Optional)',
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
      theme: 'light',
      // Configuración por proveedor: { providerId: { temperature, systemPrompt, customModels } }
      providerSettings: {},
    };

    /** @type {boolean} Indica si hay una petición LLM en curso. */
    this._isStreaming = false;

    /** @type {string|null} ID de la petición en curso. */
    this._currentRequestId = null;

    /** @type {Map<string, Function>} Resolvers pendientes para llamadas al bridge. */
    this._pendingBridgeCalls = new Map();

    // Estado del menú de autocompletado con `@`.
    // El elemento DOM se obtiene via `shadowRoot.getElementById('gc__mentionMenu')`
    // cuando se necesita; aquí solo guardamos índice, posición y query.
    this._mentionIndex = -1;
    this._mentionStart = -1;
    this._mentionQuery = '';

    // Binds explícitos para poder remover los listeners después.
    this._onLlmResponse   = this._onLlmResponse.bind(this);
    this._onBridgeResult  = this._onBridgeResult.bind(this);
    this._onWindowKeyDown = this._onWindowKeyDown.bind(this);
    this._onResizeMove  = this._onResizeMove.bind(this);
    this._onResizeEnd   = this._onResizeEnd.bind(this);

    // Items disponibles para el autocompletado con @.
    this._mentionItems = [
      { tag: '@selection', label: 'Selected text',  desc: 'Insert current editor selection', icon: '⌗' },
      { tag: '@file',      label: 'Active file',    desc: 'Insert full content of the open file', icon: '◻' },
      { tag: '@project',   label: 'Entire project', desc: 'Insert all project files', icon: '⬡' },
    ];

    /** @type {{startX:number, startY:number, startW:number, startH:number}|null} Estado del resize manual. */
    this._resizeState = null;
  }

  // ──────────────────────────────────────────────────────────────────
  // CICLO DE VIDA
  // ──────────────────────────────────────────────────────────────────

  /** Renderiza el shell, conecta listeners globales y carga la configuración. */
  connectedCallback() {
    this._render();
    this._setupListeners();
    document.addEventListener('GAS_LLM_RESPONSE', this._onLlmResponse);
    document.addEventListener('GAS_LLM_CONFIG_RESULT', this._onBridgeResult);
    this._loadConfig();
  }

  /** Libera todos los listeners globales para evitar memory leaks. */
  disconnectedCallback() {
    document.removeEventListener('GAS_LLM_RESPONSE', this._onLlmResponse);
    document.removeEventListener('GAS_LLM_CONFIG_RESULT', this._onBridgeResult);
    window.removeEventListener('keydown', this._onWindowKeyDown);
    window.removeEventListener('mousemove', this._onResizeMove);
    window.removeEventListener('mouseup', this._onResizeEnd);
  }

  // ──────────────────────────────────────────────────────────────────
  // API PÚBLICA
  // ──────────────────────────────────────────────────────────────────

  /**
   * Inyecta la instancia activa de Monaco. Llamado desde gas-tools.js cuando
   * se crea o cambia el editor.
   * @param {object|null} editor
   */
  setEditor(editor) {
    this._editor = editor || null;
  }

  /**
   * Abre el panel y enfoca el textarea. Cierra el panel de búsqueda si está
   * abierto (solo uno visible a la vez).
   */
  open() {
    document.querySelector('gas-search-panel')?.close?.();
    document.querySelector('gas-actions-panel')?.close?.();
    document.querySelector('gas-current-file')?.close?.();
    document.querySelector('gas-github-panel')?.close?.();
    this.style.display = 'flex';
    this.style.pointerEvents = 'auto';
    setTimeout(() => {
      this.shadowRoot.getElementById('gc__chatInput')?.focus();
    }, 30);
  }

  /** Cierra el panel y deshabilita interacciones. */
  close() {
    this.style.display = 'none';
    this.style.pointerEvents = 'none';
  }

  /** Alterna entre abierto y cerrado. */
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
          providerSettings: { ...this._config.providerSettings, ...(cfg.providerSettings || {}) },
        };
      }

      // Aplicar tema desde config (por defecto: claro)
      this._applyTheme_(this._config.theme || 'light');
      this._loadAiContext_();
      this._refreshComposerProviderUI_();
      this._refreshSettingsUI_();
    });
  }

  /** Aplica el tema al panel. */
  _applyTheme_(theme) {
    if (theme === 'light') {
      this.setAttribute('theme', 'light');
    } else {
      this.removeAttribute('theme');
    }
    const btn = this.shadowRoot?.getElementById('gc__themeToggle');
    if (btn) btn.textContent = theme === 'light' ? '☀' : '🌙';
  }

  /** Alterna entre tema claro y oscuro. */
  _toggleTheme_() {
    const newTheme = this._config.theme === 'light' ? 'dark' : 'light';
    this._config.theme = newTheme;
    this._applyTheme_(newTheme);
    this._saveConfig();
  }

  /** Carga el AI Context global desde el background. */
  _loadAiContext_() {
    this._bridgeCall_('GAS_LLM_GET_GLOBAL_AI_CONTEXT').then((context) => {
      if (context) this._config.aiContext = context;
    });
  }

  /** Persiste la configuración actual en chrome.storage.sync vía bridge (fire-and-forget). */
  _saveConfig() {
    document.dispatchEvent(
      new CustomEvent('GAS_LLM_SAVE_CONFIG', {
        detail: JSON.stringify(this._config),
      })
    );
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
      systemPrompt:
`You are a senior Google Apps Script (GAS) developer with deep expertise in Google Workspace automation.
Write clean, modern ES6+ code following GAS best practices. Prefer native Workspace services (SpreadsheetApp, DriveApp, GmailApp, etc.) over external APIs.
Include error handling, logging and JSDoc on triggers and custom functions.
Respond in English with practical, production-ready code examples.`,
      customModels: [],
      endpointUrl: '',
    };
    return {
      ...defaults,
      ...((this._config.providerSettings || {})[providerId] || {}),
    };
  }

  /**
   * Envía un evento al bridge y resuelve cuando llega la respuesta con
   * el mismo `requestId`. Si pasan 10 s sin respuesta, resuelve con `null`.
   * @param {string} eventName
   * @param {object} [payload]
   * @returns {Promise<any>}
   * @private
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
      document.dispatchEvent(
        new CustomEvent(eventName, {
          detail: JSON.stringify({ requestId, ...payload }),
        })
      );
    });
  }

  /**
   * Recibe resultados del bridge y dispara el resolver de la promesa
   * que coincida con el `requestId`.
   * @param {CustomEvent} e
   * @private
   */
  _onBridgeResult(e) {
    try {
      const { requestId, data } = JSON.parse(e.detail);
      const resolver = this._pendingBridgeCalls.get(requestId);
      if (resolver) {
        this._pendingBridgeCalls.delete(requestId);
        resolver(data);
      }
    } catch (_) { /* payload corrupto: ignorar */ }
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
    if (!apiKey && provider !== 'custom') {
      this._appendSystemNotice_(
        `Missing API key for ${GAS_LLM_PROVIDERS[provider]?.label || provider}. Configure it in Settings.`
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

    // Obtener settings del proveedor actual.
    const provSettings = this._getProviderSettings_(provider);

    // Combinar systemPrompt con AI Context del proyecto.
    let systemContent = provSettings.systemPrompt;
    if (this._config.aiContext) {
      systemContent += '\n\n--- Project Context ---\n' + this._config.aiContext;
    }

    const apiMessages = [
      { role: 'system', content: systemContent },
      ...this._messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m._expanded || m.content })),
    ];

    this._currentRequestId = `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    document.dispatchEvent(
      new CustomEvent('GAS_LLM_REQUEST', {
        detail: JSON.stringify({
          requestId: this._currentRequestId,
          provider,
          apiKey,
          model,
          temperature: provSettings.temperature,
          endpointUrl: provSettings.endpointUrl,
          messages: apiMessages,
        }),
      })
    );
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
    DomUtils.setHTML(
      this.shadowRoot,
      `<style>
        /* ── Google Fonts import ── */
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,400&family=DM+Mono:wght@400;500&display=swap');

/* ── Design tokens ── */
        :host {
          /* Default: dark theme (no attribute) */          
          --gc-color-message: #ddeeff;
          --gc-bg:          #16181c;
          --gc-bg-raised:   #1e2027;
          --gc-bg-elevated: #262830;
          --gc-bg-input:    #1a1c23;
          --gc-border:      rgba(255,255,255,.08);
          --gc-border-focus:rgba(99,179,237,.5);

          /* Text */
          --gc-text:        #e8eaed;
          --gc-text-muted:  #8b8fa8;
          --gc-text-faint:  #4a4d5e;

          /* Accents */
          --gc-accent:      #63b3ed;
          --gc-accent-dim:  rgba(99,179,237,.12);
          --gc-accent-glow: rgba(99,179,237,.25);
          --gc-green:       #68d391;
          --gc-red:         #fc8181;
          --gc-amber:       #f6ad55;

          /* User bubble */
          --gc-user-bg:     #2d3a52;
          --gc-user-border: rgba(99,179,237,.2);

          /* Code */
          --gc-code-bg:     #11131a;
          --gc-code-border: rgba(255,255,255,.06);

          /* Radii */
          --gc-r-sm:  6px;
          --gc-r-md:  10px;
          --gc-r-lg:  14px;
          --gc-r-xl:  18px;
          --gc-r-pill:999px;

          /* Shadows */
          --gc-shadow-panel: 0 32px 64px rgba(0,0,0,.7), 0 8px 24px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.05);
          --gc-shadow-menu:  0 16px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.07);

          /* Typography */
          --gc-font: 'DM Sans', system-ui, sans-serif;
          --gc-mono: 'DM Mono', 'Fira Code', Consolas, monospace;

          /* Transitions */
          --gc-ease: cubic-bezier(.16,1,.3,1);
        }

        /* Theme: light */
        :host([theme="light"]) {
          --gc-color-message: #1a0a0a;
          --gc-bg:          #fefefe;
          --gc-bg-raised:   #f8f9fa;
          --gc-bg-elevated:  #ffffff;
          --gc-bg-input:    #fafbfc;
          --gc-border:      rgba(0,0,0,.09);
          --gc-border-focus:rgba(26,115,232,.5);

          /* Text */
          --gc-text:        #202124;
          --gc-text-muted:  #5f6368;
          --gc-text-faint:  #9aa0a6;

          /* Accents */
          --gc-accent:      #1a73e8;
          --gc-accent-dim:  rgba(26,115,232,.08);
          --gc-accent-glow: rgba(26,115,232,.2);
          --gc-green:       #1e8e3e;
          --gc-red:        #d93025;
          --gc-amber:      #ea8600;

          /* User bubble */
          --gc-user-bg:     #e8f0fe;
          --gc-user-border: rgba(26,115,232,.15);

          /* Code */
          --gc-code-bg:     #f5f5f5;
          --gc-code-border: rgba(0,0,0,.06);

          /* Shadows */
          --gc-shadow-panel: 0 32px 64px rgba(0,0,0,.25), 0 8px 24px rgba(0,0,0,.15), 0 0 0 1px rgba(0,0,0,.08);
          --gc-shadow-menu:  0 16px 40px rgba(0,0,0,.2), 0 0 0 1px rgba(0,0,0,.06);
        }

        /* ── Host shell ── */
        :host {
          display: none;
          pointer-events: none;
          position: fixed;
          top: 120px;
          right: 14px;
          left: auto;
          transform: none;
          z-index: 2147483640;
          width: min(400px, calc(100vw - 28px));
          height: calc(100vh - 140px);
          min-width: 340px;
          min-height: 400px;
          max-width: calc(100vw - 18px);
          max-height: calc(100vh - 120px);
          font-family: var(--gc-font);
          color: var(--gc-text);
          border-radius: var(--gc-r-xl);
          overflow: hidden;
          box-shadow: var(--gc-shadow-panel);
          background: var(--gc-bg);
          border: 1px solid rgba(0,0,0,.08);
          animation: gc__panelIn .22s var(--gc-ease);
        }

        @keyframes gc__panelIn {
          from { transform: translateY(-8px); opacity: 0; scale: .97; }
          to   { transform: translateY(0); opacity: 1; scale: 1; }
        }

        /* Theme: light - overrides */
        :host([theme="light"]) {
          --gc-bg:          #fefefe;
          --gc-bg-raised:   #f8f9fa;
          --gc-bg-elevated:  #ffffff;
          --gc-bg-input:    #ffffff;
          --gc-border:      rgba(0,0,0,.12);
          --gc-border-focus:rgba(26,115,232,.5);

          /* Text */
          --gc-text:        #202124;
          --gc-text-muted:  #5f6368;
          --gc-text-faint:  #9aa0a6;

          /* Accents */
          --gc-accent:      #1a73e8;
          --gc-accent-dim:  rgba(26,115,232,.1);
          --gc-accent-glow: rgba(26,115,232,.25);
          --gc-green:       #1e8e3e;
          --gc-red:        #d93025;
          --gc-amber:      #ea8600;

          /* User bubble */
          --gc-user-bg:     #e8f0fe;
          --gc-user-border: rgba(26,115,232,.2);

          /* Code */
          --gc-code-bg:     #f8f9fa;
          --gc-code-border: rgba(0,0,0,.08);

          /* Shadows */
          --gc-shadow-panel: 0 8px 32px rgba(0,0,0,.15), 0 2px 8px rgba(0,0,0,.1);
        }

        /* Light: input text color override */
        :host([theme="light"]) .gc__textarea,
        :host([theme="light"]) .gc__textInput,
        :host([theme="light"]) .gc__textareaCfg {
          color: #1a0a0a !important;
        }

        :host([theme="light"]) .gc__textarea::placeholder {
          color: #9aa0a6 !important;
        }

        /* ── Shell layout ── */
        .gc__shell {
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          overflow: hidden;
        }

        /* ────────────────────────────────────────
           HEADER
        ──────────────────────────────────────── */
        .gc__header {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 14px;
          cursor: default;
          user-select: none;
          background: var(--gc-bg-raised);
          border-bottom: 1px solid var(--gc-border);
          position: relative;
          z-index: 1;
        }

        /* Subtle top gradient accent */
        .gc__header::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, var(--gc-accent-glow), transparent);
        }

        .gc__headerIcon {
          width: 28px; height: 28px;
          border-radius: var(--gc-r-sm);
          display: grid; place-items: center;
          font-size: 14px;
          background: var(--gc-accent-dim);
          color: var(--gc-accent);
          flex: 0 0 auto;
          position: relative;
        }

        /* Animated glow dot */
        .gc__headerIcon::after {
          content: '';
          position: absolute;
          bottom: -1px; right: -1px;
          width: 7px; height: 7px;
          border-radius: 50%;
          background: var(--gc-green);
          border: 1.5px solid var(--gc-bg-raised);
          animation: gc__pulse 2.5s ease infinite;
        }

        @keyframes gc__pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(104,211,145,.4); }
          50%       { box-shadow: 0 0 0 4px rgba(104,211,145,0); }
        }

        .gc__title {
          font-size: 13px;
          font-weight: 600;
          flex: 1;
          letter-spacing: -.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .gc__title span {
          color: var(--gc-text-muted);
          font-weight: 400;
        }

        /* Provider badge in header */
        .gc__providerBadge {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 500;
          padding: 3px 8px 3px 6px;
          border-radius: var(--gc-r-pill);
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          color: var(--gc-text-muted);
          transition: color .15s;
        }

        .gc__providerBadge-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: var(--gc-accent);
          flex-shrink: 0;
        }

        /* Header icon buttons */
        .gc__hBtn {
          width: 28px; height: 28px;
          border: none;
          background: transparent;
          color: var(--gc-text-muted);
          border-radius: var(--gc-r-sm);
          cursor: pointer;
          display: grid; place-items: center;
          font-size: 14px;
          transition: background .12s, color .12s;
          flex-shrink: 0;
        }

        .gc__hBtn:hover {
          background: var(--gc-bg-elevated);
          color: var(--gc-text);
        }

        .gc__hBtn:focus-visible {
          outline: 2px solid var(--gc-accent);
          outline-offset: 1px;
        }

        /* Close button special style */
        .gc__hBtn--close:hover {
          background: rgba(252,129,129,.12);
          color: var(--gc-red);
        }

        /* Theme toggle button */
        .gc__themeToggle {
          width: 28px; height: 28px;
          border: none;
          background: transparent;
          color: var(--gc-text-muted);
          border-radius: var(--gc-r-sm);
          cursor: pointer;
          display: grid; place-items: center;
          font-size: 13px;
          transition: background .12s, color .12s;
          flex-shrink: 0;
        }

        .gc__themeToggle:hover {
          background: var(--gc-bg-elevated);
          color: var(--gc-accent);
        }

        /* Resize handle */
        .gc__resizeHandle {
          position: absolute;
          left: 0;
          bottom: 0;
          width: 16px;
          height: 16px;
          cursor: nesw-resize;
          background:
            linear-gradient(225deg, transparent 0 45%, rgba(95,99,104,.45) 45% 55%, transparent 55% 100%);
        }

        /* ────────────────────────────────────────
           MESSAGES AREA
        ──────────────────────────────────────── */
        .gc__messages {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 16px 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: var(--gc-bg);
          /* Custom scrollbar */
          scrollbar-width: thin;
          scrollbar-color: var(--gc-border) transparent;
        }

        .gc__messages::-webkit-scrollbar { width: 4px; }
        .gc__messages::-webkit-scrollbar-track { background: transparent; }
        .gc__messages::-webkit-scrollbar-thumb { background: var(--gc-border); border-radius: 4px; }

        /* System / intro notice */
        .gc__msg--system {
          align-self: center;
          font-size: 11px;
          color: var(--gc-text-muted);
          background: var(--gc-bg-raised);
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-pill);
          padding: 5px 12px;
          text-align: center;
          line-height: 1.5;
        }

        .gc__msg--system b {
          color: var(--gc-accent);
          font-weight: 600;
        }

        /* User message */
        .gc__msg--user {
          align-self: flex-end;
          max-width: 85%;
          background: var(--gc-user-bg);
          border: 1px solid var(--gc-user-border);
          border-radius: var(--gc-r-lg) var(--gc-r-lg) 4px var(--gc-r-lg);
          padding: 10px 13px;
          font-size: 13.5px;
          line-height: 1.55;
          color: var(--gc-color-message);
          word-break: break-word;
        }

        /* Assistant message */
        .gc__msg--assistant {
          align-self: flex-start;
          max-width: 92%;
          display: flex;
          gap: 10px;
        }

        .gc__assistantAvatar {
          width: 24px; height: 24px;
          border-radius: var(--gc-r-sm);
          background: var(--gc-accent-dim);
          color: var(--gc-accent);
          display: grid; place-items: center;
          font-size: 12px;
          flex: 0 0 auto;
          margin-top: 2px;
        }

        .gc__assistantBody {
          background: var(--gc-bg-raised);
          border: 1px solid var(--gc-border);
          border-radius: 4px var(--gc-r-lg) var(--gc-r-lg) var(--gc-r-lg);
          padding: 10px 13px;
          font-size: 13.5px;
          line-height: 1.6;
          color: var(--gc-text);
          word-break: break-word;
          min-width: 0;
          flex: 1;
        }

        .gc__assistantBody p  { margin: 0 0 8px; }
        .gc__assistantBody p:last-child { margin-bottom: 0; }
        .gc__assistantBody ul,
        .gc__assistantBody ol { margin: 6px 0 6px 20px; padding: 0; }
        .gc__assistantBody li { margin-bottom: 3px; }
        .gc__assistantBody h1,
        .gc__assistantBody h2,
        .gc__assistantBody h3,
        .gc__assistantBody h4,
        .gc__assistantBody h5,
        .gc__assistantBody h6 {
          margin: 10px 0 5px;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: -.01em;
        }
        .gc__assistantBody h1 { font-size: 17px; }
        .gc__assistantBody h2 { font-size: 15px; }
        .gc__assistantBody h3 { font-size: 14px; }

        /* Markdown — blockquote (citas) */
        .gc__assistantBody blockquote {
          margin: 8px 0;
          padding: 4px 12px;
          border-left: 3px solid var(--gc-border);
          color: var(--gc-text-muted);
          background: rgba(255,255,255,.02);
        }

        /* Markdown — regla horizontal */
        .gc__assistantBody hr {
          border: none;
          border-top: 1px solid var(--gc-border);
          margin: 12px 0;
        }

        /* Markdown — enlace */
        .gc__assistantBody a {
          color: var(--gc-accent);
          text-decoration: none;
          border-bottom: 1px solid transparent;
          transition: border-color .12s;
        }
        .gc__assistantBody a:hover { border-bottom-color: var(--gc-accent); }

        /* Markdown — tachado */
        .gc__assistantBody del {
          color: var(--gc-text-faint);
          text-decoration: line-through;
        }

        /* Markdown — tabla GFM */
        .gc__assistantBody table.gc__table {
          width: 100%;
          margin: 8px 0;
          border-collapse: collapse;
          font-size: 12.5px;
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-sm);
          overflow: hidden;
        }
        .gc__assistantBody table.gc__table th,
        .gc__assistantBody table.gc__table td {
          padding: 6px 10px;
          border-bottom: 1px solid var(--gc-border);
          text-align: left;
        }
        .gc__assistantBody table.gc__table th {
          background: rgba(255,255,255,.03);
          font-weight: 600;
        }
        .gc__assistantBody table.gc__table tr:last-child td { border-bottom: none; }

        /* Error state */
        .gc__assistantBody--error {
          background: rgba(252,129,129,.06);
          border-color: rgba(252,129,129,.2);
          color: var(--gc-red);
        }

        /* Thinking indicator */
        .gc__thinking {
          align-self: flex-start;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .gc__thinkingAvatar {
          width: 24px; height: 24px;
          border-radius: var(--gc-r-sm);
          background: var(--gc-accent-dim);
          color: var(--gc-accent);
          display: grid; place-items: center;
          font-size: 12px;
          flex: 0 0 auto;
        }

        .gc__thinkingDots {
          display: flex; gap: 4px; padding: 10px 13px;
          background: var(--gc-bg-raised);
          border: 1px solid var(--gc-border);
          border-radius: 4px var(--gc-r-lg) var(--gc-r-lg) var(--gc-r-lg);
        }

        .gc__thinkingDots span {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: var(--gc-text-muted);
          animation: gc__bounce 1.3s ease infinite;
        }

        .gc__thinkingDots span:nth-child(2) { animation-delay: .15s; }
        .gc__thinkingDots span:nth-child(3) { animation-delay: .3s; }

        @keyframes gc__bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: .4; }
          30%            { transform: translateY(-5px); opacity: 1; }
        }

        /* ────────────────────────────────────────
           CODE BLOCKS
        ──────────────────────────────────────── */
        .gc__codeWrap {
          margin: 8px 0;
          border-radius: var(--gc-r-md);
          overflow: hidden;
          border: 1px solid var(--gc-code-border);
          background: var(--gc-code-bg);
        }

        .gc__codeBar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 7px 12px;
          background: rgba(255,255,255,.03);
          border-bottom: 1px solid var(--gc-code-border);
        }
        :host([theme="light"]) .gc__codeBar {
          background: rgba(0,0,0,.03);
        }

        .gc__codeLang {
          font-family: var(--gc-mono);
          font-size: 10px;
          font-weight: 500;
          color: var(--gc-text-faint);
          text-transform: uppercase;
          letter-spacing: .06em;
        }

        .gc__codeBarBtns { display: flex; gap: 3px; }

        .gc__codeBtn {
          border: 1px solid transparent;
          background: transparent;
          color: var(--gc-text-muted);
          font-family: var(--gc-font);
          font-size: 10px;
          font-weight: 500;
          padding: 3px 8px;
          border-radius: var(--gc-r-sm);
          cursor: pointer;
          transition: all .12s;
          letter-spacing: .01em;
        }

        .gc__codeBtn:hover {
          background: var(--gc-accent-dim);
          color: var(--gc-accent);
          border-color: rgba(99,179,237,.2);
        }

        .gc__codeBtn--success {
          color: var(--gc-green) !important;
          background: rgba(104,211,145,.1) !important;
          border-color: rgba(104,211,145,.2) !important;
        }

        .gc__codeBlock {
          margin: 0;
          padding: 12px 14px;
          font-family: var(--gc-mono);
          font-size: 12px;
          line-height: 1.6;
          color: #c9d1d9;
          overflow-x: auto;
          white-space: pre;
          scrollbar-width: thin;
          scrollbar-color: var(--gc-border) transparent;
        }
        :host([theme="light"]) .gc__codeBlock {
          color: #1f2328;
        }

        .gc__inlineCode {
          font-family: var(--gc-mono);
          font-size: 11.5px;
          padding: 2px 5px;
          border-radius: 4px;
          background: rgba(255,255,255,.06);
          border: 1px solid rgba(255,255,255,.08);
          color: #a5f3fc;
        }

        /* Resaltado de sintaxis en bloques de código.
           Paleta inspirada en GitHub Dark / one-dark, neutra y legible. */
        .gc__codeBlock .hl-comment { color: #8b949e; font-style: italic; }
        .gc__codeBlock .hl-keyword { color: #ff7b72; }
        .gc__codeBlock .hl-string  { color: #a5d6ff; }
        .gc__codeBlock .hl-number  { color: #79c0ff; }
        .gc__codeBlock .hl-builtin { color: #d2a8ff; }
        .gc__codeBlock .hl-fn      { color: #d2a8ff; }
        .gc__codeBlock .hl-prop    { color: #7ee787; }
        .gc__codeBlock .hl-unit    { color: #ffa657; }

        :host([theme="light"]) .gc__codeBlock .hl-comment { color: #6e7781; }
        :host([theme="light"]) .gc__codeBlock .hl-keyword { color: #cf222e; }
        :host([theme="light"]) .gc__codeBlock .hl-string  { color: #0a3069; }
        :host([theme="light"]) .gc__codeBlock .hl-number  { color: #0550ae; }
        :host([theme="light"]) .gc__codeBlock .hl-builtin { color: #8250df; }
        :host([theme="light"]) .gc__codeBlock .hl-fn      { color: #8250df; }
        :host([theme="light"]) .gc__codeBlock .hl-prop    { color: #116329; }
        :host([theme="light"]) .gc__codeBlock .hl-unit    { color: #953800; }

        /* ────────────────────────────────────────
           COMPOSER
        ──────────────────────────────────────── */
        .gc__composer {
          flex: 0 0 auto;
          background: var(--gc-bg-raised);
          border-top: 1px solid var(--gc-border);
          padding: 10px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          position: relative;
        }

        /* ── Provider/Model selector row ── */
        .gc__providerRow {
          display: flex;
          align-items: center;
          gap: 0;
          background: var(--gc-bg-input);
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-md);
          overflow: hidden;
          height: 34px;
        }

        .gc__providerSeg {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 10px;
          flex: 1;
          min-width: 0;
          height: 100%;
          position: relative;
        }

        /* Divider between segments */
        .gc__providerSeg + .gc__providerSeg::before {
          content: '';
          position: absolute;
          left: 0; top: 20%; bottom: 20%;
          width: 1px;
          background: var(--gc-border);
        }

        .gc__segLabel {
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: .08em;
          color: var(--gc-text-faint);
          flex-shrink: 0;
        }

        .gc__miniSelect {
          border: none;
          background: transparent;
          color: var(--gc-text);
          font-family: var(--gc-font);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          outline: none;
          flex: 1;
          min-width: 0;
          padding: 0;
          appearance: none;
          -webkit-appearance: none;
          /* Custom chevron */
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b8fa8' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 2px center;
          padding-right: 16px;
        }

        .gc__miniSelect:focus { color: var(--gc-accent); }

        /* Provider icon dot */
        .gc__providerDot {
          width: 7px; height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
          background: var(--gc-accent);
        }

        /* ── Textarea + Send row ── */
        .gc__inputRow {
          display: flex;
          align-items: flex-end;
          gap: 8px;
        }

        .gc__textareaWrap {
          flex: 1;
          position: relative;
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-md);
          background: var(--gc-bg-input);
          transition: border-color .15s, box-shadow .15s;
        }

        .gc__textareaWrap:focus-within {
          border-color: var(--gc-border-focus);
          box-shadow: 0 0 0 3px var(--gc-accent-dim);
        }

        .gc__textarea {
          display: block;
          width: 100%;
          resize: none;
          min-height: 38px;
          max-height: 160px;
          border: none;
          border-radius: var(--gc-r-md);
          outline: none;
          font-size: 13px;
          font-family: var(--gc-font);
          background: transparent;
          color: var(--gc-text);
          padding: 9px 12px;
          line-height: 1.5;
          box-sizing: border-box;
        }

        .gc__textarea::placeholder { color: var(--gc-text-faint); }

        /* Send button */
        .gc__sendBtn {
          height: 38px;
          min-width: 38px;
          width: 66px;
          padding: 0 14px;
          background: var(--gc-accent);
          color: #0f1923;
          border: none;
          border-radius: var(--gc-r-md);
          font-family: var(--gc-font);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          transition: background .12s, transform .1s, box-shadow .12s;
          flex-shrink: 0;
          box-sizing: border-box;
          letter-spacing: .01em;
        }

        .gc__sendBtn:hover:not(:disabled) {
          background: #90cdf4;
          box-shadow: 0 4px 12px rgba(99,179,237,.35);
          transform: translateY(-1px);
        }

        .gc__stopIcon { display: none; }

        .gc__sendBtn:active:not(:disabled) {
          transform: translateY(0);
        }

        .gc__sendBtn:disabled {
          background: var(--gc-bg-elevated);
          color: var(--gc-text-faint);
          cursor: not-allowed;
        }

        /* Loading state with cancel - show spinner */
        .gc__sendBtn--loading.gc__sendBtn--cancel .gc__sendIcon { display: none; }
        .gc__sendBtn--loading.gc__sendBtn--cancel .gc__stopIcon { display: none; }
        .gc__sendBtn--loading.gc__sendBtn--cancel::after {
          content: '';
          width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,.2);
          border-top-color: var(--gc-text-muted);
          border-radius: 50%;
          animation: gc__spin .6s linear infinite;
        }
        /* On hover: hide spinner, show stop icon, red background */
        .gc__sendBtn--loading.gc__sendBtn--cancel:hover::after { display: none; }
        .gc__sendBtn--loading.gc__sendBtn--cancel:hover .gc__sendIcon { display: none; }
        .gc__sendBtn--loading.gc__sendBtn--cancel:hover .gc__stopIcon { display: block; }
        .gc__sendBtn--loading.gc__sendBtn--cancel:hover {
          background: var(--gc-red);
          transform: none;
        }

        @keyframes gc__spin {
          to { transform: rotate(360deg); }
        }

        /* Hint bar */
        .gc__hint {
          font-size: 10px;
          color: var(--gc-text-faint);
          padding: 0 2px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .gc__hintKey {
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-radius: 3px;
          padding: 0px 4px;
          font-size: 9px;
          color: var(--gc-text-muted);
          font-family: var(--gc-mono);
        }

        /* ────────────────────────────────────────
           MENTION MENU (@)
        ──────────────────────────────────────── */
        .gc__mentionMenu {
          position: absolute;
          bottom: calc(100% + 6px);
          left: 12px;
          z-index: 20;
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-lg);
          box-shadow: var(--gc-shadow-menu);
          min-width: 260px;
          max-width: 320px;
          overflow: hidden;
          display: none;
          flex-direction: column;
          animation: gc__menuIn .12s var(--gc-ease);
        }

        @keyframes gc__menuIn {
          from { opacity: 0; transform: translateY(6px) scale(.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        .gc__mentionMenu.gc__open { display: flex; }

        .gc__mentionHeader {
          padding: 8px 12px 5px;
          font-size: 9px;
          font-weight: 700;
          color: var(--gc-text-faint);
          text-transform: uppercase;
          letter-spacing: .1em;
        }

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
          font-family: var(--gc-font);
          color: var(--gc-text);
          font-size: 13px;
          transition: background .08s;
        }

        .gc__mentionItem:last-child { border-radius: 0 0 var(--gc-r-lg) var(--gc-r-lg); }

        .gc__mentionItem:hover,
        .gc__mentionItem.gc__active {
          background: var(--gc-accent-dim);
        }

        .gc__mentionItemIcon {
          width: 30px; height: 30px;
          border-radius: 8px;
          background: var(--gc-bg);
          border: 1px solid var(--gc-border);
          color: var(--gc-accent);
          display: grid; place-items: center;
          font-size: 13px;
          flex: 0 0 auto;
        }

        .gc__mentionItem.gc__active .gc__mentionItemIcon {
          background: var(--gc-accent-dim);
          border-color: rgba(99,179,237,.25);
        }

        .gc__mentionInfo { display: flex; flex-direction: column; gap: 1px; min-width: 0; }

        .gc__mentionLabel {
          font-size: 13px;
          font-weight: 500;
          color: var(--gc-text);
        }

        .gc__mentionTag {
          font-size: 10px;
          font-family: var(--gc-mono);
          color: var(--gc-accent);
        }

        .gc__mentionDesc {
          font-size: 11px;
          color: var(--gc-text-muted);
        }

        /* ────────────────────────────────────────
           SETTINGS OVERLAY
        ──────────────────────────────────────── */
        .gc__settings {
          position: absolute;
          inset: 0;
          background: var(--gc-bg);
          z-index: 10;
          display: none;
          flex-direction: column;
          overflow: hidden;
          animation: gc__slideUp .18s var(--gc-ease);
        }

        @keyframes gc__slideUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .gc__settings.gc__open { display: flex; }

        /* Settings header */
        .gc__settingsHeader {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 13px 14px;
          background: var(--gc-bg-raised);
          border-bottom: 1px solid var(--gc-border);
        }

        .gc__settingsBack {
          width: 28px; height: 28px;
          border: none;
          background: var(--gc-bg-elevated);
          color: var(--gc-text-muted);
          border-radius: var(--gc-r-sm);
          cursor: pointer;
          display: grid; place-items: center;
          font-size: 14px;
          transition: background .12s, color .12s;
          flex-shrink: 0;
        }

        .gc__settingsBack:hover {
          background: var(--gc-border);
          color: var(--gc-text);
        }

        .gc__settingsTitle {
          font-size: 13px;
          font-weight: 600;
          flex: 1;
          letter-spacing: -.01em;
        }

        /* Settings body - solo panel con scroll */
        .gc__settingsBody {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          scrollbar-width: thin;
          scrollbar-color: var(--gc-border) transparent;
          min-height: 0;
        }

        /* Field inside settings - flat list */
        .gc__settingsField {
          padding: 10px 12px;
          background: var(--gc-bg-raised);
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-md);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .gc__settingsField + .gc__settingsField {
          border-top: 1px solid var(--gc-border);
        }

        .gc__settingsField--row {
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
        }

        .gc__fieldLabel {
          font-size: 12px;
          font-weight: 500;
          color: var(--gc-text);
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .gc__fieldSub {
          font-size: 11px;
          color: var(--gc-text-muted);
          margin-top: 1px;
        }

        /* Form inputs */
        .gc__select,
        .gc__textInput,
        .gc__textareaCfg {
          width: 100%;
          border: 1px solid var(--gc-border);
          border-radius: var(--gc-r-sm);
          padding: 7px 10px;
          font-size: 12.5px;
          font-family: var(--gc-font);
          background: var(--gc-bg-input);
          color: var(--gc-text);
          outline: none;
          transition: border-color .15s, box-shadow .15s;
          box-sizing: border-box;
        }

        .gc__select {
          appearance: none;
          -webkit-appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238b8fa8' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 10px center;
          padding-right: 28px;
          cursor: pointer;
        }

        .gc__select:focus,
        .gc__textInput:focus,
        .gc__textareaCfg:focus {
          border-color: var(--gc-border-focus);
          box-shadow: 0 0 0 3px var(--gc-accent-dim);
        }

        .gc__textareaCfg {
          resize: vertical;
          min-height: 72px;
          font-size: 12px;
          line-height: 1.5;
        }

        /* Password field with toggle */
        .gc__keyWrap {
          display: flex;
          gap: 6px;
          align-items: center;
        }

        .gc__keyWrap .gc__textInput { flex: 1; font-family: var(--gc-mono); font-size: 12px; }

        .gc__toggleKeyBtn {
          width: 32px; height: 32px;
          border: 1px solid var(--gc-border);
          background: var(--gc-bg-elevated);
          color: var(--gc-text-muted);
          border-radius: var(--gc-r-sm);
          cursor: pointer;
          display: grid; place-items: center;
          font-size: 13px;
          flex-shrink: 0;
          transition: background .12s, color .12s;
        }

        .gc__toggleKeyBtn:hover {
          background: var(--gc-border);
          color: var(--gc-text);
        }

        /* Temperature slider */
        .gc__sliderWrap {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .gc__slider {
          flex: 1;
          -webkit-appearance: none;
          appearance: none;
          height: 4px;
          background: var(--gc-bg-elevated);
          border-radius: 4px;
          outline: none;
          border: none;
          cursor: pointer;
        }

        .gc__slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px; height: 14px;
          border-radius: 50%;
          background: var(--gc-accent);
          border: 2px solid var(--gc-bg);
          box-shadow: 0 0 0 1px var(--gc-accent);
          cursor: pointer;
          transition: transform .1s;
        }

        .gc__slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
        .gc__slider::-moz-range-thumb {
          width: 14px; height: 14px;
          border-radius: 50%;
          background: var(--gc-accent);
          border: 2px solid var(--gc-bg);
          cursor: pointer;
        }

        .gc__tempValue {
          font-family: var(--gc-mono);
          font-size: 12px;
          font-weight: 500;
          color: var(--gc-accent);
          min-width: 24px;
          text-align: right;
        }

        /* Settings footer actions */
        .gc__settingsFooter {
          flex: 0 0 auto;
          padding: 10px 14px;
          background: var(--gc-bg-raised);
          border-top: 1px solid var(--gc-border);
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        /* Buttons */
        .gc__btn {
          height: 32px;
          padding: 0 14px;
          border-radius: var(--gc-r-sm);
          font-family: var(--gc-font);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid var(--gc-border);
          background: var(--gc-bg-elevated);
          color: var(--gc-text-muted);
          transition: all .12s;
          letter-spacing: .01em;
        }

        .gc__btn:hover {
          background: var(--gc-border);
          color: var(--gc-text);
        }

        .gc__btn--primary {
          background: var(--gc-accent);
          color: #0f1923;
          border-color: var(--gc-accent);
        }

        .gc__btn--primary:hover {
          background: #90cdf4;
          border-color: #90cdf4;
          box-shadow: 0 4px 12px rgba(99,179,237,.3);
        }

        .gc__btn:focus-visible {
          outline: 2px solid var(--gc-accent);
          outline-offset: 2px;
        }

        /* Hint text inside settings */
        .gc__fieldHint {
          font-size: 10.5px;
          color: var(--gc-text-muted);
          line-height: 1.4;
          margin-top: 2px;
        }
      </style>

      <div class="gc__shell">

        <!-- ── Header ── -->
        <header class="gc__header" id="gc__header" role="banner">
          <div class="gc__headerIcon" aria-hidden="true">✦</div>
          <div class="gc__title">AI Assistant</div>
          <button id="gc__settingsBtn" class="gc__hBtn" title="Settings (⚙)" aria-label="Open settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
          <button id="gc__themeToggle" class="gc__themeToggle" title="Toggle light/dark theme" aria-label="Toggle theme">
            ☀
          </button>
          <button id="gc__clearBtn" class="gc__hBtn" title="Clear conversation" aria-label="Clear conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
          <button id="gc__closeBtn" class="gc__hBtn gc__hBtn--close" title="Close (Esc)" aria-label="Close panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </header>

        <!-- ── Message list ── -->
        <main id="gc__messages" class="gc__messages" role="log" aria-live="polite" aria-label="Conversation">
          <div class="gc__msg--system">
            Ask about your code · Use <b>@</b> to insert context: selection, file or project
          </div>
        </main>

        <!-- ── Composer ── -->
        <footer class="gc__composer" role="contentinfo" style="position:relative;">

          <!-- Mention autocomplete menu -->
          <div id="gc__mentionMenu" class="gc__mentionMenu" role="listbox" aria-label="Context options"></div>

          <!-- Provider / Model selector row -->
          <div class="gc__providerRow" role="group" aria-label="Provider and model selection">
            <div class="gc__providerSeg">
              <span class="gc__segLabel">Provider</span>
              <span id="gc__providerDot" class="gc__providerDot" aria-hidden="true"></span>
              <select id="gc__providerSelect" class="gc__miniSelect" aria-label="Select provider"></select>
            </div>
            <div class="gc__providerSeg">
              <span class="gc__segLabel">Model</span>
              <select id="gc__modelSelect" class="gc__miniSelect" aria-label="Select model"></select>
            </div>
          </div>

          <!-- Textarea + send -->
          <div class="gc__inputRow">
            <div class="gc__textareaWrap">
              <textarea
                id="gc__chatInput"
                class="gc__textarea"
                rows="1"
                placeholder="Ask something… type @ for context"
                aria-label="Message input"
                autocomplete="off"
                spellcheck="true"
              ></textarea>
            </div>
            <button id="gc__sendBtn" class="gc__sendBtn" aria-label="Send message">
              <span class="gc__sendIcon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </span>
              <span class="gc__stopIcon">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1"/>
                </svg>
              </span>
            </button>
          </div>

          <!-- Keyboard hints -->
          <div class="gc__hint" aria-hidden="true">
            <kbd class="gc__hintKey">Enter</kbd> send ·
            <kbd class="gc__hintKey">⇧ Enter</kbd> new line ·
            <kbd class="gc__hintKey">@</kbd> context ·
            <kbd class="gc__hintKey">Esc</kbd> close
          </div>

        </footer>

        <div id="gc__resizeHandle" class="gc__resizeHandle" title="Resize"></div>

        <!-- ── Settings overlay ── -->
        <div id="gc__settings" class="gc__settings" role="dialog" aria-modal="true" aria-label="AI Settings">

          <div class="gc__settingsHeader">
            <button id="gc__settingsBack" class="gc__settingsBack" title="Back" aria-label="Close settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <span class="gc__settingsTitle">Settings</span>
          </div>

          <div class="gc__settingsBody">

            <!-- Provider -->
            <div class="gc__settingsField">
              <label class="gc__fieldLabel" for="gc__settingsProviderSelect">Provider</label>
              <select id="gc__settingsProviderSelect" class="gc__select" aria-label="Select provider"></select>
            </div>

            <!-- Model -->
            <div class="gc__settingsField">
              <label class="gc__fieldLabel" for="gc__settingsModelSelect">Model</label>
              <select id="gc__settingsModelSelect" class="gc__select" aria-label="Select model"></select>
            </div>

            <!-- Endpoint URL (Sólo visible para Custom) -->
            <div class="gc__settingsField" id="gc__endpointField" style="display: none;">
              <label class="gc__fieldLabel" for="gc__endpointUrl">Endpoint URL</label>
              <input
                id="gc__endpointUrl"
                class="gc__textInput"
                type="text"
                autocomplete="off"
                placeholder="http://localhost:11434/v1/chat/completions"
              >
              <p class="gc__fieldHint">Full endpoint URL (e.g., LM Studio, Ollama).</p>
            </div>

            <!-- API Key -->
            <div class="gc__settingsField">
              <label class="gc__fieldLabel" id="gc__apiKeyLabel" for="gc__apiKeyInput">API Key</label>
              <div class="gc__keyWrap">
                <input
                  id="gc__apiKeyInput"
                  class="gc__textInput"
                  type="password"
                  autocomplete="off"
                  aria-labelledby="gc__apiKeyLabel"
                  placeholder="sk-..."
                >
                <button id="gc__toggleKeyBtn" class="gc__toggleKeyBtn" title="Show / hide key" aria-label="Toggle key visibility">👁</button>
              </div>
              <p class="gc__fieldHint">Stored locally. Never sent to any server other than the selected provider.</p>
            </div>

            <!-- Temperature -->
            <div class="gc__settingsField">
              <label class="gc__fieldLabel" for="gc__tempInput">
                Temperature
                <span id="gc__tempVal" style="margin-left:auto;font-family:var(--gc-mono);font-size:11px;color:var(--gc-accent);">0.3</span>
              </label>
              <div class="gc__sliderWrap">
                <span style="font-size:10px;color:var(--gc-text-faint);">Precise</span>
                <input id="gc__tempInput" class="gc__slider" type="range" min="0" max="1" step="0.1" value="0.3" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.3">
                <span style="font-size:10px;color:var(--gc-text-faint);">Creative</span>
              </div>
            </div>

            <!-- System Prompt -->
            <div class="gc__settingsField">
              <label class="gc__fieldLabel" for="gc__systemPrompt">System prompt</label>
              <textarea id="gc__systemPrompt" class="gc__textareaCfg" rows="4" aria-label="System prompt"></textarea>
            </div>

            <!-- Custom Models -->
            <div class="gc__settingsField">
              <label class="gc__fieldLabel" for="gc__customModels">Additional models</label>
              <textarea
                id="gc__customModels"
                class="gc__textareaCfg"
                rows="4"
                placeholder="gpt-4o&#10;claude-sonnet-4-6&#10;gemini-2.5-pro"
                aria-label="Custom models, one per line"
              ></textarea>
              <p class="gc__fieldHint">One model per line. Appended to the provider's model list.</p>
            </div>

          </div><!-- /.gc__settingsBody -->

          <div class="gc__settingsFooter">
            <button id="gc__cancelSettings" class="gc__btn">Cancel</button>
            <button id="gc__saveSettings" class="gc__btn gc__btn--primary">Save changes</button>
          </div>

        </div><!-- /.gc__settings -->

      </div><!-- /.gc__shell -->
    `
    );

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

    const input             = sr.getElementById('gc__chatInput');
    const sendBtn           = sr.getElementById('gc__sendBtn');
    const closeBtn          = sr.getElementById('gc__closeBtn');
    const clearBtn          = sr.getElementById('gc__clearBtn');
    const settingsBtn       = sr.getElementById('gc__settingsBtn');
    const settingsBack      = sr.getElementById('gc__settingsBack');
    const cancelBtn         = sr.getElementById('gc__cancelSettings');
    const saveBtn           = sr.getElementById('gc__saveSettings');
    const providerSel       = sr.getElementById('gc__providerSelect');
    const settingsProvSel   = sr.getElementById('gc__settingsProviderSelect');
    const settingsModelSel  = sr.getElementById('gc__settingsModelSelect');
    const toggleKeyBtn      = sr.getElementById('gc__toggleKeyBtn');
    const tempInput         = sr.getElementById('gc__tempInput');
    const messages          = sr.getElementById('gc__messages');
    const customModelsInput = sr.getElementById('gc__customModels');

    sendBtn?.addEventListener('click', () => this._handleSendClick());
    input?.addEventListener('keydown', (e) => this._onInputKeyDown(e));
    input?.addEventListener('input', () => this._onInputChange());
    sr.addEventListener('click', (e) => this._onShadowRootClick(e));
    providerSel?.addEventListener('change', () => this._onProviderChange());

    if (settingsProvSel) {
      DomUtils.setHTML(
        settingsProvSel,
        Object.entries(GAS_LLM_PROVIDERS)
          .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
          .join('')
      );
    }

    settingsProvSel?.addEventListener('change', () => this._onSettingsProviderChange());
    settingsModelSel?.addEventListener('change', () => {
      this._config.model = settingsModelSel.value;
    });

    closeBtn?.addEventListener('click', () => this.close());
    clearBtn?.addEventListener('click', () => { this._messages = []; this._renderMessages_(); });
    settingsBtn?.addEventListener('click', () => this._openSettings_());
    sr.getElementById('gc__themeToggle')?.addEventListener('click', () => this._toggleTheme_());
    sr.getElementById('gc__resizeHandle')?.addEventListener('mousedown', (evt) => this._onResizeHandleMouseDown(evt));
    settingsBack?.addEventListener('click', () => this._closeSettings_());
    cancelBtn?.addEventListener('click', () => this._closeSettings_());
    saveBtn?.addEventListener('click', () => this._onSettingsSave());
    toggleKeyBtn?.addEventListener('click', () => this._onToggleKeyClick());
    tempInput?.addEventListener('input', () => this._onTempInput());
    messages?.addEventListener('click', (e) => this._onMessagesClick(e));
    customModelsInput?.addEventListener('input', () => this._onCustomModelsInput());

    window.addEventListener('keydown', this._onWindowKeyDown);
  }

  /** Maneja las teclas en el input de chat. */
  _onInputKeyDown(e) {
    if (this._isStreaming && e.key === 'Escape') {
      e.preventDefault();
      this._cancelRequest();
      return;
    }
    // Navegación del menú @: usamos el elemento real del shadow DOM,
    // no `this._mentionMenu` (que nunca se asignó).
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (menu?.classList.contains('gc__open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._navigateMention_(1);  return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this._navigateMention_(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this._selectMention_(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); this._hideMentionMenu_(); return; }
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
    if (!this._isStreaming || !this._currentRequestId) return;
    this._isStreaming = false;
    this._currentRequestId = null;
    this._updateSendButton_();
    this._appendSystemNotice_('Request cancelled');
    const thinking = this.shadowRoot.querySelector('.gc__thinking');
    if (thinking) thinking.remove();
  }

  /** Auto-resize del textarea y detección del menú @. */
  _onInputChange() {
    const input = this.shadowRoot.getElementById('gc__chatInput');
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    this._updateSendButton_();
    this._detectMention_(input);
  }

  /** Cierra el menú @ al hacer clic fuera. */
  _onShadowRootClick(e) {
    const input = this.shadowRoot.getElementById('gc__chatInput');
    if (!e.target.closest('.gc__mentionMenu') && e.target !== input) {
      this._hideMentionMenu_();
    }
  }

  /** Actualiza la lista de modelos en tiempo real cuando se editan los custom models. */
  _onCustomModelsInput() {
    const settingsProvSel   = this.shadowRoot.getElementById('gc__settingsProviderSelect');
    const settingsModelSel  = this.shadowRoot.getElementById('gc__settingsModelSelect');
    const customModelsInput = this.shadowRoot.getElementById('gc__customModels');
    if (!settingsProvSel || !settingsModelSel || !customModelsInput) return;

    const id = settingsProvSel.value;
    const provider = GAS_LLM_PROVIDERS[id];
    const customModels = customModelsInput.value.split('\n').map(l => l.trim()).filter(Boolean);
    const allModels = [...(provider?.models || []), ...customModels];

    const currentModel = settingsModelSel.value;
    DomUtils.setHTML(settingsModelSel, allModels.map(m => `<option value="${m}">${m}</option>`).join(''));
    
    if (allModels.includes(currentModel)) {
      settingsModelSel.value = currentModel;
    } else if (allModels.length > 0) {
      settingsModelSel.value = allModels[0];
    }
  }

  /** Maneja el cambio de proveedor en el composer. */
  _onProviderChange() {
    const providerSel = this.shadowRoot.getElementById('gc__providerSelect');
    const modelSel    = this.shadowRoot.getElementById('gc__modelSelect');
    const apiKeyInput = this.shadowRoot.getElementById('gc__apiKeyInput');
    if (!providerSel || !modelSel || !apiKeyInput) return;

    const id        = providerSel.value;
    const provider  = GAS_LLM_PROVIDERS[id];
    const provSettings = this._getProviderSettings_(id);
    const allModels = [...(provider?.models || []), ...(provSettings.customModels || [])];
    DomUtils.setHTML(modelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
    if (this._config.provider === id && this._config.model && allModels.includes(this._config.model)) {
      modelSel.value = this._config.model;
    } else if (allModels.length > 0) {
      modelSel.value = allModels[0];
    }

    this._config.provider   = id;
    apiKeyInput.value        = this._config.apiKeys?.[id] || '';
    apiKeyInput.placeholder  = provider?.keyHint || 'API key';
  }

  /**
   * Actualiza los campos del formulario de ajustes cuando cambia el
   * proveedor: modelos disponibles, API key, temperatura, system prompt,
   * y muestra/oculta el campo Endpoint para el proveedor `custom`.
   * @private
   */
  _onSettingsProviderChange() {
    const settingsProvSel   = this.shadowRoot.getElementById('gc__settingsProviderSelect');
    const settingsModelSel  = this.shadowRoot.getElementById('gc__settingsModelSelect');
    const apiKeyInput       = this.shadowRoot.getElementById('gc__apiKeyInput');
    const tempInput         = this.shadowRoot.getElementById('gc__tempInput');
    const tempVal           = this.shadowRoot.getElementById('gc__tempVal');
    const systemPrompt      = this.shadowRoot.getElementById('gc__systemPrompt');
    const customModelsInput = this.shadowRoot.getElementById('gc__customModels');
    const endpointField     = this.shadowRoot.getElementById('gc__endpointField');
    const endpointUrlInput  = this.shadowRoot.getElementById('gc__endpointUrl');
    if (!settingsProvSel) return;

    const id = settingsProvSel.value;
    // Usar _getProviderSettings_ que ya maneja defaults correctamente
    const providerSettings = this._getProviderSettings_(id);
    const provider = GAS_LLM_PROVIDERS[id];
    const allModels = [...(provider?.models || []), ...(providerSettings.customModels || [])];

    DomUtils.setHTML(settingsModelSel, allModels.map(m => `<option value="${m}">${m}</option>`).join(''));
    // Seleccionar modelo guardado solo si el proveedor coincide con el activo y el modelo existe
    if (this._config.provider === id && this._config.model && allModels.includes(this._config.model)) {
      settingsModelSel.value = this._config.model;
    } else if (allModels.length > 0) {
      settingsModelSel.value = allModels[0];
    }

    apiKeyInput.value       = this._config.apiKeys?.[id] || '';
    apiKeyInput.placeholder = provider?.keyHint || 'API key';

    const keyLabel = this.shadowRoot.getElementById('gc__apiKeyLabel');
    if (keyLabel) keyLabel.textContent = `API Key — ${provider?.label || id}`;

    tempInput.value     = String(providerSettings.temperature ?? 0.3);
    tempVal.textContent = String(providerSettings.temperature ?? 0.3);
    tempInput.setAttribute('aria-valuenow', tempInput.value);
    systemPrompt.value      = providerSettings.systemPrompt || '';
    customModelsInput.value = (providerSettings.customModels || []).join('\n');
    
    if (endpointUrlInput) {
      endpointUrlInput.value = providerSettings.endpointUrl || '';
    }
    if (endpointField) {
      endpointField.style.display = id === 'custom' ? 'block' : 'none';
    }
  }

  /** Maneja el click en el resize handle. */
  _onResizeHandleMouseDown(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    this._startResize(evt);
  }

  /** Maneja el guardado de settings. */
  _onSettingsSave() {
    const settingsProvSel   = this.shadowRoot.getElementById('gc__settingsProviderSelect');
    const settingsModelSel  = this.shadowRoot.getElementById('gc__settingsModelSelect');
    const apiKeyInput       = this.shadowRoot.getElementById('gc__apiKeyInput');
    const tempInput         = this.shadowRoot.getElementById('gc__tempInput');
    const systemPrompt      = this.shadowRoot.getElementById('gc__systemPrompt');
    const customModelsInput = this.shadowRoot.getElementById('gc__customModels');
    const endpointUrlInput  = this.shadowRoot.getElementById('gc__endpointUrl');

    try {
      const activeProvider = settingsProvSel?.value || this._config.provider || 'gemini';
      const activeModel    = settingsModelSel?.value || this._config.model || '';
      const apiKey         = (apiKeyInput?.value || '').trim();
      const tempVal        = parseFloat(tempInput?.value ?? 0.3);
      const sysPromptVal   = systemPrompt?.value || '';
      const customModelsVal = customModelsInput?.value
        ? customModelsInput.value.split('\n').map(l => l.trim()).filter(Boolean)
        : [];
      const endpointUrlVal   = (endpointUrlInput?.value || '').trim();

      // Actualizar config completa de forma consistente
      this._config = {
        ...this._config,
        provider: activeProvider,
        model: activeModel,
        // Propiedades raíz sincronizadas con el proveedor activo
        temperature: tempVal,
        systemPrompt: sysPromptVal,
        customModels: customModelsVal,
        apiKeys: {
          ...this._config.apiKeys,
          [activeProvider]: apiKey,
        },
        providerSettings: {
          ...this._config.providerSettings,
          [activeProvider]: {
            temperature: tempVal,
            systemPrompt: sysPromptVal,
            customModels: customModelsVal,
            endpointUrl: endpointUrlVal,
          },
        },
      };

      // Procede a guardar los datos de configuración en el bridge
      this._saveConfig();
      this._closeSettings_();
      this._refreshComposerProviderUI_();
      this._appendSystemNotice_('Settings saved ✓');
    } catch (err) {
      console.error('Error guardando settings:', err);
      this._appendSystemNotice_('Error saving: ' + err.message);
    }
  }

  /** Alterna visibilidad de la API key. */
  _onToggleKeyClick() {
    const apiKeyInput = this.shadowRoot.getElementById('gc__apiKeyInput');
    const toggleKeyBtn= this.shadowRoot.getElementById('gc__toggleKeyBtn');
    if (!apiKeyInput || !toggleKeyBtn) return;
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    toggleKeyBtn.textContent = apiKeyInput.type === 'password' ? '👁' : '🙈';
  }

  /** Actualiza el valor de temperatura en tiempo real. */
  _onTempInput() {
    const tempInput = this.shadowRoot.getElementById('gc__tempInput');
    const tempVal   = this.shadowRoot.getElementById('gc__tempVal');
    if (tempVal) tempVal.textContent = tempInput.value;
    tempInput.setAttribute('aria-valuenow', tempInput.value);
  }

  /** Maneja clics en los botones de bloques de código. */
  _onMessagesClick(e) {
    const btn = e.target.closest('.gc__codeBtn');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const code   = btn.closest('.gc__codeWrap')?.querySelector('.gc__codeBlock')?.textContent || '';
    if (!code) return;
    if (action === 'copy')    this._copyToClipboard_(code, btn);
    if (action === 'insert')  this._insertAtCursor_(code);
    if (action === 'replace') this._replaceSelection_(code);
  }

  /**
   * Maneja Escape: cierra settings si está abierto, o cierra el panel.
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

  /**
   * Re-renderiza la lista completa de mensajes y hace scroll al final.
   * Solo procesa mensajes user/assistant; los system notices se manejan
   * con `_appendSystemNotice_` y no persisten en `_messages`.
   * @private
   */
  _renderMessages_() {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;

    const intro = `<div class="gc__msg--system">
      Ask about your code · Use <b>@</b> to insert context: selection, file or project
    </div>`;

    const html = this._messages.map((m) => {
      if (m.role === 'user') {
        return `<div class="gc__msg--user">${this._escapeHtml_(m.content)}</div>`;
      }
      const bodyCls = m._isError
        ? 'gc__assistantBody gc__assistantBody--error'
        : 'gc__assistantBody';
      return `
        <div class="gc__msg--assistant">
          <div class="gc__assistantAvatar" aria-hidden="true">✦</div>
          <div class="${bodyCls}">${this._renderMarkdown_(m.content || '')}</div>
        </div>`;
    }).join('');

    DomUtils.setHTML(container, intro + html);
    if (this._isStreaming) this._appendThinking_();
    container.scrollTop = container.scrollHeight;
  }

  /** Añade el indicador animado de "pensando" (sin duplicar). */
  _appendThinking_() {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container || container.querySelector('.gc__thinking')) return;

    const div = document.createElement('div');
    div.className = 'gc__thinking';
    div.setAttribute('aria-label', 'AI is thinking');
    DomUtils.setHTML(div, `
       <div class="gc__thinkingAvatar" aria-hidden="true">✦</div>
       <div class="gc__thinkingDots">
         <span></span><span></span><span></span>
       </div>`);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /**
   * Muestra un aviso temporal del sistema (errores, "request cancelled",
   * etc.) sin agregarlo al historial de la conversación. Aparece como una
   * burbuja gris centrada y solo en el DOM.
   * @param {string} text
   * @private
   */
  _appendSystemNotice_(text) {
    const container = this.shadowRoot.getElementById('gc__messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className   = 'gc__msg--system';
    div.textContent = text;
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
      btn.title = 'Cancel request';
      btn.setAttribute('aria-label', 'Cancel request');
    } else {
      btn.classList.remove('gc__sendBtn--loading');
      btn.classList.remove('gc__sendBtn--cancel');
      btn.disabled = !hasText;
      btn.title = 'Send message';
      btn.setAttribute('aria-label', 'Send message');
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // AUTOCOMPLETADO @
  // ──────────────────────────────────────────────────────────────────

  /**
   * Detecta si el cursor está después de "@" y, si es así, abre o actualiza
   * el menú de menciones. Conserva el `_mentionIndex` actual mientras siga
   * dentro de los items filtrados, así la navegación con flechas no se
   * resetea al seguir tipeando.
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

    const filtered = this._mentionItems.filter(
      (it) =>
        it.tag.toLowerCase().includes(this._mentionQuery) ||
        it.label.toLowerCase().includes(this._mentionQuery)
    );

    if (!filtered.length) { this._hideMentionMenu_(); return; }

    // Mantener el índice dentro de rango tras un filtrado.
    if (this._mentionIndex < 0 || this._mentionIndex >= filtered.length) {
      this._mentionIndex = 0;
    }

    const html = `
      <div class="gc__mentionHeader">Context</div>
      ${filtered
        .map(
          (it, idx) => `
        <button
          class="gc__mentionItem ${idx === this._mentionIndex ? 'gc__active' : ''}"
          data-index="${idx}"
          data-tag="${it.tag}"
          role="option"
          aria-selected="${idx === this._mentionIndex}"
        >
          <div class="gc__mentionItemIcon">${it.icon}</div>
          <div class="gc__mentionInfo">
            <div class="gc__mentionLabel">${it.label}</div>
            <div class="gc__mentionTag">${it.tag}</div>
          </div>
        </button>`
        )
        .join('')}`;

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

  /** Oculta el menú de menciones y resetea su estado. */
  _hideMentionMenu_() {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (menu) { menu.classList.remove('gc__open'); menu.onclick = null; }
    this._mentionStart = -1;
    this._mentionQuery = '';
    this._mentionIndex = -1;
  }

  /**
   * Mueve el foco entre items del menú de menciones.
   * @param {number} dir - +1 abajo, -1 arriba
   */
  _navigateMention_(dir) {
    const menu = this.shadowRoot.getElementById('gc__mentionMenu');
    if (!menu) return;
    const items = menu.querySelectorAll('.gc__mentionItem');
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
    const tag = menu.querySelector('.gc__mentionItem.gc__active')?.dataset.tag;
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
    const start  = typeof replaceFrom === 'number' ? replaceFrom : (input.selectionStart ?? input.value.length);
    const end    = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after  = input.value.slice(end);
    const sep    = before && !before.endsWith(' ') ? ' ' : '';
    input.value  = before + sep + tag + ' ' + after;
    input.focus();
    input.dispatchEvent(new Event('input'));
  }

  // ──────────────────────────────────────────────────────────────────
  // MARKDOWN RENDERER
  // ──────────────────────────────────────────────────────────────────

  /**
   * Convierte Markdown a HTML seguro. Implementación inspirada en GitHub
   * Flavored Markdown, suficiente para conversaciones técnicas:
   *  - Bloques de código cercados con barra de acciones (Copy/Insert/Replace).
   *  - Inline code, negrita, cursiva, tachado.
   *  - Encabezados (#, ##, ###).
   *  - Listas no ordenadas (-, *) y ordenadas (1., 2., ...).
   *  - Citas (> ...).
   *  - Reglas horizontales (---).
   *  - Tablas con header (| a | b |).
   *  - Enlaces [texto](url) y URLs detectadas automáticamente.
   *
   * Todo el contenido se escapa antes de aplicar reglas para prevenir XSS;
   * los bloques de código se extraen primero con placeholders.
   *
   * @param {string} src Texto en Markdown.
   * @returns {string} HTML listo para inyectar.
   * @private
   */
  _renderMarkdown_(src) {
    const text = String(src || '');

    // 1. Aislar bloques de código (```lang ... ```) con placeholders.
    const codeBlocks = [];
    let work = text.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push({ lang: (lang || '').trim(), code });
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });

    // 2. Aislar inline code (`...`) para que su contenido no se procese.
    const inlines = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlines.push(code);
      return `\u0000INL${inlines.length - 1}\u0000`;
    });

    // 3. Escapar HTML de todo lo demás.
    work = this._escapeHtml_(work);

    // 4. Reglas horizontales (---, ***, ___).
    work = work.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '<hr>');

    // 5. Encabezados.
    work = work
      .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
      .replace(/^##### (.*)$/gm,  '<h5>$1</h5>')
      .replace(/^#### (.*)$/gm,   '<h4>$1</h4>')
      .replace(/^### (.*)$/gm,    '<h3>$1</h3>')
      .replace(/^## (.*)$/gm,     '<h2>$1</h2>')
      .replace(/^# (.*)$/gm,      '<h1>$1</h1>');

    // 6. Tablas GFM. Detectamos: línea header + línea separadora |---|---|.
    work = work.replace(
      /(^\|[^\n]+\|\r?\n\|[\s|:-]+\|(?:\r?\n\|[^\n]+\|)+)/gm,
      (block) => this._renderTable_(block)
    );

    // 7. Citas: agrupar líneas consecutivas que empiezan con ">".
    work = work.replace(/(?:^&gt; ?.*(?:\r?\n|$))+/gm, (block) => {
      const inner = block.replace(/^&gt; ?/gm, '').replace(/\s+$/, '');
      return `<blockquote>${inner}</blockquote>\n`;
    });

    // 8. Listas ordenadas: bloques de líneas "1. texto".
    work = work.replace(/(?:^\d+\. .+(?:\r?\n|$))+/gm, (block) => {
      const items = block.trim().split(/\r?\n/).map((l) => l.replace(/^\d+\.\s+/, ''));
      return '<ol>' + items.map((i) => `<li>${i}</li>`).join('') + '</ol>\n';
    });

    // 9. Listas no ordenadas: bloques de líneas "- texto" o "* texto".
    work = work.replace(/(?:^[-*] .+(?:\r?\n|$))+/gm, (block) => {
      const items = block.trim().split(/\r?\n/).map((l) => l.replace(/^[-*]\s+/, ''));
      return '<ul>' + items.map((i) => `<li>${i}</li>`).join('') + '</ul>\n';
    });

    // 10. Negrita, cursiva, tachado.
    work = work
      .replace(/\*\*([^*\n]+)\*\*/g,        '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g,            '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g,    '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_/g,      '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g,            '<del>$1</del>');

    // 11. Enlaces explícitos y URLs sueltas.
    work = work.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    work = work.replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener">$2</a>'
    );

    // 12. Párrafos: separar por dobles saltos, omitir bloques estructurales.
    work = work.split(/\n{2,}/).map((para) => {
      const t = para.trim();
      if (!t) return '';
      if (/^<(h[1-6]|ul|ol|pre|blockquote|table|hr|div)/.test(t)) return t;
      return `<p>${t.replace(/\r?\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('\n');

    // 13. Reinyectar inline code.
    work = work.replace(/\u0000INL(\d+)\u0000/g, (_, idx) => {
      return `<code class="gc__inlineCode">${this._escapeHtml_(inlines[Number(idx)])}</code>`;
    });

    // 14. Reinyectar bloques de código con barra de acciones y highlight.
    work = work.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => {
      const { lang, code } = codeBlocks[Number(idx)];
      const trimmed   = code.replace(/\n+$/, '');
      const langLabel = lang || 'code';
      const highlighted = this._highlightCode_(trimmed, lang);
      return `
        <div class="gc__codeWrap">
          <div class="gc__codeBar">
            <span class="gc__codeLang">${this._escapeHtml_(langLabel)}</span>
            <div class="gc__codeBarBtns">
              <button class="gc__codeBtn" data-action="copy"    title="Copy to clipboard">Copy</button>
              <button class="gc__codeBtn" data-action="insert"  title="Insert at editor cursor">Insert</button>
              <button class="gc__codeBtn" data-action="replace" title="Replace editor selection">Replace</button>
            </div>
          </div>
          <pre class="gc__codeBlock"><code>${highlighted}</code></pre>
        </div>`;
    });

    return work;
  }

  /**
   * Resalta sintaxis de un fragmento de código sin librerías externas.
   * Soporta JavaScript/TypeScript, CSS, HTML y JSON. Para otros lenguajes
   * devuelve el texto escapado sin coloreado.
   *
   * El highlighter trabaja sobre texto CRUDO (sin escapar). Cada token se
   * escapa individualmente al envolverlo en su `<span>`. Esto evita que
   * las entidades HTML inyectadas por el escape choquen con los regex
   * (p. ej. `'` impidiendo matchear comillas simples).
   *
   * @param {string} src
   * @param {string} lang
   * @returns {string} HTML con spans de coloreado.
   * @private
   */
  _highlightCode_(src, lang) {
    const id = String(lang || '').toLowerCase().trim();

    if (['js', 'javascript', 'ts', 'typescript', 'gas', 'google-apps-script'].includes(id)) {
      return this._highlightJs_(src);
    }
    if (['css', 'scss', 'less'].includes(id)) {
      return this._highlightCss_(src);
    }
    if (['html', 'xml', 'svg'].includes(id)) {
      return this._highlightHtml_(src);
    }
    if (['json', 'jsonc'].includes(id)) {
      return this._highlightJson_(src);
    }
    return this._escapeHtml_(src);
  }

  /**
   * Resalta JavaScript/TypeScript en un solo pase. Recibe texto crudo y
   * escapa cada fragmento al construir el HTML resultante.
   * @param {string} s Texto sin escapar.
   * @returns {string}
   * @private
   */
  _highlightJs_(s) {
    const KEYWORDS = new Set([
      'const','let','var','function','return','if','else','for','while','do',
      'switch','case','break','continue','default','try','catch','finally',
      'throw','new','delete','typeof','instanceof','in','of','class','extends',
      'super','this','async','await','yield','import','export','from','as',
      'static','get','set','true','false','null','undefined','void',
    ]);
    const BUILTINS = new Set([
      'console','Math','JSON','Object','Array','String','Number','Boolean',
      'Date','RegExp','Map','Set','Promise','Error','Symbol','Logger',
      'SpreadsheetApp','DocumentApp','DriveApp','GmailApp','CalendarApp',
      'PropertiesService','UrlFetchApp','Utilities','HtmlService',
      'ScriptApp','Session','document','window',
    ]);

    const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)|(\.\s*[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)/g;

    return this._tokenize_(s, re, (m, groups) => {
      const [comment, str, num, prop, ident] = groups;
      if (comment) return this._wrap_('hl-comment', comment);
      if (str)     return this._wrap_('hl-string',  str);
      if (num)     return this._wrap_('hl-number',  num);
      if (prop) {
        const dot  = prop[0];
        const name = prop.slice(1).trim();
        return dot + this._wrap_('hl-prop', name);
      }
      if (ident) {
        if (KEYWORDS.has(ident)) return this._wrap_('hl-keyword', ident);
        if (BUILTINS.has(ident)) return this._wrap_('hl-builtin', ident);
        return this._escapeHtml_(ident);
      }
      return this._escapeHtml_(m);
    });
  }

  /**
   * Resalta CSS en un solo pase.
   * @param {string} s Texto sin escapar.
   * @returns {string}
   * @private
   */
  _highlightCss_(s) {
    const UNITS = 'px|em|rem|vh|vw|vmin|vmax|%|ms|s|deg|fr|ch|ex|pt|pc|cm|mm|in';
    const re = new RegExp(
      `(\\/\\*[\\s\\S]*?\\*\\/)` +
      `|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')` +
      `|(@[\\w-]+)` +
      `|(#[0-9a-fA-F]{3,8})\\b` +
      `|(\\d+(?:\\.\\d+)?)(${UNITS})?\\b` +
      `|(^|[\\s;{}])([\\w-]+)(?=\\s*:)`,
      'gm'
    );

    return this._tokenize_(s, re, (m, groups) => {
      const [comment, str, atRule, hex, num, unit, lead, prop] = groups;
      if (comment) return this._wrap_('hl-comment', comment);
      if (str)     return this._wrap_('hl-string',  str);
      if (atRule)  return this._wrap_('hl-keyword', atRule);
      if (hex)     return this._wrap_('hl-number',  hex);
      if (num !== undefined && num !== '') {
        const u = unit ? this._wrap_('hl-unit', unit) : '';
        return `<span class="hl-number">${this._escapeHtml_(num)}${u}</span>`;
      }
      if (prop)    return this._escapeHtml_(lead) + this._wrap_('hl-prop', prop);
      return this._escapeHtml_(m);
    });
  }

  /**
   * Resalta HTML/XML en un solo pase. Trabaja sobre texto crudo: matchea
   * los `<` y `>` reales y escapa al envolver.
   * @param {string} s Texto sin escapar.
   * @returns {string}
   * @private
   */
  _highlightHtml_(s) {
    const re = /(<!--[\s\S]*?-->)|(<\/?)([\w-]+)([^<>]*?)(\/?>)/g;
    return this._tokenize_(s, re, (m, groups) => {
      const [comment, open, name, attrs, close] = groups;
      if (comment) return this._wrap_('hl-comment', comment);
      if (open) {
        const attrsHl = String(attrs || '').replace(
          /([\w-]+)(=)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
          (_, k, eq, v) =>
            this._wrap_('hl-prop', k) + this._escapeHtml_(eq) + this._wrap_('hl-string', v)
        );
        // Las partes de `attrs` que no son atributos completos quedan sin envolver
        // pero ya pasaron por escape parcial dentro del replace. Para los huecos
        // que no matchearon (espacios), escapamos individualmente.
        const safeAttrs = this._escapeAttrSegment_(attrs, attrsHl);
        return this._wrap_('hl-keyword', open + name) + safeAttrs + this._wrap_('hl-keyword', close);
      }
      return this._escapeHtml_(m);
    });
  }

  /**
   * Helper para HTML: si el procesado de atributos contiene caracteres
   * peligrosos no escapados (porque no eran clave/valor), aplica un escape
   * mínimo de `<` y `>` sobre los huecos.
   * @param {string} originalAttrs
   * @param {string} processedAttrs
   * @returns {string}
   * @private
   */
  _escapeAttrSegment_(originalAttrs, processedAttrs) {
    // Si processedAttrs sigue siendo idéntico al original (no había atributos
    // matcheables), escapamos completo. Si hubo replaces, asumimos que los
    // segmentos sin envolver son seguros (espacios típicamente).
    if (processedAttrs === originalAttrs) {
      return this._escapeHtml_(originalAttrs);
    }
    return processedAttrs;
  }

  /**
   * Resalta JSON en un solo pase. Distingue claves (string seguida de `:`)
   * de strings ordinarios.
   * @param {string} s Texto sin escapar.
   * @returns {string}
   * @private
   */
  _highlightJson_(s) {
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/g;
    return this._tokenize_(s, re, (m, groups) => {
      const [str, colon, num, lit] = groups;
      if (str) {
        return colon
          ? this._wrap_('hl-prop', str) + this._escapeHtml_(colon)
          : this._wrap_('hl-string', str);
      }
      if (num) return this._wrap_('hl-number',  num);
      if (lit) return this._wrap_('hl-keyword', lit);
      return this._escapeHtml_(m);
    });
  }

  /**
   * Recorre `src` con `regex` (debe ser global), pasa cada match al callback
   * y escapa los segmentos que no matchearon. Construye el resultado.
   * @param {string} src
   * @param {RegExp} regex
   * @param {(m:string, groups:Array<string|undefined>) => string} cb
   * @returns {string}
   * @private
   */
  _tokenize_(src, regex, cb) {
    const out = [];
    let lastIndex = 0;
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(src)) !== null) {
      if (match.index > lastIndex) {
        out.push(this._escapeHtml_(src.slice(lastIndex, match.index)));
      }
      out.push(cb(match[0], match.slice(1)));
      lastIndex = match.index + match[0].length;
      // Evitar bucles infinitos si el regex matchea cadena vacía.
      if (match[0].length === 0) regex.lastIndex++;
    }
    if (lastIndex < src.length) {
      out.push(this._escapeHtml_(src.slice(lastIndex)));
    }
    return out.join('');
  }

  /**
   * Envuelve el texto en un `<span>` con la clase indicada, escapando el
   * contenido para evitar inyección.
   * @param {string} cls
   * @param {string} text
   * @returns {string}
   * @private
   */
  _wrap_(cls, text) {
    return `<span class="${cls}">${this._escapeHtml_(text)}</span>`;
  }

  /**
   * Convierte un bloque de tabla GFM ya escapado a `<table>`. Detecta la
   * alineación por columna a partir de la línea separadora.
   * @param {string} block Bloque ya pasado por escape HTML.
   * @returns {string}
   * @private
   */
  _renderTable_(block) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) return block;

    const splitRow = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const header = splitRow(lines[0]);
    const align  = splitRow(lines[1]).map((c) => {
      if (/^:-+:$/.test(c)) return 'center';
      if (/^-+:$/.test(c))  return 'right';
      if (/^:-+$/.test(c))  return 'left';
      return '';
    });
    const rows = lines.slice(2).map(splitRow);

    const th = header
      .map((h, i) => `<th${align[i] ? ` style="text-align:${align[i]}"` : ''}>${h}</th>`)
      .join('');
    const trs = rows.map((r) =>
      '<tr>' + r.map((c, i) =>
        `<td${align[i] ? ` style="text-align:${align[i]}"` : ''}>${c}</td>`
      ).join('') + '</tr>'
    ).join('');

    return `<table class="gc__table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>\n`;
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
      btn.classList.add('gc__codeBtn--success');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('gc__codeBtn--success');
      }, 1400);
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
    // Devuelve el foco al primer campo interactivo.
    setTimeout(() => {
      this.shadowRoot.getElementById('gc__settingsProviderSelect')?.focus();
    }, 120);
  }

  /** Cierra el overlay de settings. */
  _closeSettings_() {
    this.shadowRoot.getElementById('gc__settings')?.classList.remove('gc__open');
    // Devuelve el foco al textarea principal.
    setTimeout(() => {
      this.shadowRoot.getElementById('gc__chatInput')?.focus();
    }, 30);
  }

  /** Sincroniza el composer (proveedor, modelo) con this._config. */
  _refreshComposerProviderUI_() {
    const sr          = this.shadowRoot;
    const providerSel = sr.getElementById('gc__providerSelect');
    const modelSel    = sr.getElementById('gc__modelSelect');

    if (!providerSel) return;

    providerSel.value  = this._config.provider || 'gemini';
    const provider     = GAS_LLM_PROVIDERS[providerSel.value] || GAS_LLM_PROVIDERS.gemini;
    const provSettings = this._getProviderSettings_(providerSel.value);
    const allModels    = [...(provider.models || []), ...(provSettings.customModels || [])];

    DomUtils.setHTML(modelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
    modelSel.value = this._config.model || allModels[0] || '';
  }

  /** Sincroniza todos los campos del overlay de settings con this._config. */
  _refreshSettingsUI_() {
    const sr               = this.shadowRoot;
    const settingsProvSel  = sr.getElementById('gc__settingsProviderSelect');
    const settingsModelSel = sr.getElementById('gc__settingsModelSelect');
    const apiKeyInput      = sr.getElementById('gc__apiKeyInput');
    const tempInput        = sr.getElementById('gc__tempInput');
    const tempVal          = sr.getElementById('gc__tempVal');
    const sysPrompt        = sr.getElementById('gc__systemPrompt');
    const keyLabel          = sr.getElementById('gc__apiKeyLabel');
    const customModelsInput = sr.getElementById('gc__customModels');
    const endpointField     = sr.getElementById('gc__endpointField');
    const endpointUrlInput  = sr.getElementById('gc__endpointUrl');

    const providerId = this._config.provider || 'gemini';
    const provider   = GAS_LLM_PROVIDERS[providerId] || GAS_LLM_PROVIDERS.gemini;
    const provSettings = this._getProviderSettings_(providerId);

    if (settingsProvSel) {
      DomUtils.setHTML(
        settingsProvSel,
        Object.entries(GAS_LLM_PROVIDERS)
          .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
          .join('')
      );
      settingsProvSel.value = providerId;
    }

    const allModels = [...(provider.models || []), ...(provSettings.customModels || [])];
    if (settingsModelSel) {
      DomUtils.setHTML(settingsModelSel, allModels.map((m) => `<option value="${m}">${m}</option>`).join(''));
      settingsModelSel.value = this._config.model || allModels[0] || '';
    }

    apiKeyInput.value       = this._config.apiKeys?.[providerId] || '';
    apiKeyInput.placeholder = provider.keyHint || 'API key';
    if (keyLabel) keyLabel.textContent = `API Key — ${provider.label}`;

    tempInput.value     = String(provSettings.temperature ?? 0.3);
    tempVal.textContent = String(provSettings.temperature ?? 0.3);
    tempInput.setAttribute('aria-valuenow', tempInput.value);
    sysPrompt.value     = provSettings.systemPrompt || '';

    if (customModelsInput) {
      customModelsInput.value = (provSettings.customModels || []).join('\n');
    }

    if (endpointUrlInput) {
      endpointUrlInput.value = provSettings.endpointUrl || '';
    }
    if (endpointField) {
      endpointField.style.display = providerId === 'custom' ? 'block' : 'none';
    }

    this._refreshComposerProviderUI_();
  }

  // ──────────────────────────────────────────────────────────────────
  // RESIZE
  // ──────────────────────────────────────────────────────────────────

  /** Inicia el resize manual. */
  _startResize(evt) {
    const rect = this.getBoundingClientRect();
    this.style.right = `${window.innerWidth - rect.right}px`;
    this.style.left  = 'auto';
    this._resizeState = {
      startX: evt.clientX,
      startY: evt.clientY,
      startW: this.offsetWidth,
      startH: this.offsetHeight,
    };
    window.addEventListener('mousemove', this._onResizeMove);
    window.addEventListener('mouseup', this._onResizeEnd);
  }

  /** Actualiza el tamaño durante el resize. */
  _onResizeMove(evt) {
    if (!this._resizeState) return;
    const minW = 340, minH = 400;
    const maxW = window.innerWidth  - 18;
    const maxH = window.innerHeight - 140;
    const nextW = this._resizeState.startW - (evt.clientX - this._resizeState.startX);
    const nextH = this._resizeState.startH + (evt.clientY - this._resizeState.startY);
    this.style.width  = `${Math.max(minW, Math.min(nextW, maxW))}px`;
    this.style.height = `${Math.max(minH, Math.min(nextH, maxH))}px`;
  }

  /** Finaliza el resize. */
  _onResizeEnd() {
    this._resizeState = null;
    window.removeEventListener('mousemove', this._onResizeMove);
    window.removeEventListener('mouseup', this._onResizeEnd);
  }
}

// Registro idempotente del Web Component.
if (!customElements.get('gas-chat-panel')) {
  customElements.define('gas-chat-panel', GasChatPanel);
}