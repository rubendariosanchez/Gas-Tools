"use strict";

/**
 * @fileoverview Bootstrap de la página del Side Panel (chat de IA).
 *
 * Orden: bridge LLM → settings (tema) → idioma → crear `<gas-chat-panel>`
 * con el adaptador remoto del editor → barra de contexto con el archivo
 * activo. El chat se crea después de fijar tema e idioma porque el
 * componente los lee al conectarse.
 */
(() => {
  const CONTEXT_REFRESH_MS = 4000;

  /** `chrome.runtime.sendMessage` con fallback (nunca lanza). */
  const sendToBackground = (message, fallback = null) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { resolve(fallback); return; }
        resolve(response ?? fallback);
      });
    } catch (_) {
      resolve(fallback);
    }
  });

  /** Aplica el tema (opción "IDE Dark Mode"): los tokens --gt-* del body lo propagan. */
  const applyTheme_ = (options) => {
    document.body.classList.toggle('qc__is-dark-mode', options?.['ide-dark-mode'] === true);
  };

  /** Barra de contexto: archivo activo o aviso de "sin editor". */
  const contextBar = document.getElementById('sideContext');
  const contextLabel = document.getElementById('sideContextLabel');
  let lastContextKey = '';

  const renderContext_ = (info) => {
    const key = info.available ? `ok:${info.fileName}` : `none:${info.reason || ''}`;
    if (key === lastContextKey) return;
    lastContextKey = key;
    contextBar.dataset.state = info.available ? 'ok' : 'none';
    const reasons = {
      'reload-tab': () => DomUtils.t('edSideReloadTab', 'Reload this Apps Script tab to connect the editor.'),
      'not-ready':  () => DomUtils.t('edSideNotReady', 'Waiting for the Apps Script editor…'),
    };
    contextLabel.textContent = info.available
      ? (info.fileName || DomUtils.t('edSideEditorConnected', 'Apps Script editor connected'))
      : (reasons[info.reason]?.() || DomUtils.t('edSideNoEditor', "This tab isn't an Apps Script editor. Open a project to use the editor context."));
    contextLabel.title = contextLabel.textContent;
  };

  /** Pestaña a la que apunta el panel (fija por `?tabId=N` o la activa). */
  const resolveTargetTab_ = async (targetTabId) => {
    try {
      if (targetTabId != null) return await chrome.tabs.get(targetTabId);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch (_) {
      return null;
    }
  };

  /** scriptId del proyecto de Apps Script de la pestaña objetivo (o null). */
  const resolveScriptId_ = async (targetTabId) => {
    const tab = await resolveTargetTab_(targetTabId);
    return typeof GasProjectFiles !== 'undefined' ? GasProjectFiles.scriptIdFromUrl(tab?.url) : null;
  };

  async function main_() {
    GasLlmBridge.install({ sendToBackground });

    const settings = await sendToBackground({ type: 'GET_SETTINGS' }, {});
    const lang = settings?.['ui-language'] === 'es' ? 'es' : 'en';
    const i18n = lang === 'en' ? null : await sendToBackground({ type: 'GET_EDITOR_I18N', payload: { lang } }, null);
    DomUtils.setI18n(i18n);
    DomUtils.applyI18n(document);
    document.documentElement.lang = lang;
    applyTheme_(settings);

    // Panel por pestaña: el background abre esta página con `?tabId=N`.
    const tabIdParam = Number.parseInt(new URLSearchParams(location.search).get('tabId'), 10);
    const targetTabId = Number.isInteger(tabIdParam) ? tabIdParam : null;
    const editor = new GasRemoteEditor(chrome, targetTabId);
    const panel = document.createElement('gas-chat-panel');
    panel.setAttribute('mode', 'sidepanel');
    panel.setEditorAdapter?.(editor);
    // Servicios del host: background (crear archivos, login de Google) e
    // historial de conversaciones por proyecto.
    let scriptId = await resolveScriptId_(targetTabId);
    panel.setHost?.({
      sendToBackground,
      scriptId,
      store: typeof GasChatStore !== 'undefined' ? new GasChatStore() : null,
    });
    document.getElementById('sideMain').appendChild(panel);
    applyTheme_(settings);

    // ── Barra de contexto ──
    let refreshing = false;
    const refreshContext_ = async () => {
      if (refreshing || document.visibilityState !== 'visible') return;
      refreshing = true;
      try {
        renderContext_(await editor.getInfo());
        // Sin pestaña fija el panel sigue a la pestaña activa: el proyecto puede cambiar.
        const nextScriptId = await resolveScriptId_(targetTabId);
        if (nextScriptId && nextScriptId !== scriptId) {
          scriptId = nextScriptId;
          panel.setHost?.({ scriptId });
        }
      } finally { refreshing = false; }
    };
    refreshContext_();
    // El archivo activo cambia dentro de la página sin eventos de pestaña:
    // un sondeo ligero (solo con el panel visible) mantiene la barra al día.
    setInterval(refreshContext_, CONTEXT_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshContext_);
    chrome.tabs.onActivated.addListener(refreshContext_);
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (targetTabId != null && tabId !== targetTabId) return;
      if (change.status === 'complete' || change.url) refreshContext_();
    });

    // ── Eventos del editor (vista de revisión de cambios) ──
    // Solo se atienden los de la pestaña a la que apunta este panel.
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type !== 'EDITOR_EVENT' || !msg.event) return;
      const fromTab = sender?.tab?.id;
      if (fromTab == null || (targetTabId != null && fromTab !== targetTabId)) return;
      panel.handleEditorEvent?.(msg.event);
    });

    // ── Cambios desde el popup ──
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'SETTINGS_UPDATED' || msg.payload?.updateType !== 'settings') return;
      const options = msg.payload.options || {};
      const newLang = options['ui-language'] === 'es' ? 'es' : 'en';
      if (newLang !== lang) { location.reload(); return; }
      applyTheme_(options);
    });
  }

  main_().catch((err) => console.error('[GASTools] Side panel init failed:', err));
})();
