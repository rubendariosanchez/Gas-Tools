"use strict";

/**
 * @fileoverview <gas-github-panel> - Panel de sincronización con GitHub.
 *
 * Vistas (`_view`):
 *   - 'loading'   : Verificando sesiones contra el background.
 *   - 'unauth'    : Pantalla de dos pasos (Google + GitHub).
 *   - 'connected' : Panel principal (tabs Changes/Diff + repo + push/pull).
 *
 * API pública:
 *   open(anchor) / close() / toggle(anchor) / setEditor(editor) / refreshBadge()
 *
 * Sincronización:
 *   - Lado GAS: Apps Script API (GET/PUT /v1/projects/{id}/content) vía
 *     `GAS_GG_API_CALL`. Es la fuente de verdad: ve TODOS los archivos
 *     del proyecto y permite crear/borrar atómicamente.
 *   - Lado GitHub: REST API vía `GAS_GH_API_CALL` (Git Data API para el
 *     push, blobs/trees para el pull).
 *
 * Los tokens de Google y GitHub viven solo en el background; nunca llegan
 * al MAIN world ni a este Shadow DOM.
 */
class GasGithubPanel extends HTMLElement {

  /**
   * Inicializa el estado interno del panel y los binds estables de los
   * listeners globales. No toca el DOM aquí; el shell se renderiza en
   * `connectedCallback`.
   */
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** @type {object|null} Active Monaco editor (injected by gas-tools.js). */
    this._editor = null;
    /** @type {HTMLElement|null} Anchor button of the popover. */
    this._anchorEl = null;
    /** @type {'loading'|'unauth'|'connected'} */
    this._view = 'loading';
    /** @type {{login:string,name:string|null,avatar_url:string,html_url:string}|null} */
    this._user = null;
    /**
     * Perfil de la cuenta de Google conectada (para usar la Apps Script
     * API). Sin esta sesión no es posible leer/escribir el contenido del
     * proyecto, así que el panel exige conectar Google antes que GitHub.
     * @type {{email:string,name:string|null,picture:string|null}|null}
     */
    this._googleUser = null;
    /** @type {boolean} Una autenticación de Google está en vuelo. */
    this._googleAuthInFlight = false;
    /** @type {{user_code:string,verification_uri:string}|null} */
    this._deviceCode = null;
    /** @type {boolean} */
    this._waitingAuth = false;

    /** @type {{repo:string,branch:string,basePath:string}|null} */
    this._project = null;
    /** @type {string} */
    this._scriptId = '';

    /** @type {Array<{full_name:string,default_branch:string,private:boolean,html_url:string}>} */
    this._repos = [];
    /** @type {Array<{name:string,commitSha:string}>} */
    this._branches = [];
    this._reposLoaded = false;
    this._loadingRepos = false;
    this._loadingBranches = false;

    /** @type {''|'repo'|'branch'} */
    this._openDropdown = '';
    this._repoFilter = '';
    this._branchFilter = '';
    /** @type {'changes'|'diff'} */
    this._activeTab = 'changes';

    /** @type {Array<{path:string,status:string,local:string,remote:string,plus:number,minus:number}>} */
    this._diffItems = [];
    this._loadingDiff = false;
    /** @type {boolean} A push request is in flight. */
    this._pushing = false;
    /** @type {boolean} A pull request is in flight. */
    this._pulling = false;

    /** @type {boolean} Remote has changes not present locally → pull required. */
    this._remoteHasChanges = false;

    /**
     * Snapshot del último push exitoso. Se usa para enmascarar el cache
     * stale de GitHub durante los segundos posteriores al commit (la API
     * a veces devuelve el tree viejo durante 1-3 s después del push).
     * Sobrevive a close/open del panel (vive en la instancia del componente).
     *
     * @type {{
     *   expiresAt: number,
     *   repo: string,
     *   branch: string,
     *   basePath: string,
     *   files: Map<string, string>
     * }|null}
     */
    this._postPushSnapshot = null;
    /** @type {Set<string>} Paths selected for push. */
    this._selectedFiles = new Set();
    /** @type {string|null} Path of the active file in the Diff tab. */
    this._activeDiffPath = null;
    /** @type {string} Commit message (persists while the panel is open). */
    this._commitMessage = '';

    /** @type {object|null} */
    this._diffEditor = null;
    this._diffOriginalModel = null;
    this._diffModifiedModel = null;

    /** @type {Map<string,Function>} */
    this._pendingBridgeCalls = new Map();

    // Binds estables.
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onWindowResize      = this._onWindowResize.bind(this);
    this._onBridgeResult      = this._onBridgeResult.bind(this);
    this._onDeviceCodePush_   = this._onDeviceCodePush_.bind(this);
  }


  /**
   * Se ejecuta cuando el componente entra en el DOM. Pinta el shell,
   * registra listeners globales y dispara la verificación silenciosa
   * para que el indicador del botón refleje la sesión existente.
   */
  connectedCallback() {
    DomUtils.syncHostTheme(this);
    this._renderShell_();
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    window.addEventListener('keydown',     this._onWindowKeyDown);
    window.addEventListener('resize',      this._onWindowResize);

    [
      'GAS_GH_AUTH_RESULT',
      'GAS_GH_AUTH_DONE',
      'GAS_GH_CANCEL_AUTH_DONE',
      'GAS_GH_LOGOUT_DONE',
      'GAS_GH_PROJECT_RESULT',
      'GAS_GH_SAVE_DONE',
      'GAS_GH_API_RESULT',
      'GAS_GG_AUTH_RESULT',
      'GAS_GG_AUTH_DONE',
      'GAS_GG_LOGOUT_DONE',
      'GAS_GG_API_RESULT',
    ].forEach((evt) => document.addEventListener(evt, this._onBridgeResult));

    document.addEventListener('GAS_GH_DEVICE_CODE', this._onDeviceCodePush_);

    // Silent ping to update the toolbar button badge.
    this._initBadgeFromAuth_();
  }

  /**
   * Limpia listeners globales y libera el editor de diff de Monaco al
   * desmontar el componente.
   */
  disconnectedCallback() {
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('keydown',     this._onWindowKeyDown);
    window.removeEventListener('resize',      this._onWindowResize);
    [
      'GAS_GH_AUTH_RESULT',
      'GAS_GH_AUTH_DONE',
      'GAS_GH_CANCEL_AUTH_DONE',
      'GAS_GH_LOGOUT_DONE',
      'GAS_GH_PROJECT_RESULT',
      'GAS_GH_SAVE_DONE',
      'GAS_GH_API_RESULT',
      'GAS_GG_AUTH_RESULT',
      'GAS_GG_AUTH_DONE',
      'GAS_GG_LOGOUT_DONE',
      'GAS_GG_API_RESULT',
    ].forEach((evt) => document.removeEventListener(evt, this._onBridgeResult));
    document.removeEventListener('GAS_GH_DEVICE_CODE', this._onDeviceCodePush_);
    this._disposeDiffEditor_();
  }


  /**
   * Inyecta la instancia activa de Monaco. Llamado por `gas-tools.js`
   * cada vez que cambia el editor del usuario.
   * @param {object|null} editor
   */
  /**
   * Inyecta la instancia activa de Monaco. Conservado por compatibilidad
   * con `gas-tools.js`; el panel ya no necesita el editor para sincronizar
   * porque ahora usa la Apps Script API como fuente de verdad. La
   * referencia se guarda solo por si futuras features la requieren.
   * @param {object|null} editor
   */
  setEditor(editor) {
    this._editor = editor || null;
  }

  /** Re-aplica el indicador del botón tras una reinyección de la toolbar. */
  refreshBadge() {
    this._updateAnchorBadge_();
  }

  /**
   * Abre el panel anclado a un botón. Cada apertura invalida los caches
   * y vuelve a verificar:
   *   - sesión de GitHub (token válido contra `/user`),
   *   - lista de repos del usuario,
   *   - diff entre los archivos de GAS y el repo remoto.
   *
   * Garantiza que el panel siempre refleja el estado real, nunca un
   * snapshot anterior.
   *
   * @param {HTMLElement|null} [anchorEl] Botón de la toolbar al que anclar.
   */
  open(anchorEl) {
    if (anchorEl) this._anchorEl = anchorEl;
    DomUtils.closeOtherFloatingPanels('gas-github-panel');

    this._scriptId = this._extractScriptId_();
    this.style.display = 'block';

    // Invalida caches para que el próximo render pida datos frescos.
    this._reposLoaded = false;
    this._branches = [];
    this._diffItems = [];
    this._activeTab = 'changes';
    this._expandedDiffPaths = null;
    // El commit message no debería persistir entre sesiones de panel:
    // cada vez que el usuario abre el popover empieza con el campo limpio.
    this._commitMessage = '';
    this._selectedFiles.clear();

    this._refreshAuth_();
    requestAnimationFrame(() => this._positionPanel_());
  }

  /**
   * Dispara la acción "Save all" de GAS simulando Ctrl+S sobre el editor
   * Monaco activo. GAS no expone API pública para esto, así que usamos
   * el atajo registrado por su propio editor. La Apps Script API lee
   * del storage interno de GAS (no de Monaco), así que sin este Ctrl+S
   * los cambios sin guardar quedarían fuera del diff. Es asíncrono:
   * el caller debe esperar (~300 ms) a que GAS persista antes del GET.
   * @private
   */
  _triggerGasSave_() {
    try {
      const ev = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        keyCode: 83,
        which: 83,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(ev);
    } catch (err) {
      console.warn('[gas-github-panel] Could not trigger Save:', err);
    }
  }

  /** Cierra el panel y libera recursos del diff editor. */
  close() {
    this.style.display = 'none';
    this._openDropdown = '';
    this._disposeDiffEditor_();
  }

  /**
   * Alterna abierto/cerrado.
   * @param {HTMLElement|null} [anchorEl]
   */
  toggle(anchorEl) {
    if (this.style.display === 'block') this.close();
    else this.open(anchorEl);
  }


  _renderShell_() {
    DomUtils.setHTML(this.shadowRoot, `
      <style>
        /* Design tokens compartidos: ver DomUtils.themeTokensCss(). */
        ${DomUtils.themeTokensCss()}

        :host {
          display: none;
          position: fixed;
          top: 102px;
          right: 14px;
          z-index: 2147483640;
          width: 760px;
          max-height: min(720px, calc(100vh - 110px));
          background: var(--gc-bg-elevated);
          color: var(--gc-text);
          border: 1px solid var(--gc-border);
          border-radius: 14px;
          box-shadow: var(--gc-shadow-panel);
          font-family: var(--gc-font);
          overflow: visible;             /* arrow extends beyond the box */
          animation: qc__gh-in .16s ease-out;
        }
        /* Modos compactos para login y verificación. */
        :host([data-view="unauth"]),
        :host([data-view="loading"]) {
          width: 420px;
          max-height: min(540px, calc(100vh - 130px));
        }
        /* Flecha tipo popover apuntando hacia el botón ancla. */
        :host::before,
        :host::after {
          content: '';
          position: absolute;
          top: -8px;
          right: var(--qc-gh-arrow-offset, 26px);
          width: 0; height: 0;
          border-left: 8px solid transparent;
          border-right: 8px solid transparent;
        }
        :host::before { border-bottom: 8px solid rgba(0,0,0,.08); }
        :host::after  { top: -7px; border-bottom: 8px solid #ffffff; }
        @keyframes qc__gh-in {
          from { transform: translateY(-6px); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }
        .material-icons {
          font-family: 'Material Icons', 'Material Icons Extended', 'Google Material Icons', sans-serif;
          font-weight: normal;
          font-style: normal;
          font-size: 18px;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          display: inline-block;
          white-space: nowrap;
          direction: ltr;
          -webkit-font-feature-settings: 'liga';
          -webkit-font-smoothing: antialiased;
        }

        .qc__gh-shell {
          display: flex; flex-direction: column;
          height: 100%; max-height: inherit;
          background: var(--gc-bg-elevated);
          border-radius: inherit;
          overflow: hidden;
        }

        .qc__gh-header {
          display: flex; align-items: center; gap: 12px;
          padding: 14px 16px 12px;
          border-bottom: 1px solid var(--gc-border);
          flex: 0 0 auto;
        }
        .qc__gh-avatar {
          width: 36px; height: 36px; border-radius: 999px; flex: 0 0 auto;
          background: rgba(26,115,232,.10);
          display: grid; place-items: center;
          color: var(--gc-accent); overflow: hidden;
          position: relative;
        }
        .qc__gh-avatar img {
          width: 100%; height: 100%;
          object-fit: cover;
          background: rgba(26,115,232,.10);
          display: block;
        }
        .qc__gh-avatar img[alt]:after {
          /* Hide the alt-text fallback if the image fails to load (some
             browsers render it with a red border). */
          content: '';
        }
        .qc__gh-hdrText { flex: 1; min-width: 0; }
        .qc__gh-hdrTitle {
          font-size: 14px; font-weight: 600; color: var(--gc-text);
          line-height: 1.25;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .qc__gh-hdrSub {
          font-size: 12px; color: var(--gc-text-muted);
          line-height: 1.25; margin-top: 1px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .qc__gh-hdrAction {
          border: none; background: transparent; color: var(--gc-text-muted);
          width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto;
          transition: background .15s, color .15s;
        }
        .qc__gh-hdrAction:hover { background: var(--gc-hover-strong); color: var(--gc-text); }
        .qc__gh-hdrAction .material-icons { font-size: 18px; }

        .qc__gh-body {
          padding: 14px 16px;
          overflow: hidden;        /* el scroll lo gestiona cada columna */
          flex: 1; min-width: 0;
          display: flex; flex-direction: column; gap: 14px;
          min-height: 0;
        }

        .qc__gh-grid {
          display: grid;
          grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
          gap: 16px;
          align-items: stretch;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }
        .qc__gh-col {
          display: flex; flex-direction: column;
          gap: 10px;
          min-width: 0;
          min-height: 0;
        }
        /* Columna izquierda: fija, sin scroll. Si el contenido excede,
           ese campo concreto (commit message) crece dentro de su propio
           espacio. */
        .qc__gh-colLeft {
          padding-right: 14px;
          border-right: 1px solid rgba(0,0,0,.06);
          overflow: hidden;
        }
        /* Columna derecha: tabs fijos arriba, tabBody scrollea. */
        .qc__gh-colRight {
          gap: 8px;
          overflow: hidden;       /* el scroll lo hace tabBody */
          padding-right: 2px;
        }
        .qc__gh-grow { flex: 1; min-height: 0; }
        .qc__gh-commitArea { min-height: 90px; height: 100%; resize: none; }

        /* Tabs sticky: quedan visibles aunque la lista se scrollee. */
        .qc__gh-tabs {
          flex: 0 0 auto;
        }

        /* La tab body es la zona scrolleable de la columna derecha. */
        .qc__gh-tabBody {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }

        .qc__gh-sectionTitle {
          font-size: 11px; font-weight: 600;
          letter-spacing: 0.6px; text-transform: uppercase;
          color: var(--gc-text-muted); margin: 0;
        }
        .qc__gh-sectionHead { display: flex; align-items: center; gap: 6px; }
        .qc__gh-sectionHead .qc__gh-sectionTitle { flex: 1; }
        .qc__gh-sectionActions { display: flex; gap: 2px; flex: 0 0 auto; }

        .qc__gh-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .qc__gh-fieldLabel {
          font-size: 12px; font-weight: 500; color: var(--gc-text);
        }
        .qc__gh-optional { color: var(--gc-text-faint); font-weight: 400; font-size: 11px; }

        .qc__gh-row { display: flex; gap: 8px; align-items: stretch; }
        .qc__gh-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

        .qc__gh-selectorWrap { position: relative; flex: 1; min-width: 0; }
        .qc__gh-selector {
          display: flex; align-items: center; gap: 8px;
          height: 38px; padding: 0 12px;
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          cursor: pointer;
          font-size: 13px; color: var(--gc-text);
          width: 100%; min-width: 0; text-align: left;
          font-family: inherit;
          transition: border-color .15s, box-shadow .15s;
        }
        .qc__gh-selector:hover { border-color: var(--gc-accent); }
        .qc__gh-selector[aria-expanded="true"] {
          border-color: var(--gc-accent);
          box-shadow: 0 0 0 3px rgba(26,115,232,.12);
        }
        .qc__gh-selector[disabled] { opacity: .55; cursor: not-allowed; }
        .qc__gh-selector .material-icons.qc__gh-selectorIcon {
          font-size: 16px; color: var(--gc-text-muted); flex: 0 0 auto;
        }
        .qc__gh-selectorLabel {
          flex: 1; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-weight: 500;
        }
        .qc__gh-selectorChevron { font-size: 18px !important; color: var(--gc-text-faint); flex: 0 0 auto; }
        .qc__gh-selectorBadge {
          padding: 2px 6px;
          background: var(--gc-hover-soft); color: var(--gc-text-muted);
          border-radius: 4px;
          font-size: 10.5px; font-weight: 500;
          flex: 0 0 auto;
        }

        .qc__gh-dropdown {
          position: absolute;
          top: calc(100% + 4px); left: 0; right: 0;
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          border-radius: 10px;
          box-shadow: 0 12px 32px rgba(0,0,0,.14);
          z-index: 5;
          overflow: hidden;
          animation: qc__gh-ddIn .14s ease-out;
        }
        @keyframes qc__gh-ddIn {
          from { transform: translateY(-4px); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }
        .qc__gh-ddSearch {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--gc-border);
        }
        .qc__gh-ddSearch .material-icons { font-size: 16px; color: var(--gc-text-faint); }
        .qc__gh-ddSearch input {
          flex: 1; border: none; outline: none; background: transparent;
          font-family: inherit; font-size: 13px; color: inherit;
        }
        .qc__gh-ddList { max-height: 240px; overflow-y: auto; padding: 4px; }
        .qc__gh-ddItem {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px; border-radius: 6px;
          cursor: pointer; font-size: 13px; color: var(--gc-text); line-height: 1.2;
        }
        .qc__gh-ddItem:hover { background: rgba(26,115,232,.08); }
        .qc__gh-ddItem.qc__gh-active { background: rgba(26,115,232,.10); }
        .qc__gh-ddItem .material-icons { font-size: 16px; color: var(--gc-text-muted); flex: 0 0 auto; }
        .qc__gh-ddItemLabel {
          flex: 1; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .qc__gh-ddCheck { color: var(--gc-accent) !important; }
        .qc__gh-ddEmpty {
          padding: 14px; text-align: center;
          font-size: 12px; color: var(--gc-text-faint);
        }
        .qc__gh-ddFooter {
          padding: 4px;
          border-top: 1px solid var(--gc-border);
          background: var(--gc-surface-soft);
        }
        .qc__gh-ddFooterBtn {
          display: flex; align-items: center; gap: 8px;
          width: 100%;
          padding: 8px 10px;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: var(--gc-accent);
          font-size: 12.5px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          text-align: left;
          transition: background .12s;
        }
        .qc__gh-ddFooterBtn:hover { background: rgba(26,115,232,.08); }
        .qc__gh-ddFooterBtn .material-icons { font-size: 16px; color: inherit; }

        .qc__gh-input {
          height: 38px; padding: 0 12px;
          border: 1px solid var(--gc-border); border-radius: 8px;
          background: var(--gc-bg-elevated); color: var(--gc-text);
          font-size: 13px; outline: none;
          width: 100%; min-width: 0; box-sizing: border-box;
          font-family: inherit;
          transition: border-color .15s, box-shadow .15s;
        }
        .qc__gh-input:focus {
          border-color: var(--gc-accent);
          box-shadow: 0 0 0 3px rgba(26,115,232,.14);
        }
        .qc__gh-input::placeholder { color: var(--gc-text-faint); }
        textarea.qc__gh-input {
          height: auto; min-height: 60px;
          padding: 10px 12px; resize: vertical; line-height: 1.4;
          font-family: inherit;
        }

        .qc__gh-iconBtn {
          background: transparent; border: 1px solid transparent;
          border-radius: 8px;
          width: 30px; height: 30px; padding: 0;
          cursor: pointer; color: var(--gc-text-muted);
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto;
          transition: background .15s, color .15s;
        }
        .qc__gh-iconBtn:hover { background: var(--gc-hover-strong); color: var(--gc-text); }
        .qc__gh-iconBtn .material-icons { font-size: 16px; }
        .qc__gh-openExternal {
          width: 38px; height: 38px; border-radius: 8px;
          background: var(--gc-hover-soft); color: var(--gc-text-muted);
        }
        .qc__gh-openExternal:hover { background: var(--gc-hover-strong); color: var(--gc-text); }
        .qc__gh-openExternal .material-icons { font-size: 16px; }

        /* Fila que contiene los tabs y el botón de refrescar diff. */
        .qc__gh-tabsRow {
          display: flex; align-items: center; gap: 6px;
          flex: 0 0 auto;
        }
        .qc__gh-tabsRow .qc__gh-tabs { flex: 1; min-width: 0; }
        .qc__gh-tabsRow .qc__gh-iconBtn {
          width: 38px; height: 38px; border-radius: 10px;
          background: var(--gc-hover-soft);
        }
        .qc__gh-tabsRow .qc__gh-iconBtn:hover { background: var(--gc-hover-strong); }
        .qc__gh-tabsRow .qc__gh-iconBtn[disabled] {
          opacity: .55; cursor: not-allowed;
        }
        .qc__gh-tabs {
          display: grid; grid-template-columns: 1fr 1fr;
          background: var(--gc-hover-soft);
          border-radius: 10px; padding: 4px;
        }
        .qc__gh-tab {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 6px; height: 32px;
          background: transparent; border: none;
          border-radius: 7px;
          color: var(--gc-text-muted); font-size: 12.5px; font-weight: 500;
          cursor: pointer; font-family: inherit;
          transition: background .15s, color .15s, box-shadow .15s;
        }
        .qc__gh-tab .material-icons { font-size: 15px; }
        .qc__gh-tab:hover { color: var(--gc-text); }
        .qc__gh-tab.qc__gh-activeTab {
          background: var(--gc-bg-elevated); color: var(--gc-text);
          box-shadow: 0 1px 3px rgba(0,0,0,.08);
        }

        .qc__gh-changesCard {
          border: 1px solid var(--gc-border);
          border-radius: 10px;
          background: var(--gc-bg-elevated);
          overflow: hidden;
        }
        .qc__gh-changesHead {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 10px;
          background: var(--gc-surface-soft);
          border-bottom: 1px solid var(--gc-border);
          font-size: 12px; color: var(--gc-text-muted);
        }
        .qc__gh-selectAll {
          display: inline-flex; align-items: center; gap: 8px;
          color: var(--gc-text); cursor: pointer; font-size: 12px;
          background: transparent; border: none;
          padding: 0; font-family: inherit;
        }
        .qc__gh-changesList {
          display: flex; flex-direction: column;
          padding: 4px;
          min-height: 0;
        }
        .qc__gh-changeItem {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12.5px; color: var(--gc-text);
          transition: background .12s;
        }
        .qc__gh-changeItem:hover { background: var(--gc-hover-soft); }
        .qc__gh-check {
          width: 14px; height: 14px;
          border: 1.5px solid #d0d7de;
          border-radius: 3px;
          display: grid; place-items: center;
          flex: 0 0 auto;
          background: var(--gc-bg-elevated);
          transition: background .15s, border-color .15s;
        }
        .qc__gh-changeItem.qc__gh-selected .qc__gh-check,
        .qc__gh-selectAll.qc__gh-selected .qc__gh-check {
          background: var(--gc-green-strong); border-color: var(--gc-green-strong); color: var(--gc-text-on-accent);
        }
        .qc__gh-check .material-icons {
          font-size: 11px; color: inherit; opacity: 0;
        }
        .qc__gh-changeItem.qc__gh-selected .qc__gh-check .material-icons,
        .qc__gh-selectAll.qc__gh-selected .qc__gh-check .material-icons {
          opacity: 1;
        }
        .qc__gh-changeStatus {
          width: 16px; height: 16px;
          border-radius: 3px;
          display: grid; place-items: center;
          flex: 0 0 auto;
          font-size: 11px; font-weight: 700; line-height: 1;
        }
        .qc__gh-changeStatus.add { background: var(--gc-green-soft); color: var(--gc-green-text); }
        .qc__gh-changeStatus.del { background: var(--gc-red-soft); color: var(--gc-red-text); }
        .qc__gh-changeStatus.mod { background: var(--gc-amber-soft); color: var(--gc-amber-text); }
        .qc__gh-changePath {
          flex: 1; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-size: 12.5px;
        }
        .qc__gh-changePathDir { color: var(--gc-text-muted); }
        .qc__gh-changePathFile { color: var(--gc-text); font-weight: 600; }
        .qc__gh-changedelta {
          flex: 0 0 auto;
          font-size: 11px;
          font-family: "Roboto Mono", Consolas, monospace;
          font-weight: 600;
        }
        .qc__gh-changedelta .add { color: var(--gc-green-text); }
        .qc__gh-changedelta .del { color: var(--gc-red-text); }

        .qc__gh-changesEmpty {
          text-align: center; padding: 24px 12px;
          font-size: 12.5px; color: var(--gc-text-faint);
        }

        .qc__gh-diffWrap { display: flex; flex-direction: column; gap: 8px; }

        .qc__gh-diffCard {
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          background: var(--gc-bg-elevated);
          overflow: hidden;
        }
        .qc__gh-diffCardHead {
          display: flex; align-items: center; gap: 8px;
          width: 100%;
          padding: 8px 10px;
          background: var(--gc-surface-soft);
          border: none;
          border-bottom: 1px solid transparent;
          cursor: pointer;
          font-family: inherit;
          font-size: 12.5px;
          color: var(--gc-text);
          text-align: left;
          transition: background .12s;
        }
        .qc__gh-diffCardHead:hover { background: var(--gc-surface-soft-hover); }
        .qc__gh-diffCard.qc__gh-diffCardOpen .qc__gh-diffCardHead {
          border-bottom-color: var(--gc-border);
        }
        .qc__gh-diffCardChevron {
          font-size: 18px !important; color: var(--gc-text-muted); flex: 0 0 auto;
          transition: transform .15s;
        }
        .qc__gh-diffCard.qc__gh-diffCardOpen .qc__gh-diffCardChevron {
          transform: rotate(90deg);
        }
        .qc__gh-diffCardPath {
          flex: 1; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-weight: 500;
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 11.5px;
        }
        .qc__gh-diffCardBody:empty { display: none; }

        /* Badge compacto en el header de cada card que aclara qué lado
           del diff es Remote (GitHub) y cuál Local (GAS). El tooltip
           expande la información completa. */
        .qc__gh-diffOrigin {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 1px 6px;
          border-radius: 4px;
          font-size: 10px; font-weight: 600;
          letter-spacing: .3px;
          font-family: "Roboto Mono", Consolas, monospace;
          flex: 0 0 auto;
          line-height: 1;
          white-space: nowrap;
        }
        .qc__gh-diffOrigin.mod { background: var(--gc-hover-strong); color: var(--gc-text-faint); }
        .qc__gh-diffOrigin.add { background: var(--gc-green-dim); color: var(--gc-green-text); }
        .qc__gh-diffOrigin.del { background: var(--gc-red-dim); color: var(--gc-red-text); }
        .qc__gh-diffOrigin .material-icons {
          font-size: 11px !important; line-height: 1;
        }

        .qc__gh-diff2html {
          max-height: 320px;
          overflow: auto;
          background: var(--gc-bg-elevated) !important;
          color: var(--gc-text) !important;
          font-size: 11.5px;
        }
        .qc__gh-diff2html .d2h-wrapper,
        .qc__gh-diff2html .d2h-file-wrapper,
        .qc__gh-diff2html .d2h-files-diff,
        .qc__gh-diff2html .d2h-file-diff {
          background: var(--gc-bg-elevated) !important;
          color: var(--gc-text) !important;
          border: none !important;
          margin: 0 !important;
        }
        .qc__gh-diff2html .d2h-file-header { display: none !important; }
        .qc__gh-diff2html .d2h-diff-table {
          background: var(--gc-bg-elevated) !important;
          color: var(--gc-text) !important;
          font-family: "Roboto Mono", Consolas, monospace !important;
          font-size: 11.5px !important;
          /* Estirar la tabla al ancho del contenido más largo para que
             el fondo de cada fila (rojo en del, verde en ins) cubra
             toda la línea aunque tenga scroll horizontal. Sin esto el
             fondo se corta donde termina la columna visible. */
          width: max-content !important;
          min-width: 100% !important;
        }
        .qc__gh-diff2html .d2h-code-line,
        .qc__gh-diff2html .d2h-code-side-line {
          padding: 0 8px !important;
          color: var(--gc-text) !important;
        }
        .qc__gh-diff2html .d2h-code-line-prefix { color: var(--gc-text-faint) !important; }
        .qc__gh-diff2html .d2h-code-linenumber {
          background: var(--gc-surface-soft) !important;
          color: var(--gc-text-faint) !important;
          border: none !important;
        }
        .qc__gh-diff2html .d2h-info {
          background: var(--gc-info-soft) !important;
          color: var(--gc-info) !important;
          border-color: rgba(9,105,218,.12) !important;
        }
        .qc__gh-diff2html .d2h-ins,
        .qc__gh-diff2html .d2h-ins .d2h-code-line,
        .qc__gh-diff2html .d2h-ins .d2h-code-side-line {
          background: var(--gc-green-dim) !important;
          color: var(--gc-green-text) !important;
        }
        .qc__gh-diff2html .d2h-ins .d2h-code-linenumber {
          background: var(--gc-green-soft) !important;
          color: var(--gc-green-text) !important;
        }
        .qc__gh-diff2html .d2h-del,
        .qc__gh-diff2html .d2h-del .d2h-code-line,
        .qc__gh-diff2html .d2h-del .d2h-code-side-line {
          background: var(--gc-red-dim) !important;
          color: var(--gc-red-text) !important;
        }
        .qc__gh-diff2html .d2h-del .d2h-code-linenumber {
          background: var(--gc-red-soft) !important;
          color: var(--gc-red-text) !important;
        }
        .qc__gh-diff2html .d2h-cntx,
        .qc__gh-diff2html .d2h-cntx .d2h-code-line,
        .qc__gh-diff2html .d2h-cntx .d2h-code-side-line {
          background: var(--gc-bg-elevated) !important;
          color: var(--gc-text) !important;
        }
        .qc__gh-diff2html .d2h-emptyplaceholder { background: var(--gc-surface-soft) !important; }
        .qc__gh-diff2html .d2h-code-line-ctn,
        .qc__gh-diff2html .d2h-code-side-line-ctn { color: inherit !important; }
        /* Cada celda de código se estira para que el fondo coloreado de
           la fila (ins/del) ocupe toda la línea, no solo la parte
           visible en el viewport. */
        .qc__gh-diff2html .d2h-code-line,
        .qc__gh-diff2html .d2h-code-side-line {
          width: max-content !important;
          min-width: 100% !important;
          box-sizing: border-box !important;
        }

        /* highlight.js inside diff2html: light scheme. */
        .qc__gh-diff2html .hljs { background: transparent !important; color: inherit !important; }
        .qc__gh-diff2html .hljs-keyword,
        .qc__gh-diff2html .hljs-selector-tag,
        .qc__gh-diff2html .hljs-section,
        .qc__gh-diff2html .hljs-name { color: var(--gc-red-text) !important; }
        .qc__gh-diff2html .hljs-string,
        .qc__gh-diff2html .hljs-attr,
        .qc__gh-diff2html .hljs-symbol,
        .qc__gh-diff2html .hljs-link { color: #0a3069 !important; }
        .qc__gh-diff2html .hljs-comment,
        .qc__gh-diff2html .hljs-quote { color: var(--gc-text-faint) !important; font-style: italic; }
        .qc__gh-diff2html .hljs-number,
        .qc__gh-diff2html .hljs-literal { color: var(--gc-info) !important; }
        .qc__gh-diff2html .hljs-title,
        .qc__gh-diff2html .hljs-built_in { color: #8250df !important; }
        .qc__gh-diff2html .hljs-tag,
        .qc__gh-diff2html .hljs-meta { color: #116329 !important; }

        /* HTML fallback */
        .qc__gh-diffFallback {
          max-height: 320px;
          overflow: auto;
          padding: 8px;
          background: var(--gc-bg-elevated);
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 11.5px; line-height: 1.5;
        }
        .qc__gh-diffLine { white-space: pre; padding: 0 6px; border-radius: 2px; overflow: hidden; }
        .qc__gh-diffLine.add { background: var(--gc-green-dim); color: var(--gc-green-text); }
        .qc__gh-diffLine.del { background: var(--gc-red-dim); color: var(--gc-red-text); }
        .qc__gh-diffEmpty {
          padding: 16px; text-align: center;
          color: var(--gc-text-faint); font-size: 12px;
        }

        .qc__gh-btn {
          display: inline-flex; align-items: center; justify-content: center;
          gap: 8px; height: 40px; padding: 0 16px;
          border-radius: 10px;
          font-size: 13px; font-weight: 600;
          cursor: pointer;
          border: 1px solid transparent;
          background: var(--gc-surface-soft); color: var(--gc-text);
          font-family: inherit;
          transition: background .15s, border-color .15s, transform .05s;
        }
        .qc__gh-btn:hover { background: var(--gc-surface-soft-hover); }
        .qc__gh-btn:active { transform: translateY(1px); }
        .qc__gh-btn .material-icons { font-size: 16px; }
        .qc__gh-btn.qc__gh-primary { background: var(--gc-green-strong); color: var(--gc-text-on-accent); }
        .qc__gh-btn.qc__gh-primary:hover { background: var(--gc-green-strong); }
        .qc__gh-btn.qc__gh-danger { background: var(--gc-red-strong); color: var(--gc-text-on-accent); }
        .qc__gh-btn.qc__gh-danger:hover { background: var(--gc-red-strong); }
        .qc__gh-btn.qc__gh-ghost {
          background: var(--gc-bg-elevated); border-color: var(--gc-border); color: var(--gc-text);
        }
        .qc__gh-btn.qc__gh-ghost:hover { background: var(--gc-surface-soft); }
        .qc__gh-btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }

        .qc__gh-footer {
          padding: 10px 16px 14px;
          border-top: 1px solid var(--gc-border);
          flex: 0 0 auto;
        }
        .qc__gh-footerRow { display: grid; grid-template-columns: 1fr 1.3fr; gap: 10px; }
        .qc__gh-footerHint {
          margin-top: 6px; text-align: center;
          font-size: 11px; color: var(--gc-text-faint); min-height: 14px;
        }

        .qc__gh-connectCard {
          padding: 14px;
          border: 1px dashed rgba(26,115,232,.30);
          border-radius: 10px;
          background: var(--gc-accent-dim);
          text-align: center;
        }
        .qc__gh-connectIcon {
          width: 40px; height: 40px; border-radius: 999px;
          background: var(--gc-bg);
          color: var(--gc-text);
          display: grid; place-items: center; margin: 0 auto 8px;
        }
        .qc__gh-connectIcon .material-icons { font-size: 22px; }
        .qc__gh-connectTitle { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
        .qc__gh-connectHint { font-size: 11.5px; color: var(--gc-text-muted); line-height: 1.45; }
        .qc__gh-connectHint a { color: var(--gc-accent); text-decoration: none; }
        .qc__gh-connectHint a:hover { text-decoration: underline; }

        /* Layout en pasos para la pantalla unauth (Google + GitHub). */
        .qc__gh-connectStep {
          display: flex; gap: 10px; align-items: flex-start;
          padding: 4px 2px;
          text-align: left;
        }
        .qc__gh-connectStepIcon {
          flex: 0 0 auto;
          width: 28px; height: 28px;
          border-radius: 999px;
          background: rgba(26,115,232,.10);
          color: var(--gc-accent);
          display: grid; place-items: center;
          margin-top: 2px;
        }
        .qc__gh-connectStepIcon .material-icons { font-size: 18px; }
        .qc__gh-connectStepBody { flex: 1; min-width: 0; }
        .qc__gh-connectStepTitle {
          font-size: 13px; font-weight: 600; color: var(--gc-text);
        }
        .qc__gh-connectStepHint {
          font-size: 11.5px; color: var(--gc-text-muted);
          line-height: 1.45; margin-top: 2px;
        }
        .qc__gh-connectStepActions {
          display: flex; gap: 6px; margin-top: 8px;
        }
        .qc__gh-connectStep.qc__gh-stepDisabled .qc__gh-connectStepIcon {
          background: var(--gc-hover-soft); color: var(--gc-text-faint);
        }
        .qc__gh-connectStep.qc__gh-stepDisabled .qc__gh-connectStepTitle { color: var(--gc-text-faint); }
        .qc__gh-connectDivider {
          height: 1px; background: var(--gc-hover-strong);
          margin: 8px 0;
        }
        /* Pequeño badge "G" para el botón de logout de Google en el header. */
        .qc__gh-hdrIconG {
          font-family: "Google Sans", Roboto, Arial, sans-serif;
          font-weight: 700; font-size: 14px;
          line-height: 1;
          color: var(--gc-accent);
        }

        .qc__gh-codeBox {
          display: flex; align-items: center; gap: 8px;
          margin-top: 10px; padding: 8px 10px;
          background: var(--gc-bg-elevated);
          border: 1px dashed rgba(26,115,232,.30); border-radius: 8px;
        }
        .qc__gh-Code {
          flex: 1;
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 18px; font-weight: 700; letter-spacing: 4px;
          color: var(--gc-accent); text-align: center; user-select: all;
        }

        .qc__gh-spinner {
          display: inline-block; width: 12px; height: 12px;
          margin-right: 6px;
          border: 2px solid var(--gc-accent-glow); border-top-color: var(--gc-accent);
          border-radius: 50%;
          vertical-align: -2px;
          animation: qc__gh-spin .9s linear infinite;
        }
        /* Variant for spinners over a colored button (e.g. green Push). */
        .qc__gh-spinner.qc__gh-spinnerOnDark {
          border-color: rgba(255,255,255,.45);
          border-top-color: var(--gc-text-on-accent);
        }
        @keyframes qc__gh-spin { to { transform: rotate(360deg); } }
        .qc__gh-spin .material-icons { animation: qc__gh-spin 1s linear infinite; }

        .qc__gh-spinnerLg {
          width: 22px; height: 22px;
          border-width: 3px;
          margin: 0;
          flex: 0 0 auto;
        }

        /* Verification loader (shown while we ping /user and reload data). */
        .qc__gh-loader {
          display: flex; flex-direction: column;
          gap: 12px;
          padding: 4px 2px;
        }
        .qc__gh-loaderRow {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 12px;
          border: 1px solid var(--gc-border);
          border-radius: 10px;
          background: linear-gradient(135deg, var(--gc-surface-soft), var(--gc-bg-elevated) 60%);
        }
        .qc__gh-loaderTitle {
          font-size: 13px; font-weight: 600; color: var(--gc-text);
          line-height: 1.25;
        }
        .qc__gh-loaderSub {
          font-size: 11.5px; color: var(--gc-text-muted);
          line-height: 1.3; margin-top: 2px;
        }
        .qc__gh-skel--rowGroup {
          display: flex; flex-direction: column; gap: 6px;
        }

        /* Overlay shown over the body while a push/pull is in flight.
           Disables interactions and dims the form until the request
           completes. */
        .qc__gh-busy {
          position: relative;
          pointer-events: none;
        }
        .qc__gh-busy::after {
          content: '';
          position: absolute;
          inset: 0;
          background: rgba(255,255,255,.55);
          backdrop-filter: blur(0.5px);
          z-index: 4;
        }

        .qc__gh-pullWarning {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          margin-bottom: 8px;
          background: var(--gc-amber-soft);
          border: 1px solid var(--gc-amber);
          border-radius: 8px;
          font-size: 12px;
          color: var(--gc-amber-text);
        }
        .qc__gh-pullWarning .material-icons {
          font-size: 16px;
          color: var(--gc-amber);
          flex: 0 0 auto;
        }
        .qc__gh-pullWarning strong {
          font-weight: 600;
        }

        .qc__gh-skeleton {
          background: linear-gradient(90deg, var(--gc-surface-soft-hover) 0%, var(--gc-surface-soft) 50%, var(--gc-surface-soft-hover) 100%);
          background-size: 200% 100%;
          animation: qc__gh-shimmer 1.4s ease-in-out infinite;
          border-radius: 6px;
        }
        .qc__gh-skel--row { height: 38px; margin-bottom: 8px; }
        @keyframes qc__gh-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        .qc__gh-hint { font-size: 11.5px; color: var(--gc-text-muted); margin: 0; }
        .qc__gh-log {
          padding: 8px 10px;
          border: 1px solid var(--gc-border); border-radius: 8px;
          background: var(--gc-surface-soft);
          font-size: 11.5px; color: var(--gc-text);
          max-height: 110px; overflow: auto;
          display: none;
          white-space: pre-wrap;
        }
        .qc__gh-log.qc__gh-visible { display: block; }
        .qc__gh-log.qc__gh-error { background: var(--gc-red-dim); color: var(--gc-red-text); border-color: var(--gc-red-soft); }
        .qc__gh-log.qc__gh-ok    { background: var(--gc-green-dim); color: var(--gc-green-text); border-color: var(--gc-green-soft); }

        .qc__gh-toastStack {
          position: absolute;
          top: 64px;        /* alineado debajo del header (58px alto + margen) */
          left: 12px; right: 12px;
          z-index: 15;
          display: flex; flex-direction: column;
          gap: 6px;
          pointer-events: none;
        }
        .qc__gh-toast {
          pointer-events: auto;
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px 8px 12px;
          border-radius: 10px;
          font-size: 12.5px;
          color: var(--gc-text);
          background: var(--gc-bg-elevated);
          border: 1px solid var(--gc-border);
          box-shadow: var(--gc-shadow-menu);
          opacity: 0;
          transform: translateY(-6px);
          transition: opacity .18s ease-out, transform .18s ease-out;
        }
        .qc__gh-toastShown {
          opacity: 1;
          transform: translateY(0);
        }
        .qc__gh-toastIcon {
          font-size: 18px !important;
          flex: 0 0 auto;
        }
        .qc__gh-toastText {
          flex: 1; min-width: 0;
          line-height: 1.35;
          word-break: break-word;
        }
        .qc__gh-toastClose {
          flex: 0 0 auto;
          background: transparent;
          border: none;
          padding: 2px;
          border-radius: 6px;
          color: inherit;
          opacity: .55;
          cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .qc__gh-toastClose:hover { opacity: 1; background: var(--gc-hover-strong); }
        .qc__gh-toastClose .material-icons { font-size: 14px; }

        /* Variantes por tipo. */
        .qc__gh-toast--ok {
          background: var(--gc-green-dim);
          border-color: var(--gc-green-soft);
          color: var(--gc-green-text);
        }
        .qc__gh-toast--ok .qc__gh-toastIcon { color: var(--gc-green-text); }
        .qc__gh-toast--error {
          background: var(--gc-red-dim);
          border-color: var(--gc-red-soft);
          color: var(--gc-red-text);
        }
        .qc__gh-toast--error .qc__gh-toastIcon { color: var(--gc-red-text); }
        .qc__gh-toast--info {
          background: var(--gc-info-soft);
          border-color: var(--gc-info-border);
          color: var(--gc-info);
        }
        .qc__gh-toast--info .qc__gh-toastIcon { color: var(--gc-info); }

        .qc__gh-modalOverlay {
          position: absolute; inset: 0;
          background: rgba(20,22,28,.45);
          backdrop-filter: blur(1px);
          display: flex; align-items: center; justify-content: center;
          z-index: 10;
          animation: qc__gh-fade .12s ease-out;
        }
        @keyframes qc__gh-fade { from { opacity: 0; } to { opacity: 1; } }
        .qc__gh-modal {
          width: calc(100% - 40px);
          max-width: 380px;
          background: var(--gc-bg-elevated);
          color: var(--gc-text);
          border: 1px solid var(--gc-border);
          border-radius: 12px;
          box-shadow: var(--gc-shadow-menu);
          padding: 18px;
          display: flex; flex-direction: column; gap: 12px;
          animation: qc__gh-modalIn .18s cubic-bezier(.2,.8,.2,1);
          max-height: min(520px, calc(100vh - 160px));
          display: flex;
          flex-direction: column;
        }
        .qc__gh-modalTextWrap {
          flex: 1;
          overflow-y: auto;
          min-height: 0;
          padding-right: 4px;
          margin: 4px 0;
        }
        .qc__gh-modalTextWrap::-webkit-scrollbar {
          width: 6px;
        }
        .qc__gh-modalTextWrap::-webkit-scrollbar-track {
          background: transparent;
        }
        .qc__gh-modalTextWrap::-webkit-scrollbar-thumb {
          background: var(--gc-border);
          border-radius: 999px;
        }
        @keyframes qc__gh-modalIn {
          from { transform: translateY(6px) scale(.98); opacity: 0; }
          to   { transform: translateY(0) scale(1); opacity: 1; }
        }
        .qc__gh-modalTitle {
          font-size: 15px; font-weight: 600; color: var(--gc-text);
          margin: 0 0 2px;
        }
        .qc__gh-modalText {
          font-size: 12.5px;
          color: var(--gc-text);
          line-height: 1.5;
        }
        .qc__gh-radioRow {
          display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
        }
        .qc__gh-radio {
          display: flex; align-items: flex-start; gap: 8px;
          padding: 10px;
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          cursor: pointer;
          font-size: 12px;
          color: var(--gc-text);
          transition: background .12s, border-color .12s;
        }
        .qc__gh-radio:hover { background: var(--gc-hover-soft); }
        .qc__gh-radio input { display: none; }
        .qc__gh-radioCircle {
          width: 14px; height: 14px;
          border: 1.5px solid #d0d7de;
          border-radius: 999px;
          flex: 0 0 auto;
          margin-top: 2px;
          position: relative;
        }
        .qc__gh-radio input:checked + .qc__gh-radioCircle {
          border-color: var(--gc-accent);
        }
        .qc__gh-radio input:checked + .qc__gh-radioCircle::after {
          content: ''; position: absolute;
          top: 2px; left: 2px;
          width: 8px; height: 8px;
          border-radius: 999px;
          background: #1a73e8;
        }
        .qc__gh-radio:has(input:checked) {
          border-color: var(--gc-accent);
          background: rgba(26,115,232,.04);
        }
        .qc__gh-radio strong { font-weight: 600; display: block; line-height: 1.3; }
        .qc__gh-radioHint {
          display: block;
          color: var(--gc-text-muted);
          font-size: 11px;
          margin-top: 2px;
        }
        .qc__gh-modalFooter {
          flex: 0 0 auto;
          border-top: 1px solid var(--gc-border);
          padding-top: 10px;
          margin-top: 4px;
        }
        .qc__gh-modalSelect {
          height: 36px;
          padding: 0 10px;
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          background: var(--gc-bg-elevated); color: var(--gc-text);
          font-size: 13px;
          font-family: inherit;
          outline: none;
          transition: border-color .15s, box-shadow .15s;
        }
        .qc__gh-modalSelect:focus {
          border-color: var(--gc-accent);
          box-shadow: 0 0 0 3px rgba(26,115,232,.14);
        }

        /* Modal especializado de pull: cabecera + lista de archivos
           afectados + footer fijo. */
        .qc__gh-pullSummary {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px;
          background: var(--gc-surface-soft);
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          font-size: 12.5px;
          color: var(--gc-text);
        }
        .qc__gh-pullSummary .material-icons {
          font-size: 18px; color: var(--gc-info);
        }
        .qc__gh-pullSummaryCount { font-weight: 600; }
        .qc__gh-pullList {
          margin-top: 8px;
          margin-bottom: 8px;
          border: 1px solid var(--gc-border);
          border-radius: 8px;
          overflow: hidden;
          max-height: 220px;
          overflow-y: auto;
          background: var(--gc-bg-elevated);
        }
        .qc__gh-pullItem {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 10px;
          font-size: 12px;
          line-height: 1.3;
          border-bottom: 1px solid var(--gc-border);
        }
        .qc__gh-pullItem:last-child { border-bottom: none; }
        .qc__gh-pullStatus {
          width: 18px; height: 18px;
          border-radius: 4px;
          display: grid; place-items: center;
          font-size: 11px; font-weight: 700;
          flex: 0 0 auto;
        }
        .qc__gh-pullStatus.add { background: var(--gc-green-soft); color: var(--gc-green-text); }
        .qc__gh-pullStatus.mod { background: var(--gc-amber-soft); color: var(--gc-amber-text); }
        .qc__gh-pullPath {
          flex: 1; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 11.5px;
          color: var(--gc-text);
        }
        .qc__gh-pullDelta {
          flex: 0 0 auto;
          font-family: "Roboto Mono", Consolas, monospace;
          font-size: 10.5px;
          color: var(--gc-text-muted);
        }
        .qc__gh-pullDelta .add { color: var(--gc-green-text); }
        .qc__gh-pullDelta .del { color: var(--gc-red-text); }
        .qc__gh-pullNote {
          margin-top: 10px;
          padding: 8px 10px;
          background: rgba(26,115,232,.06);
          border-left: 3px solid #1a73e8;
          border-radius: 4px;
          font-size: 11.5px;
          color: var(--gc-text);
          line-height: 1.45;
        }
        .qc__gh-pullNote.warn {
          background: var(--gc-red-dim);
          border-left-color: var(--gc-red-text);
        }
        .qc__gh-pullNote strong { font-weight: 600; }
        .qc__gh-pullCheckRow {
          display: flex; align-items: center; gap: 8px;
          margin-top: 10px;
          font-size: 12px;
          color: var(--gc-text);
          cursor: pointer;
          user-select: none;
        }
        .qc__gh-pullCheckRow input { margin: 0; cursor: pointer; }
      </style>

      <div class="qc__gh-shell">
        <div id="ghHeader" class="qc__gh-header"></div>
        <div id="ghBody" class="qc__gh-body"></div>
        <div id="ghFooter" class="qc__gh-footer" style="display:none"></div>
      </div>
    `);
  }


  /**
   * Verifica la sesión de GitHub y decide qué vista mostrar:
   *   - sin token  → vista 'unauth'
   *   - con token revocado → logout silencioso + vista 'unauth'
   *   - con token válido → vista 'connected' + carga repos y diff frescos
   * @private
   */
  /**
   * Verifica el estado de las dos sesiones que el panel necesita
   * (Google primero, GitHub después). Reglas:
   *   - sin Google → vista 'unauth' Step 1 (botón "Connect Google")
   *   - con Google + sin GitHub → vista 'unauth' Step 2 (botón "Connect GitHub")
   *   - con ambos válidos → vista 'connected'
   *   - token revocado en cualquiera → logout silencioso de ese y vuelta al paso correspondiente
   * @private
   */
  async _refreshAuth_() {
    this._view = 'loading';
    this._renderHeader_();
    this._renderBody_();

    // Paso 1: verificar Google. Sin esta sesión no avanzamos.
    const gg = await this._bridgeCall_('GAS_GG_GET_AUTH');
    this._googleUser = gg?.user || null;

    if (!this._googleUser) {
      // No hay sesión Google: la pantalla unauth muestra Step 1 enfocado.
      this._user = null;
      this._view = 'unauth';
      this._renderHeader_();
      this._renderBody_();
      this._updateAnchorBadge_();
      this._positionPanel_();
      return;
    }

    // Paso 2: verificar GitHub.
    const auth = await this._bridgeCall_('GAS_GH_GET_AUTH');
    if (!auth?.token || !auth?.user) {
      this._user = null;
      this._view = 'unauth';
      this._renderHeader_();
      this._renderBody_();
      this._updateAnchorBadge_();
      this._positionPanel_();
      return;
    }

    // Validar token de GitHub. Si fue revocado → logout silencioso.
    const ping = await this._ghApi_('GET_USER', {});

    if (!ping?.ok) {
      const msg = String(ping?.error || '');
      if (/\b(401|403|Bad credentials)\b/i.test(msg)) {
        await this._bridgeCall_('GAS_GH_LOGOUT');
        this._user = null;
        this._view = 'unauth';
        this._renderHeader_();
        this._renderBody_();
        this._log_('Session expired or revoked. Please sign in again.', 'error');
        this._updateAnchorBadge_();
        this._positionPanel_();
        return;
      }
    } else if (ping.data) {
      this._user = ping.data;
    } else {
      this._user = auth.user;
    }

    this._view = 'connected';
    this._renderHeader_();
    this._renderBody_();
    // En cada apertura refrescamos config de proyecto + repos + diff:
    // le garantizamos al usuario una vista al día con cada click en el
    // botón de GitHub. Cualquier cambio local o remoto desde la última
    // apertura se refleja aquí.
    this._loadProjectConfig_();
    this._refreshRepos_(true);     // force = true ignora el cache
    this._updateAnchorBadge_();
    this._positionPanel_();
  }

  /**
   * Carga el binding scriptId → repo desde el background y, si existe,
   * dispara la carga de branches + recálculo de diff.
   * @private
   */
  async _loadProjectConfig_() {
    if (!this._scriptId) return;
    const cfg = await this._bridgeCall_('GAS_GH_GET_PROJECT', { scriptId: this._scriptId });
    this._project = cfg && typeof cfg === 'object' ? cfg : null;
    this._renderBody_();
    this._updateAnchorBadge_();

    // Si hay un repo asociado al scriptId, traemos las branches y
    // recalculamos el diff contra el remoto.
    if (this._project?.repo && this._project?.branch) {
      this._loadBranches_(this._project.repo);
      this._recomputeDiff_();
    }
  }

  /**
   * Trae los repos accesibles por el token (paginado dentro del servicio).
   * @param {boolean} [force=false] Si `true`, ignora el cache y vuelve a pedir.
   * @private
   */
  async _refreshRepos_(force = false) {
    if (this._reposLoaded && !force) {
      this._renderBody_();
      return;
    }
    this._loadingRepos = true;
    this._lastReposError = null;
    this._renderBody_();
    const result = await this._ghApi_('LIST_REPOS', {});
    this._loadingRepos = false;
    if (result?.ok) {
      this._repos = Array.isArray(result.data) ? result.data : [];
      this._reposLoaded = true;
    } else if (await this._handleAuthError_(result)) {
      return;
    } else {
      this._lastReposError = result?.error || 'Could not load repositories';
      this._log_(this._lastReposError, 'error');
    }
    this._renderBody_();
  }

  /**
   * Trae las branches del repo indicado y refresca el dropdown.
   * @param {string} fullName  `owner/repo`
   * @private
   */
  async _loadBranches_(fullName) {
    this._loadingBranches = true;
    const res = await this._ghApi_('LIST_BRANCHES', { repo: fullName });
    this._loadingBranches = false;
    if (res?.ok) {
      this._branches = Array.isArray(res.data) ? res.data : [];
      this._renderBody_();
    } else if (!(await this._handleAuthError_(res))) {
      this._toast_(res?.error || 'Could not list branches', 'error', 5000);
    }
  }

  /**
   * Handles a 401/403 auth error by silently closing the session.
   * @returns {Promise<boolean>} true if the error was an auth error and was handled.
   */
  async _handleAuthError_(response) {
    if (!response || response.ok) return false;
    const msg = String(response.error || '');
    if (!/\b(401|403|Bad credentials)\b/i.test(msg)) return false;

    await this._bridgeCall_('GAS_GH_LOGOUT');
    this._user = null;
    this._view = 'unauth';
    this._repos = [];
    this._reposLoaded = false;
    this._branches = [];
    this._renderHeader_();
    this._renderBody_();
    this._log_('Session expired or revoked. Please sign in again.', 'error');
    this._updateAnchorBadge_();
    return true;
  }


  _renderHeader_() {
    const header = this.shadowRoot.getElementById('ghHeader');
    if (!header) return;

    if (this._view === 'connected' && this._user) {
      const u = this._user;
      const gg = this._googleUser;
      DomUtils.setHTML(header, `
        <span class="qc__gh-avatar">
          ${u.avatar_url
            ? `<img src="${u.avatar_url}" alt="" referrerpolicy="no-referrer">`
            : `<i class="material-icons">person</i>`}
        </span>
        <span class="qc__gh-hdrText">
          <div class="qc__gh-hdrTitle">${this._escape_(u.name || u.login)}</div>
          <div class="qc__gh-hdrSub">@${this._escape_(u.login)}${
            gg ? ` · <span title="${this._escape_(gg.email || '')}">${this._escape_(gg.email || gg.name || '')}</span>` : ''
          }</div>
        </span>
        <button class="qc__gh-hdrAction" id="ghLogoutAll"
                title="Sign out of GitHub${gg ? ' and Google' : ''}">
          <i class="material-icons">logout</i>
        </button>
        <button class="qc__gh-hdrAction" id="ghClose" title="Close">
          <i class="material-icons">close</i>
        </button>
      `);
    } else {
      DomUtils.setHTML(header, `
        <span class="qc__gh-avatar"><i class="material-icons">code</i></span>
        <span class="qc__gh-hdrText">
          <div class="qc__gh-hdrTitle">GitHub sync</div>
          <div class="qc__gh-hdrSub">Not connected</div>
        </span>
        <button class="qc__gh-hdrAction" id="ghClose" title="Close">
          <i class="material-icons">close</i>
        </button>
      `);
    }

    header.querySelector('#ghClose')?.addEventListener('click', () => this.close());
    header.querySelector('#ghLogoutAll')?.addEventListener('click', () => this._logoutAll_());
  }


  _renderBody_() {
    // Reflejamos la vista en un atributo del host para que el CSS pueda
    // adaptar el ancho del panel según el estado (compacto en login).
    this.setAttribute('data-view', this._view);

    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (!body || !footer) return;

    // Por defecto el footer va escondido; lo activamos solo en vista conectada.
    footer.style.display = 'none';
    DomUtils.setHTML(footer, '');

    // On view change, dispose Monaco diff to avoid leaks.
    this._disposeDiffEditor_();

    if (this._view === 'loading') {
      DomUtils.setHTML(body, `
        <div class="qc__gh-loader">
          <div class="qc__gh-loaderRow">
            <span class="qc__gh-spinner qc__gh-spinnerLg"></span>
            <div>
              <div class="qc__gh-loaderTitle">Verifying connection…</div>
              <div class="qc__gh-loaderSub">Checking GitHub session and project sync</div>
            </div>
          </div>
          <div class="qc__gh-skeleton qc__gh-skel--row"></div>
          <div class="qc__gh-skel--rowGroup">
            <div class="qc__gh-skeleton qc__gh-skel--row" style="width: 60%"></div>
            <div class="qc__gh-skeleton qc__gh-skel--row" style="width: 40%"></div>
          </div>
        </div>
      `);
      return;
    }

    if (this._view === 'unauth') {
      this._renderUnauthView_(body);
      return;
    }

    this._renderConnectedView_(body, footer);
  }


  /**
   * Vista de "no autenticado". Es un flujo en dos pasos:
   *   Step 1 → Conectar Google (necesario para la Apps Script API,
   *            que es lo que vamos a usar como fuente de verdad para
   *            push/pull en lugar de Monaco).
   *   Step 2 → Conectar GitHub (Device Flow).
   * El paso 2 queda visible pero deshabilitado mientras Google esté sin
   * conectar; así el usuario ve la secuencia de un vistazo.
   * @private
   */
  _renderUnauthView_(body) {
    if (this._waitingAuth) {
      const Code = this._deviceCode?.user_code || '••••-••••';
      const url  = this._deviceCode?.verification_uri || 'https://github.com/login/device';
      DomUtils.setHTML(body, `
        <div class="qc__gh-connectCard">
          <div class="qc__gh-connectIcon"><i class="material-icons">hourglass_top</i></div>
          <div class="qc__gh-connectTitle">Waiting for authorization…</div>
          <div class="qc__gh-connectHint">
            A small window opened with GitHub's authorization page.
            If the Code didn't pre-fill, paste it manually:
          </div>
          <div class="qc__gh-codeBox">
            <span class="qc__gh-Code">${this._escape_(Code)}</span>
            <button id="ghCopyCode" class="qc__gh-btn qc__gh-ghost" title="Copy Code">
              <i class="material-icons">content_copy</i>
            </button>
          </div>
          <div class="qc__gh-connectHint" style="margin-top:8px">
            <span class="qc__gh-spinner"></span>
            Authorize the app in GitHub. You'll be signed in automatically here.
          </div>
          <div style="margin-top:10px; display:flex; gap:6px; justify-content:center">
            <button id="ghCancelAuth" class="qc__gh-btn qc__gh-ghost">Cancel</button>
            <button id="ghReopenTab" class="qc__gh-btn qc__gh-ghost">
              <i class="material-icons">open_in_new</i>
              Reopen window
            </button>
          </div>
        </div>
        <div id="ghLog" class="qc__gh-log"></div>
      `);
      body.querySelector('#ghCopyCode')?.addEventListener('click', () => this._copyDeviceCode_());
      body.querySelector('#ghCancelAuth')?.addEventListener('click', () => this._cancelAuth_());
      body.querySelector('#ghReopenTab')?.addEventListener('click', () => {
        if (this._deviceCode?.verification_uri) {
          window.open(this._deviceCode.verification_uri, '_blank',
                      'noopener,popup,width=560,height=720');
        }
      });
      return;
    }

    const googleConnected = !!this._googleUser;
    const googleStepIcon  = googleConnected
      ? `<i class="material-icons" style="color: var(--gc-green-text)">check_circle</i>`
      : `<i class="material-icons">looks_one</i>`;
    const githubStepIcon  = `<i class="material-icons">looks_two</i>`;

    const googleStatus = googleConnected
      ? `Signed in as <strong>${this._escape_(this._googleUser.email || this._googleUser.name || '')}</strong>`
      : 'Required to read and write files in your Apps Script project.';

    const googleBtnLabel = this._googleAuthInFlight
      ? `<span class="qc__gh-spinner ${googleConnected ? '' : 'qc__gh-spinnerOnDark'}"></span> Connecting…`
      : (googleConnected
          ? `<i class="material-icons">refresh</i> Switch account`
          : `<i class="material-icons">login</i> Sign in with Google`);

    const githubDisabled = !googleConnected;

    DomUtils.setHTML(body, `
      <div class="qc__gh-connectCard">
        <div class="qc__gh-connectStep">
          <div class="qc__gh-connectStepIcon">${googleStepIcon}</div>
          <div class="qc__gh-connectStepBody">
            <div class="qc__gh-connectStepTitle">Connect Google</div>
            <div class="qc__gh-connectStepHint">${googleStatus}</div>
            <div class="qc__gh-connectStepActions">
              <button id="ggConnect"
                      class="qc__gh-btn ${googleConnected ? 'qc__gh-ghost' : 'qc__gh-primary'}"
                      ${this._googleAuthInFlight ? 'disabled' : ''}>
                ${googleBtnLabel}
              </button>
              ${googleConnected ? `
                <button id="ggDisconnect" class="qc__gh-btn qc__gh-ghost"
                        title="Disconnect this Google account">
                  <i class="material-icons">logout</i>
                </button>
              ` : ''}
            </div>
          </div>
        </div>

        <div class="qc__gh-connectDivider"></div>

        <div class="qc__gh-connectStep ${githubDisabled ? 'qc__gh-stepDisabled' : ''}">
          <div class="qc__gh-connectStepIcon">${githubStepIcon}</div>
          <div class="qc__gh-connectStepBody">
            <div class="qc__gh-connectStepTitle">Connect GitHub</div>
            <div class="qc__gh-connectStepHint">
              ${githubDisabled
                ? 'Available after connecting Google.'
                : 'A small window will open. Approve the app to finish. Your token never leaves your browser.'}
            </div>
            <div class="qc__gh-connectStepActions">
              <button id="ghConnect" class="qc__gh-btn qc__gh-primary"
                      ${githubDisabled ? 'disabled' : ''}>
                <i class="material-icons">login</i>
                Sign in with GitHub
              </button>
            </div>
          </div>
        </div>
      </div>
      <div id="ghLog" class="qc__gh-log"></div>
    `);
    body.querySelector('#ggConnect')?.addEventListener('click', () => this._authenticateGoogle_());
    body.querySelector('#ggDisconnect')?.addEventListener('click', () => this._logoutGoogle_());
    body.querySelector('#ghConnect')?.addEventListener('click', () => this._authenticate_());
  }


  _renderConnectedView_(body, footer) {
    const project = this._project;
    const selectedRepo = project?.repo || '';
    const selectedBranch = project?.branch || '';
    const basePath = project?.basePath || '';

    // Skeleton durante la primera carga.
    if (this._loadingRepos && !this._reposLoaded) {
      DomUtils.setHTML(body, `
        <div class="qc__gh-grid">
          <div class="qc__gh-col qc__gh-colLeft">
            <div class="qc__gh-sectionHead">
              <span class="qc__gh-sectionTitle">Repository</span>
            </div>
            <div class="qc__gh-skeleton qc__gh-skel--row"></div>
            <div class="qc__gh-skeleton qc__gh-skel--row" style="width:75%"></div>
            <div class="qc__gh-skeleton qc__gh-skel--row" style="width:50%"></div>
          </div>
          <div class="qc__gh-col qc__gh-colRight">
            <div class="qc__gh-skeleton qc__gh-skel--row"></div>
            <div class="qc__gh-skeleton qc__gh-skel--row"></div>
            <div class="qc__gh-skeleton qc__gh-skel--row"></div>
          </div>
        </div>
        <div class="qc__gh-hint" style="margin-top:8px; text-align:center">
          <span class="qc__gh-spinner"></span> Loading your repositories…
        </div>
        <div id="ghLog" class="qc__gh-log"></div>
      `);
      return;
    }

    const repoLabel = selectedRepo
      ? `<i class="material-icons qc__gh-selectorIcon">folder</i>
         <span class="qc__gh-selectorLabel">${this._escape_(selectedRepo)}</span>`
      : `<i class="material-icons qc__gh-selectorIcon">folder_open</i>
         <span class="qc__gh-selectorLabel" style="color: var(--gc-text-faint)">Select repository…</span>`;

    const branchLabel = selectedBranch
      ? `<i class="material-icons qc__gh-selectorIcon">call_split</i>
         <span class="qc__gh-selectorLabel">${this._escape_(selectedBranch)}</span>
         ${this._isDefaultBranch_() ? `<span class="qc__gh-selectorBadge">default</span>` : ''}`
      : `<i class="material-icons qc__gh-selectorIcon">call_split</i>
         <span class="qc__gh-selectorLabel" style="color: var(--gc-text-faint)">Select branch…</span>`;

    // URL "Open on GitHub" que apunta a la branch seleccionada cuando
    // está disponible (lleva al mismo código que se ve localmente).
    let repoUrl = '';
    if (selectedRepo) {
      repoUrl = selectedBranch
        ? `https://github.com/${selectedRepo}/tree/${encodeURIComponent(selectedBranch)}`
        : `https://github.com/${selectedRepo}`;
    }
    const repoUrlEsc = this._escape_(repoUrl);
    const tabActive = this._activeTab;
    const totalChanges = this._diffItems.filter((i) => i.status !== 'eq').length;

    DomUtils.setHTML(body, `
      <div class="qc__gh-grid">
        <div class="qc__gh-col qc__gh-colLeft">
          <div class="qc__gh-sectionHead">
            <span class="qc__gh-sectionTitle">Repository</span>
            <div class="qc__gh-sectionActions">
              <button id="ghReloadRepos" class="qc__gh-iconBtn ${this._loadingRepos ? 'qc__gh-spin' : ''}"
                      title="Reload repositories" ${this._loadingRepos ? 'disabled' : ''}>
                <i class="material-icons">refresh</i>
              </button>
              <button id="ghCreateRepo" class="qc__gh-iconBtn" title="Create new repository">
                <i class="material-icons">add</i>
              </button>
            </div>
          </div>

          <div class="qc__gh-row">
            <div class="qc__gh-selectorWrap">
              <button class="qc__gh-selector" id="ghRepoSelector"
                      aria-expanded="${this._openDropdown === 'repo' ? 'true' : 'false'}">
                ${repoLabel}
                <i class="material-icons qc__gh-selectorChevron">expand_more</i>
              </button>
              ${this._openDropdown === 'repo' ? this._renderRepoDropdown_() : ''}
            </div>
            ${repoUrl ? `
              <a class="qc__gh-hdrAction qc__gh-openExternal" href="${repoUrlEsc}"
                 target="_blank" rel="noopener"
                 title="Open ${this._escape_(selectedRepo)}${selectedBranch ? ` (${this._escape_(selectedBranch)})` : ''} on GitHub">
                <i class="material-icons">open_in_new</i>
              </a>
            ` : `
              <button class="qc__gh-hdrAction qc__gh-openExternal" disabled title="Open on GitHub">
                <i class="material-icons">open_in_new</i>
              </button>
            `}
          </div>

          <div class="qc__gh-field">
            <label class="qc__gh-fieldLabel">Branch</label>
            <div class="qc__gh-selectorWrap">
              <button class="qc__gh-selector" id="ghBranchSelector"
                      aria-expanded="${this._openDropdown === 'branch' ? 'true' : 'false'}"
                      ${selectedRepo ? '' : 'disabled'}>
                ${branchLabel}
                <i class="material-icons qc__gh-selectorChevron">expand_more</i>
              </button>
              ${this._openDropdown === 'branch' ? this._renderBranchDropdown_() : ''}
            </div>
          </div>

          <div class="qc__gh-field">
            <label class="qc__gh-fieldLabel">Subfolder</label>
            <input id="ghBasePath" class="qc__gh-input" type="text"
                   placeholder="src/" value="${this._escape_(basePath)}">
          </div>

          <div class="qc__gh-field qc__gh-grow">
            <label class="qc__gh-fieldLabel">Commit message</label>
            <textarea id="ghCommitMsg" class="qc__gh-input qc__gh-commitArea"
                      placeholder="Describe your changes…">${this._escape_(this._commitMessage)}</textarea>
          </div>
        </div>

        <!-- Columna derecha: tabs Changes / Diff -->
        <div class="qc__gh-col qc__gh-colRight">
          <div class="qc__gh-tabsRow">
            <div class="qc__gh-tabs" role="tablist">
              <button class="qc__gh-tab ${tabActive === 'changes' ? 'qc__gh-activeTab' : ''}"
                      data-tab="changes">
                <i class="material-icons">list_alt</i>
                Changes${totalChanges ? ` (${totalChanges})` : ''}
              </button>
              <button class="qc__gh-tab ${tabActive === 'diff' ? 'qc__gh-activeTab' : ''}"
                      data-tab="diff">
                <i class="material-icons">visibility</i>
                Diff
              </button>
            </div>
            <button id="ghRefreshDiff"
                    class="qc__gh-iconBtn ${this._loadingDiff ? 'qc__gh-spin' : ''}"
                    title="Re-check changes against the repository"
                    ${(!selectedRepo || !selectedBranch || this._loadingDiff) ? 'disabled' : ''}>
              <i class="material-icons">refresh</i>
            </button>
          </div>

          <div id="ghTabBody" class="qc__gh-tabBody"></div>
        </div>
      </div>

      <div id="ghLog" class="qc__gh-log"></div>
    `);

    // Pintar el body de la tab activa.
    this._renderTabBody_();

    // Footer con Pull/Push.
    this._renderFooter_(footer);

    // Listeners.
    body.querySelector('#ghReloadRepos')?.addEventListener('click', () => {
      this._refreshRepos_(true);
    });
    body.querySelector('#ghCreateRepo')?.addEventListener('click', () => this._showCreateRepoPrompt_());
    body.querySelector('#ghRefreshDiff')?.addEventListener('click', () => {
      this._manualRefreshDiff_();
    });
    body.querySelector('#ghRepoSelector')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleDropdown_('repo');
    });
    body.querySelector('#ghBranchSelector')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.currentTarget.disabled) return;
      this._toggleDropdown_('branch');
    });
    body.querySelector('#ghBasePath')?.addEventListener('change', (e) => {
      this._onBasePathChange_(e.target.value);
    });
    body.querySelector('#ghCommitMsg')?.addEventListener('input', (e) => {
      this._commitMessage = e.target.value;
      this._refreshFooterButtons_();
    });
    body.querySelectorAll('.qc__gh-tab').forEach((el) => {
      el.addEventListener('click', () => {
        this._activeTab = el.dataset.tab;
        // Re-render only the tab body; dispose Monaco if leaving the diff tab.
        if (this._activeTab !== 'diff') this._disposeDiffEditor_();
        this._renderConnectedView_(body, footer);
      });
    });

    // Cablear los inputs de búsqueda de los dropdowns.
    this._wireDropdownEvents_();
  }


  /**
   * Abre/cierra un dropdown (`'repo'` o `'branch'`) y limpia el filtro asociado.
   * @param {'repo'|'branch'} which
   * @private
   */
  _toggleDropdown_(which) {
    this._openDropdown = this._openDropdown === which ? '' : which;
    if (this._openDropdown === 'repo') this._repoFilter = '';
    if (this._openDropdown === 'branch') this._branchFilter = '';
    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (body && footer) this._renderConnectedView_(body, footer);
  }

  /** Devuelve el HTML del dropdown de repos (lista + buscador). @private */
  _renderRepoDropdown_() {
    const filter = (this._repoFilter || '').toLowerCase();
    const repos = filter
      ? this._repos.filter((r) => r.full_name.toLowerCase().includes(filter))
      : this._repos;
    const selected = this._project?.repo || '';

    const items = repos.length
      ? repos.map((r) => `
          <div class="qc__gh-ddItem ${r.full_name === selected ? 'qc__gh-active' : ''}"
               data-repo="${this._escape_(r.full_name)}">
            <i class="material-icons">${r.private ? 'lock' : 'folder'}</i>
            <span class="qc__gh-ddItemLabel">${this._escape_(r.full_name)}</span>
            ${r.full_name === selected
              ? `<i class="material-icons qc__gh-ddCheck">check</i>` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">${
          filter
            ? `No matches for "${this._escape_(filter)}"`
            : (this._repos.length ? '' : 'No repositories available')
        }</div>`;

    return `
      <div class="qc__gh-dropdown" data-dd="repo">
        <div class="qc__gh-ddSearch">
          <i class="material-icons">search</i>
          <input id="ghRepoFilterInput" type="text"
                 placeholder="Search repository…"
                 value="${this._escape_(this._repoFilter)}">
        </div>
        <div class="qc__gh-ddList">${items}</div>
      </div>
    `;
  }

  /** Devuelve el HTML del dropdown de branches (lista + buscador + crear). @private */
  _renderBranchDropdown_() {
    const filter = (this._branchFilter || '').toLowerCase();
    const all = this._branches || [];
    const branches = filter
      ? all.filter((b) => b.name.toLowerCase().includes(filter))
      : all;
    const selected = this._project?.branch || '';

    const items = branches.length
      ? branches.map((b) => `
          <div class="qc__gh-ddItem ${b.name === selected ? 'qc__gh-active' : ''}"
               data-branch="${this._escape_(b.name)}">
            <i class="material-icons">call_split</i>
            <span class="qc__gh-ddItemLabel">${this._escape_(b.name)}</span>
            ${b.name === selected
              ? `<i class="material-icons qc__gh-ddCheck">check</i>` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">${
          this._loadingBranches
            ? '<span class="qc__gh-spinner"></span> Loading branches…'
            : 'No branches'
        }</div>`;

    return `
      <div class="qc__gh-dropdown" data-dd="branch">
        <div class="qc__gh-ddSearch">
          <i class="material-icons">search</i>
          <input id="ghBranchFilterInput" type="text"
                 placeholder="Search branch…"
                 value="${this._escape_(this._branchFilter)}">
        </div>
        <div class="qc__gh-ddList">${items}</div>
        <div class="qc__gh-ddFooter">
          <button id="ghCreateBranch" class="qc__gh-ddFooterBtn" type="button">
            <i class="material-icons">add</i>
            Create new branch…
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Cablea los inputs de búsqueda y los items dentro de los dropdowns.
   * Se llama después de cada render del body.
   * @private
   */
  _wireDropdownEvents_() {
    const root = this.shadowRoot;
    const repoInput = root.getElementById('ghRepoFilterInput');
    if (repoInput) {
      // Filtro local: solo refrescamos el dropdown sin perder el foco.
      repoInput.addEventListener('input', (e) => {
        this._repoFilter = e.target.value;
        const dd = this.shadowRoot.querySelector('[data-dd="repo"]');
        if (dd) {
          DomUtils.setHTML(dd.querySelector('.qc__gh-ddList'), this._buildRepoListHtml_());
          this._wireRepoItems_();
        }
      });
      setTimeout(() => repoInput.focus(), 0);
    }
    this._wireRepoItems_();

    const branchInput = root.getElementById('ghBranchFilterInput');
    if (branchInput) {
      branchInput.addEventListener('input', (e) => {
        this._branchFilter = e.target.value;
        const dd = this.shadowRoot.querySelector('[data-dd="branch"]');
        if (dd) {
          DomUtils.setHTML(dd.querySelector('.qc__gh-ddList'), this._buildBranchListHtml_());
          this._wireBranchItems_();
        }
      });
      setTimeout(() => branchInput.focus(), 0);
    }
    this._wireBranchItems_();

    // "Create new branch" button inside the branch dropdown.
    const createBranchBtn = root.getElementById('ghCreateBranch');
    if (createBranchBtn) {
      createBranchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._openDropdown = '';
        this._showCreateBranchPrompt_();
      });
    }
  }

  /** Construye el HTML de la lista de repos filtrada. @private */
  _buildRepoListHtml_() {
    const filter = (this._repoFilter || '').toLowerCase();
    const repos = filter
      ? this._repos.filter((r) => r.full_name.toLowerCase().includes(filter))
      : this._repos;
    const selected = this._project?.repo || '';
    return repos.length
      ? repos.map((r) => `
          <div class="qc__gh-ddItem ${r.full_name === selected ? 'qc__gh-active' : ''}"
               data-repo="${this._escape_(r.full_name)}">
            <i class="material-icons">${r.private ? 'lock' : 'folder'}</i>
            <span class="qc__gh-ddItemLabel">${this._escape_(r.full_name)}</span>
            ${r.full_name === selected
              ? `<i class="material-icons qc__gh-ddCheck">check</i>` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">No matches</div>`;
  }

  /** Construye el HTML de la lista de branches filtrada. @private */
  _buildBranchListHtml_() {
    const filter = (this._branchFilter || '').toLowerCase();
    const all = this._branches || [];
    const branches = filter
      ? all.filter((b) => b.name.toLowerCase().includes(filter))
      : all;
    const selected = this._project?.branch || '';
    return branches.length
      ? branches.map((b) => `
          <div class="qc__gh-ddItem ${b.name === selected ? 'qc__gh-active' : ''}"
               data-branch="${this._escape_(b.name)}">
            <i class="material-icons">call_split</i>
            <span class="qc__gh-ddItemLabel">${this._escape_(b.name)}</span>
            ${b.name === selected
              ? `<i class="material-icons qc__gh-ddCheck">check</i>` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">No matches</div>`;
  }

  /** Cablea los items del dropdown de repos para que disparen el cambio. @private */
  _wireRepoItems_() {
    this.shadowRoot.querySelectorAll('[data-repo]').forEach((el) => {
      el.addEventListener('click', () => this._onRepoChange_(el.dataset.repo));
    });
  }

  /** Cablea los items del dropdown de branches para que disparen el cambio. @private */
  _wireBranchItems_() {
    this.shadowRoot.querySelectorAll('[data-branch]').forEach((el) => {
      el.addEventListener('click', () => this._onBranchChange_(el.dataset.branch));
    });
  }

  /**
   * @returns {boolean} `true` si la branch activa es la default del repo.
   * @private
   */
  _isDefaultBranch_() {
    if (!this._project?.repo || !this._project?.branch) return false;
    const r = this._repos.find((x) => x.full_name === this._project.repo);
    return r?.default_branch === this._project.branch;
  }


  /** Pinta el body de la tab activa (Changes o Diff). @private */
  _renderTabBody_() {
    const wrap = this.shadowRoot.getElementById('ghTabBody');
    if (!wrap) return;

    if (this._activeTab === 'changes') {
      this._renderChangesTab_(wrap);
    } else {
      this._renderDiffTab_(wrap);
    }
  }

  /**
   * Pinta la lista de cambios (archivos modificados/añadidos/borrados)
   * con checkboxes para selección de push.
   * @param {HTMLElement} wrap
   * @private
   */
  _renderChangesTab_(wrap) {
    if (!this._project?.repo || !this._project?.branch) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          Select a repository and branch to see changes.
        </div>
      `);
      return;
    }

    if (this._loadingDiff) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-hint" style="text-align:center; padding:20px">
          <span class="qc__gh-spinner"></span> Comparing with repository…
        </div>
      `);
      return;
    }

    const items = this._diffItems.filter((i) => i.status !== 'eq');
    if (!items.length) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          <i class="material-icons" style="font-size:32px; color: var(--gc-green-text)">check_circle</i>
          <div style="margin-top:8px">No pending changes</div>
        </div>
      `);
      return;
    }

    const total = items.length;
    const selected = this._countSelectedFiles_();
    const allSelected = selected === total;

    DomUtils.setHTML(wrap, `
      <div class="qc__gh-changesCard">
        <div class="qc__gh-changesHead">
          <button class="qc__gh-selectAll ${allSelected ? 'qc__gh-selected' : ''}" id="ghSelectAll">
            <span class="qc__gh-check">
              <i class="material-icons">check</i>
            </span>
            Select all
          </button>
          <span>${selected} of ${total} selected</span>
        </div>
        <div class="qc__gh-changesList">
          ${items.map((it) => this._renderChangeRow_(it)).join('')}
        </div>
      </div>
    `);

    wrap.querySelector('#ghSelectAll')?.addEventListener('click', () => {
      if (allSelected) {
        this._selectedFiles.clear();
      } else {
        items.forEach((i) => this._selectedFiles.add(i.path));
      }
      this._renderTabBody_();
      this._refreshFooterButtons_();
    });

    wrap.querySelectorAll('.qc__gh-changeItem').forEach((el) => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        if (this._selectedFiles.has(path)) this._selectedFiles.delete(path);
        else this._selectedFiles.add(path);
        this._renderTabBody_();
        this._refreshFooterButtons_();
      });
    });
  }

  /**
   * Devuelve el HTML de una fila de la lista de cambios.
   * @param {{path:string,status:string,plus:number,minus:number}} item
   * @returns {string}
   * @private
   */
  _renderChangeRow_(item) {
    const isSelected = this._selectedFiles.has(item.path);
    const lastSlash = item.path.lastIndexOf('/');
    const dir = lastSlash >= 0 ? item.path.slice(0, lastSlash + 1) : '';
    const file = lastSlash >= 0 ? item.path.slice(lastSlash + 1) : item.path;

    const statusChar = { add: '+', del: '−', mod: '~' }[item.status] || '•';
    const delta = item.status === 'mod'
      ? `<span class="qc__gh-changedelta">
           <span class="add">+${item.plus}</span> <span class="del">-${item.minus}</span>
         </span>`
      : '';

    return `
      <div class="qc__gh-changeItem ${isSelected ? 'qc__gh-selected' : ''}" data-path="${this._escape_(item.path)}">
        <span class="qc__gh-check"><i class="material-icons">check</i></span>
        <span class="qc__gh-changeStatus ${item.status}">${statusChar}</span>
        <span class="qc__gh-changePath">
          <span class="qc__gh-changePathDir">${this._escape_(dir)}</span><span class="qc__gh-changePathFile">${this._escape_(file)}</span>
        </span>
        ${delta}
      </div>
    `;
  }

  /**
   * Pinta la pestaña Diff: lista de cards colapsables, una por archivo
   * modificado.
   * @param {HTMLElement} wrap
   * @private
   */
  _renderDiffTab_(wrap) {
    if (!this._project?.repo || !this._project?.branch) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          Select a repository and branch to see the diff.
        </div>
      `);
      return;
    }

    if (this._loadingDiff) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-hint" style="text-align:center; padding:20px">
          <span class="qc__gh-spinner"></span> Loading diff…
        </div>
      `);
      return;
    }

    const items = this._diffItems.filter((i) => i.status !== 'eq');
    if (!items.length) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          <i class="material-icons" style="font-size:32px; color: var(--gc-green-text)">check_circle</i>
          <div style="margin-top:8px">No differences</div>
        </div>
      `);
      return;
    }

    // Por defecto solo el primer archivo se abre.
    if (!this._expandedDiffPaths) this._expandedDiffPaths = new Set([items[0].path]);

    DomUtils.setHTML(wrap, `
      <div class="qc__gh-diffWrap">
        ${items.map((it) => this._renderDiffCard_(it)).join('')}
      </div>
    `);

    // Cablear colapsables y montaje lazy de cada card abierta.
    wrap.querySelectorAll('.qc__gh-diffCard').forEach((card) => {
      const path = card.dataset.path;
      const item = items.find((i) => i.path === path);
      const head = card.querySelector('.qc__gh-diffCardHead');
      const body = card.querySelector('.qc__gh-diffCardBody');

      head.addEventListener('click', () => {
        if (this._expandedDiffPaths.has(path)) {
          this._expandedDiffPaths.delete(path);
        } else {
          this._expandedDiffPaths.add(path);
        }
        const isOpen = this._expandedDiffPaths.has(path);
        card.classList.toggle('qc__gh-diffCardOpen', isOpen);
        if (isOpen) {
          this._renderDiffInto_(body, item);
        } else {
          DomUtils.setHTML(body, '');
        }
      });

      // Mount diff for cards that start expanded.
      if (this._expandedDiffPaths.has(path)) {
        card.classList.add('qc__gh-diffCardOpen');
        requestAnimationFrame(() => this._renderDiffInto_(body, item));
      }
    });
  }

  /**
   * Renderiza el HTML de una card colapsable de archivo en la pestaña Diff.
   * Incluye un badge de origen ("GitHub → GAS", "GAS only", "GitHub only")
   * a la derecha del path para que el usuario sepa de un vistazo qué lado
   * del diff es local y cuál remoto.
   * @param {{path:string,status:string,plus:number,minus:number}} item
   * @returns {string}
   * @private
   */
  _renderDiffCard_(item) {
    const isOpen = this._expandedDiffPaths?.has(item.path);
    const statusChar = { add: '+', del: '−', mod: '~' }[item.status] || '•';
    const delta = item.status === 'mod'
      ? `<span class="qc__gh-changeDelta">
           <span class="add">+${item.plus}</span> <span class="del">-${item.minus}</span>
         </span>`
      : '';
    const origin = this._renderDiffOriginBadge_(item.status);
    return `
      <div class="qc__gh-diffCard ${isOpen ? 'qc__gh-diffCardOpen' : ''}"
           data-path="${this._escape_(item.path)}">
        <button class="qc__gh-diffCardHead" type="button">
          <i class="material-icons qc__gh-diffCardChevron">chevron_right</i>
          <span class="qc__gh-changeStatus ${item.status}">${statusChar}</span>
          <span class="qc__gh-diffCardPath">${this._escape_(item.path)}</span>
          ${origin}
          ${delta}
        </button>
        <div class="qc__gh-diffCardBody"></div>
      </div>
    `;
  }

  /**
   * Devuelve el badge compacto que indica de qué lado proviene el cambio.
   * Convención: rojo = GitHub (remoto), verde = GAS (local).
   *   - 'add': solo existe local.
   *   - 'del': solo existe remoto.
   *   - 'mod': comparación bilateral, leyenda dirigida (GitHub → GAS).
   * @param {string} status
   * @returns {string}
   * @private
   */
  _renderDiffOriginBadge_(status) {
    if (status === 'add') {
      return `
        <span class="qc__gh-diffOrigin add"
              title="Only exists locally in GAS. Push will create it on GitHub.">
          <i class="material-icons">add</i>GAS only
        </span>
      `;
    }
    if (status === 'del') {
      return `
        <span class="qc__gh-diffOrigin del"
              title="Only exists on GitHub. Push will delete it from the repo.">
          <i class="material-icons">remove</i>GitHub only
        </span>
      `;
    }
    return `
      <span class="qc__gh-diffOrigin mod"
            title="Red lines (−) are on GitHub, green lines (+) are local in GAS.">
        GitHub <i class="material-icons">arrow_forward</i> GAS
      </span>
    `;
  }

  /**
   * Pinta el diff de un archivo dentro del elemento dado. Usa Diff2HtmlUI
   * cuando está disponible y cae a un fallback HTML LCS si falta la lib.
   *
   * El diff se construye con `oldText = remote` y `newText = local`, así
   * que las líneas en rojo (-) son lo que está en GitHub y las verdes (+)
   * son lo que está en Monaco. El header de la card (ver
   * `_renderDiffCard_`) muestra un badge "GitHub → GAS" para reforzar
   * esta convención sin agregar ruido al body.
   *
   * @param {HTMLElement} mount
   * @param {{path:string,status:string,local:string,remote:string}} item
   * @private
   */
  _renderDiffInto_(mount, item) {
    if (!mount || !item) return;

    if (window.Diff?.createPatch && window.Diff2HtmlUI) {
      try {
        this._ensureDiff2HtmlStyles_();

        const oldText = item.remote || '';
        const newText = item.local || '';
        const patch = window.Diff.createPatch(item.path, oldText, newText, 'remote', 'local');

        mount.classList.remove('qc__gh-diffEditor', 'qc__gh-diffFallback');
        mount.classList.add('qc__gh-diff2html');
        DomUtils.setHTML(mount, '');

        const ui = new window.Diff2HtmlUI(mount, patch, {
          drawFileList:           false,
          fileListToggle:         false,
          fileListStartVisible:   false,
          matching:               'lines',
          outputFormat:           'line-by-line',
          renderNothingWhenEmpty: false,
          highlight:              true,
          synchronisedScroll:     true,
        });
        ui.draw();
        try { ui.highlightCode?.(); } catch (_) { /* highlight is optional */ }
        return;
      } catch (err) {
        console.warn('[gas-github-panel] Diff2Html failed for', item.path, err);
      }
    }

    // Fallback: minimal HTML LCS.
    mount.classList.remove('qc__gh-diff2html', 'qc__gh-diffEditor');
    mount.classList.add('qc__gh-diffFallback');
    const lines = this._buildLineDiff_(item.remote || '', item.local || '');
    DomUtils.setHTML(mount, lines.length
      ? lines.map((l) => `<div class="qc__gh-diffLine ${l.t}">${this._escape_(l.s)}</div>`).join('')
      : `<div class="qc__gh-diffEmpty">No differences in this file.</div>`);
  }


  /** Pinta el footer (Pull/Push) según el estado actual. @private */
  _renderFooter_(footer) {
    const project = this._project;
    const enabled = !!(project?.repo && project?.branch);
    const selectedCount = this._countSelectedFiles_();
    const hasMessage = (this._commitMessage || '').trim().length > 0;
    const busy = this._pushing || this._pulling;
    const pullRequired = this._remoteHasChanges && !this._loadingDiff;
    const canPush = enabled && selectedCount > 0 && hasMessage && !busy && !pullRequired;
    const canPull = enabled && !busy;

    const pullLabel = this._pulling
      ? `<span class="qc__gh-spinner qc__gh-spinnerOnDark"></span> Pulling…`
      : `<i class="material-icons">cloud_download</i> Pull`;

    const pushLabel = this._pushing
      ? `<span class="qc__gh-spinner qc__gh-spinnerOnDark"></span> Pushing…`
      : `<i class="material-icons">cloud_upload</i> Push${selectedCount ? ` (${selectedCount})` : ''}`;

    let hint = '';
    if (this._pushing)           hint = 'Sending changes to GitHub…';
    else if (this._pulling)      hint = 'Fetching changes from GitHub…';
    else if (!enabled)           hint = 'Select repo and branch';
    else if (pullRequired)       hint = '⚠️ Pull remote changes before pushing to avoid conflicts';
    else if (selectedCount === 0) hint = 'Select files to push';

    DomUtils.setHTML(footer, `
      ${pullRequired ? `
        <div class="qc__gh-pullWarning">
          <i class="material-icons">warning</i>
          <span>The remote has changes. <strong>Pull first</strong> to avoid conflicts.</span>
        </div>
      ` : ''}
      <div class="qc__gh-footerRow">
        <button id="ghPull" class="qc__gh-btn ${pullRequired ? 'qc__gh-primary' : 'qc__gh-ghost'}" ${canPull ? '' : 'disabled'}>
          ${pullLabel}
        </button>
        <button id="ghPush" class="qc__gh-btn qc__gh-primary" ${canPush ? '' : 'disabled'}>
          ${pushLabel}
        </button>
      </div>
      <div class="qc__gh-footerHint" id="ghFooterHint">${hint}</div>
    `);
    footer.style.display = 'block';

    footer.querySelector('#ghPull')?.addEventListener('click', () => this._pull_());
    footer.querySelector('#ghPush')?.addEventListener('click', () => this._push_());
  }

  /** Re-renderiza el footer si está visible (para reflejar cambios de estado). @private */
  _refreshFooterButtons_() {
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (footer && footer.style.display !== 'none') this._renderFooter_(footer);
  }

  /**
   * @returns {number} Cantidad de archivos modificados seleccionados para push.
   * @private
   */
  _countSelectedFiles_() {
    const items = this._diffItems.filter((i) => i.status !== 'eq');
    let count = 0;
    for (const it of items) if (this._selectedFiles.has(it.path)) count++;
    return count;
  }


  /**
   * Acción del botón "refresh" de la columna de tabs: el usuario fuerza
   * una nueva validación contra el repositorio sin cerrar ni reabrir el
   * panel. Refresca la lista de branches por si aparecieron nuevas en
   * remoto y recomputa el diff. El guardado de Monaco lo dispara
   * `_fetchProjectFromApi_` cuando hace falta.
   * @private
   */
  async _manualRefreshDiff_() {
    if (this._loadingDiff) return;
    if (!this._project?.repo || !this._project?.branch) return;

    this._loadBranches_(this._project.repo);
    await this._recomputeDiff_();
  }

  /**
   * Compara los archivos del proyecto GAS con el repo remoto y produce
   * `_diffItems`. Normaliza saltos de línea y newline final para evitar
   * falsos cambios entre LF y CRLF.
   * @private
   */
  async _recomputeDiff_() {
    if (!this._project?.repo || !this._project?.branch) {
      this._diffItems = [];
      this._selectedFiles.clear();
      this._renderTabBody_();
      this._refreshFooterButtons_();
      return;
    }

    this._loadingDiff = true;
    this._renderTabBody_();
    this._refreshFooterButtons_();

    const res = await this._ghApi_('FETCH_FILES', {
      repo:     this._project.repo,
      branch:   this._project.branch,
      basePath: this._project.basePath || '',
    });

    this._loadingDiff = false;

    if (!res?.ok) {
      if (await this._handleAuthError_(res)) return;
      this._log_(res?.error || 'Could not load remote repository', 'error');
      this._diffItems = [];
      this._renderTabBody_();
      this._refreshFooterButtons_();
      return;
    }

    const norm = (s) => {
      // Normalize line endings + strip a single trailing newline so that
      // CRLF vs LF or "newline at end of file" differences don't show
      // up as fake modifications.
      return String(s ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    };

    const remote = new Map(
      (res.data?.files || [])
        .filter((f) => this._isSyncablePath_(f.path))
        .map((f) => [f.path, norm(f.content)])
    );

    // Si tenemos un snapshot post-push vigente para este repo+branch+base,
    // sobreponemos el contenido recién pusheado sobre lo que devolvió el
    // remoto. Cubre la latencia del CDN de GitHub (1-3 s) que devolvería
    // el árbol viejo y haría reaparecer los archivos como "modificados".
    const snap = this._postPushSnapshot;
    if (snap
        && Date.now() < snap.expiresAt
        && snap.repo     === this._project.repo
        && snap.branch   === this._project.branch
        && (snap.basePath || '') === (this._project.basePath || '')) {
      for (const [path, content] of snap.files) {
        remote.set(path, content);
      }
    } else if (snap && Date.now() >= snap.expiresAt) {
      // El TTL caducó: descartamos el snapshot.
      this._postPushSnapshot = null;
    }
    const local  = new Map(
      (await this._collectLocalFiles_()).map((f) => [f.path, norm(f.content)])
    );

    const allPaths = new Set([...remote.keys(), ...local.keys()]);
    const items = [];
    for (const path of [...allPaths].sort()) {
      const localContent  = local.get(path);
      const remoteContent = remote.get(path);
      let status, plus = 0, minus = 0;
      if (remoteContent == null)       status = 'add';   // solo local
      else if (localContent == null)   status = 'del';   // solo remoto
      else if (localContent === remoteContent) status = 'eq';
      else {
        status = 'mod';
        const diff = this._countLinedelta_(remoteContent, localContent);
        plus = diff.plus; minus = diff.minus;
      }
      items.push({
        path, status,
        local:  localContent ?? '',
        remote: remoteContent ?? '',
        plus, minus,
        // 'del' significa que el archivo existe en remoto pero no local → necesita pull
        // 'mod' puede ir en cualquier dirección, pero si remote ≠ local y no fue pusheado
        // por nosotros, asumimos que el remoto tiene cambios que debemos traer primero.
        needsPull: status === 'del' || status === 'mod',
      });
    }

    this._diffItems = items;

    // By default select every changed file (skip 'eq').
    this._selectedFiles = new Set(items.filter((i) => i.status !== 'eq').map((i) => i.path));
    this._activeDiffPath = null;
    // Mantener abiertas solo las cards cuyos paths sigan existiendo.
    if (this._expandedDiffPaths) {
      const valid = new Set(items.map((i) => i.path));
      this._expandedDiffPaths = new Set(
        [...this._expandedDiffPaths].filter((p) => valid.has(p))
      );
    }

    // ¿Algún archivo del remoto tiene cambios que no están en local?
    // Si hay archivos 'del' (solo en remoto) o 'mod' cuyo contenido remoto
    // difiere del local, el usuario debe hacer pull antes de push.
    this._remoteHasChanges = this._diffItems.some(
      (i) => i.status === 'del' || i.status === 'mod'
    );

    this._renderTabBody_();
    this._refreshFooterButtons_();
    // Actualizar el contador de la pestaña con el conteo de cambios.
    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (body && footer) {
      // Re-render para que el (n) en la tab refleje los Changes.
      this._renderConnectedView_(body, footer);
    }
  }

  /**
   * Quita los párrafos JSDoc previos al método (eran ingleses) y
   * reemplaza por una versión española corta.
   */

  /**
   * Cuenta líneas añadidas/quitadas usando LCS. Para archivos muy grandes
   * (>4000 líneas) cae a una aproximación basada en `Set` para no
   * bloquear el hilo principal.
   * @param {string} remote
   * @param {string} local
   * @returns {{plus:number, minus:number}}
   * @private
   */
  _countLinedelta_(remote, local) {
    const a = (remote || '').split('\n');
    const b = (local || '').split('\n');
    const m = a.length, n = b.length;
    if (!m && !n) return { plus: 0, minus: 0 };
    // LCS limitado para no bloquear con archivos enormes.
    if (m > 4000 || n > 4000) {
      // Aproximación: contar líneas distintas por simple match.
      const set = new Set(a);
      let plus = 0, minus = 0;
      for (const line of b) if (!set.has(line)) plus++;
      const set2 = new Set(b);
      for (const line of a) if (!set2.has(line)) minus++;
      return { plus, minus };
    }
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
                                  : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0, plus = 0, minus = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { minus++; i++; }
      else { plus++; j++; }
    }
    minus += m - i;
    plus  += n - j;
    return { plus, minus };
  }

  /**
   * Indica si un path está soportado para sincronización (push/pull/diff).
   * Solo incluimos extensiones que GAS exporta nativamente.
   * @param {string} path
   * @returns {boolean}
   * @private
   */
  _isSyncablePath_(path) {
    return /\.(gs|html|json)$/i.test(String(path || ''));
  }

  /**
   * Devuelve los archivos del proyecto GAS leídos desde la Apps Script
   * API (fuente de verdad). El panel solo entra a la vista 'connected'
   * cuando hay sesión Google activa, así que la API siempre debería
   * estar disponible aquí. Si falla devuelve `[]` y el caller decide
   * cómo seguir (toast/error ya se mostró en `_fetchProjectFromApi_`).
   *
   * @returns {Promise<Array<{path:string, content:string, name:string, type:string}>>}
   * @private
   */
  async _collectLocalFiles_() {
    const apiFiles = await this._fetchProjectFromApi_();
    if (!apiFiles) return [];
    return apiFiles
      .filter((f) => this._isSyncablePath_(f.path))
      .map((f) => ({
        path:    f.path,
        content: f.source || '',
        name:    f.name,
        type:    f.type,
      }));
  }

  /**
   * Lee el contenido completo del proyecto GAS usando la Apps Script API
   * (GET /v1/projects/{scriptId}/content). Es la fuente de verdad para
   * push/pull porque ve TODOS los archivos del proyecto, no solo los que
   * el usuario tiene abiertos en Monaco.
   *
   * Antes de pedir el GET dispara Ctrl+S para que GAS persista los
   * cambios sin guardar y la API devuelva el snapshot al día. El delay
   * es necesario porque el guardado es asíncrono y la API lee del
   * storage interno de GAS, no de Monaco.
   *
   * @returns {Promise<Array<{path:string,content:string,name:string,type:string}>|null>}
   *   `null` si no hay sesión Google activa o falla la llamada (el
   *   caller decide si caer al fallback de Monaco).
   * @private
   */
  async _fetchProjectFromApi_() {
    if (!this._googleUser || !this._scriptId) return null;

    // Forzamos save antes de leer; le damos tiempo a GAS para persistir
    // (300 ms suele ser suficiente; nunca menos porque GAS deduplica
    // saves seguidos).
    this._triggerGasSave_();
    await new Promise((r) => setTimeout(r, 350));

    const res = await this._ggApi_('GET_CONTENT', { scriptId: this._scriptId });
    if (!res?.ok || !res.data) {
      const msg = String(res?.error || '');
      // 401/403: la sesión Google se invalidó. Limpiamos el estado para
      // que el panel pida re-conectar.
      if (/\b(401|403)\b/.test(msg)) {
        this._googleUser = null;
        this._view = 'unauth';
        this._renderHeader_();
        this._renderBody_();
        this._toast_('Google session expired. Please sign in again.', 'error', 5000);
      } else if (msg) {
        this._log_(msg, 'error');
      }
      return null;
    }
    return res.data.files || [];
  }

  /**
   * Escribe el contenido completo del proyecto GAS usando la Apps Script
   * API (PUT /v1/projects/{scriptId}/content). Reemplaza el set de
   * archivos: lo que NO va en `files` se borra, lo que va se crea o se
   * actualiza, todo en una sola operación atómica.
   *
   * @param {Array<{name:string, type:string, source:string}>} files
   * @returns {Promise<boolean>} true si la escritura fue exitosa.
   * @private
   */
  async _pushProjectToApi_(files) {
    if (!this._googleUser) return false;
    if (!this._scriptId)   return false;
    if (!Array.isArray(files)) return false;

    const res = await this._ggApi_('PUT_CONTENT', { scriptId: this._scriptId, files });
    if (!res?.ok) {
      const msg = String(res?.error || 'Could not write project content');
      if (/\b(401|403)\b/.test(msg)) {
        this._googleUser = null;
        this._toast_('Google session expired. Please sign in again.', 'error', 5000);
      } else {
        this._toast_(msg, 'error', 6000);
      }
      return false;
    }
    return true;
  }

  /**
   * Mapea una extensión de archivo a un type aceptado por la Apps
   * Script API. El JSON solo se reserva para `appsscript.json` para
   * evitar enviar tipos no soportados.
   * @param {string} path
   * @returns {('SERVER_JS'|'HTML'|'JSON'|null)}
   * @private
   */
  _pathToScriptType_(path) {
    const lower = String(path || '').toLowerCase();
    if (lower.endsWith('.gs') || lower.endsWith('.js')) return 'SERVER_JS';
    if (lower.endsWith('.html')) return 'HTML';
    if (lower.endsWith('.json')) return 'JSON';
    return null;
  }

  /**
   * Convierte un path tipo "Code.gs" / "appsscript.json" / "Sidebar.html"
   * en el `name` que la API espera (sin extensión).
   * @param {string} path
   * @returns {string}
   * @private
   */
  _pathToScriptName_(path) {
    return String(path || '').replace(/\.(gs|js|html|json)$/i, '');
  }


  /**
   * Inyecta el CSS de diff2html dentro del shadow root una sola vez,
   * bajo demanda. Los stylesheets globales no aplican al Shadow DOM.
   * @private
   */
  async _ensureDiff2HtmlStyles_() {
    if (this.shadowRoot.getElementById('ghDiff2HtmlStyles')) return;
    try {
      const url = chrome.runtime.getURL('src/vendor/diff2html/diff2html.min.css');
      const css = await fetch(url).then((r) => r.text());
      const style = document.createElement('style');
      style.id = 'ghDiff2HtmlStyles';
      style.textContent = css;
      this.shadowRoot.appendChild(style);
    } catch (err) {
      console.warn('[gas-github-panel] Could not load diff2html.css:', err);
    }
  }

  /** Libera modelos efímeros del diff de Monaco para evitar memory leaks. @private */
  _disposeDiffEditor_() {
    try { this._diffEditor?.dispose?.(); } catch (_) {}
    try { this._diffOriginalModel?.dispose?.(); } catch (_) {}
    try { this._diffModifiedModel?.dispose?.(); } catch (_) {}
    this._diffEditor = null;
    this._diffOriginalModel = null;
    this._diffModifiedModel = null;
  }

  /**
   * Adivina el lenguaje Monaco a partir de la extensión del archivo.
   * @param {string} path
   * @returns {string}
   * @private
   */
  _guessLang_(path) {
    const lower = (path || '').toLowerCase();
    if (lower.endsWith('.gs') || lower.endsWith('.js')) return 'javascript';
    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'typescript';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.html')) return 'html';
    if (lower.endsWith('.css')) return 'css';
    if (lower.endsWith('.md')) return 'markdown';
    return 'plaintext';
  }

  /**
   * Genera un diff línea-a-línea (`+`/`-`/`=`) usando LCS limitado.
   * Fallback usado cuando diff2html no está disponible.
   * @param {string} aText
   * @param {string} bText
   * @returns {Array<{t:'add'|'del'|'eq', s:string}>}
   * @private
   */
  _buildLineDiff_(aText, bText) {
    const MAX = 4000;
    const a = (aText || '').split('\n').slice(0, MAX);
    const b = (bText || '').split('\n').slice(0, MAX);
    if (!a.length && !b.length) return [];

    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
                                  : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { ops.push({ t: 'eq', s: '  ' + a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: 'del', s: '- ' + a[i] }); i++; }
      else { ops.push({ t: 'add', s: '+ ' + b[j] }); j++; }
    }
    while (i < m) ops.push({ t: 'del', s: '- ' + a[i++] });
    while (j < n) ops.push({ t: 'add', s: '+ ' + b[j++] });
    if (ops.every((o) => o.t === 'eq')) return [];
    return ops;
  }


  /**
   * Inicia el Device Flow vía background:
   *   1. POST /login/device/code
   *   2. Abre `github.com/login/device` en una pestaña popup
   *   3. Empuja el `user_code` al panel
   *   4. Polling al endpoint de token hasta éxito/error/expiración
   * El panel solo espera `GAS_GH_AUTH_DONE` como resultado final.
   * @private
   */
  async _authenticate_() {
    this._waitingAuth = true;
    this._deviceCode  = null;
    this._renderBody_();
    this._toast_('Opening GitHub authorization window…', 'info', 2000);

    const res = await this._bridgeCall_('GAS_GH_AUTHENTICATE');
    this._waitingAuth = false;
    this._deviceCode  = null;

    if (res?.ok) {
      this._user = res.user;
      this._view = 'connected';
      this._toast_(`Connected as @${res.user.login}`, 'ok');
      this._renderHeader_();
      this._renderBody_();
      this._loadProjectConfig_();
      this._refreshRepos_(true);
      this._updateAnchorBadge_();
    } else {
      this._renderBody_();
      this._toast_(res?.error || 'Authentication failed', 'error', 5000);
    }
  }

  /** Cancela el Device Flow en curso. @private */
  async _cancelAuth_() {
    await this._bridgeCall_('GAS_GH_CANCEL_AUTH');
    this._waitingAuth = false;
    this._deviceCode = null;
    this._renderBody_();
  }

  /** Copia el `user_code` del Device Flow al portapapeles. @private */
  async _copyDeviceCode_() {
    if (!this._deviceCode?.user_code) return;
    try {
      await navigator.clipboard.writeText(this._deviceCode.user_code);
      this._toast_('Code copied to clipboard', 'ok');
    } catch (_) {
      this._toast_('Could not copy code', 'error');
    }
  }

  /**
   * Recibe el push del background con el `user_code` mientras esperamos
   * la autorización y refresca la vista para mostrarlo.
   * @param {CustomEvent} e
   * @private
   */
  _onDeviceCodePush_(e) {
    let payload;
    try { payload = JSON.parse(e.detail); } catch (_) { return; }
    if (!payload) return;
    this._deviceCode = payload;
    if (this._waitingAuth) this._renderBody_();
  }

  /**
   * Cierra ambas sesiones (Google + GitHub) tras una sola confirmación.
   * Razón: la API de Apps Script y la de GitHub funcionan en tándem en
   * este panel; mantener una sola conexión activa lleva a estados raros
   * (por ejemplo "puedo leer GAS pero no comparar contra el repo"). El
   * usuario puede volver a conectar cualquiera de las dos desde la
   * pantalla unauth.
   * @private
   */
  async _logoutAll_() {
    const hasGoogle = !!this._googleUser;
    const hasGithub = !!this._user;

    const confirmed = await this._showConfirm_({
      title:        'Sign out?',
      message:      hasGoogle && hasGithub
        ? 'Disconnect both your GitHub and Google accounts from this browser. ' +
          'You can reconnect either from the panel.'
        : (hasGithub
            ? 'The GitHub token will be removed from this browser.'
            : 'The Google account will be disconnected from this browser.'),
      confirmLabel: 'Sign out',
      tone:         'danger',
    });
    if (!confirmed) return;

    // Lanzamos ambos logouts en paralelo: son idempotentes y no dependen
    // entre sí.
    const tasks = [];
    if (hasGithub) tasks.push(this._bridgeCall_('GAS_GH_LOGOUT'));
    if (hasGoogle) tasks.push(this._bridgeCall_('GAS_GG_LOGOUT'));
    await Promise.all(tasks);

    this._user = null;
    this._googleUser = null;
    this._view = 'unauth';
    this._repos = [];
    this._reposLoaded = false;
    this._branches = [];
    this._diffItems = [];
    this._selectedFiles.clear();
    this._renderHeader_();
    this._renderBody_();
    this._updateAnchorBadge_();
    this._positionPanel_();
  }

  /**
   * Lanza el flujo interactivo de Google OAuth (chrome.identity.getAuthToken
   * con `interactive: true`). El primer login muestra el consent screen
   * de Google con los scopes solicitados; los siguientes son transparentes
   * mientras el consent siga vigente.
   * @private
   */
  async _authenticateGoogle_() {
    if (this._googleAuthInFlight) return;
    this._googleAuthInFlight = true;
    this._renderBody_();
    this._toast_('Opening Google sign-in…', 'info', 1800);

    const res = await this._bridgeCall_('GAS_GG_AUTHENTICATE');
    this._googleAuthInFlight = false;

    if (res?.ok && res.user) {
      this._googleUser = res.user;
      this._toast_(`Connected as ${res.user.email || res.user.name || 'Google account'}`, 'ok');
      // Si el usuario vino aquí desde Step 1, dejamos visible Step 2 con
      // el botón de GitHub habilitado; si ya tenía GitHub conectado, el
      // refresh asciende a 'connected'.
      this._refreshAuth_();
    } else {
      this._renderBody_();
      const msg = res?.error || 'Could not connect to Google.';
      // Mensaje específico cuando la extensión no fue empaquetada con un
      // OAuth client_id válido (manifest.oauth2.client_id placeholder).
      if (/OAuth2 not granted|client_id|invalid_client/i.test(msg)) {
        this._toast_(
          'Google sign-in not configured. Set manifest.oauth2.client_id ' +
          'and reload the extension.',
          'error', 7000,
        );
      } else {
        this._toast_(msg, 'error', 5000);
      }
    }
  }

  /**
   * Cierra la sesión de Google: pide confirmación, llama al background
   * para limpiar el token cacheado, e invalida la vista (vuelve a Step 1
   * porque GitHub depende de Google para tener una fuente de verdad).
   * @private
   */
  async _logoutGoogle_() {
    const confirmed = await this._showConfirm_({
      title:        'Disconnect Google?',
      message:      'GitHub sync will be paused until you reconnect a Google ' +
                    'account. Your GitHub session is not affected.',
      confirmLabel: 'Disconnect',
      tone:         'danger',
    });
    if (!confirmed) return;

    await this._bridgeCall_('GAS_GG_LOGOUT');
    this._googleUser = null;
    // Sin Google no podemos quedarnos en 'connected': forzamos unauth.
    this._view = 'unauth';
    this._renderHeader_();
    this._renderBody_();
    this._updateAnchorBadge_();
    this._positionPanel_();
  }

  /** Carga inicial silenciosa para que el botón muestre el badge. */
  /**
   * Verificación silenciosa al montar el componente: si hay token válido
   * pinta el dot verde en el botón sin abrir el panel; si está revocado
   * lo limpia del storage.
   * @private
   */
  async _initBadgeFromAuth_() {
    this._scriptId = this._extractScriptId_();
    const auth = await this._bridgeCall_('GAS_GH_GET_AUTH');
    if (!auth?.token || !auth?.user) {
      this._user = null;
      this._updateAnchorBadge_();
      return;
    }
    const ping = await this._ghApi_('GET_USER', {});
    if (ping?.ok && ping.data) {
      this._user = ping.data;
      if (this._scriptId) {
        const cfg = await this._bridgeCall_('GAS_GH_GET_PROJECT', { scriptId: this._scriptId });
        this._project = cfg && typeof cfg === 'object' ? cfg : null;
      }
    } else if (ping && !ping.ok && /\b(401|403|Bad credentials)\b/i.test(String(ping.error || ''))) {
      await this._bridgeCall_('GAS_GH_LOGOUT');
      this._user = null;
      this._project = null;
    } else {
      this._user = auth.user;
    }
    this._updateAnchorBadge_();
  }


  /**
   * Maneja el cambio de repo en el dropdown. Persiste la selección,
   * carga las branches y dispara el cómputo de diff.
   * @param {string} fullName  `owner/repo` o cadena vacía para limpiar.
   * @private
   */
  async _onRepoChange_(fullName) {
    if (!fullName) {
      this._project = null;
      this._branches = [];
      this._diffItems = [];
      this._selectedFiles.clear();
      this._openDropdown = '';
      await this._saveProjectConfig_(null);
      this._updateAnchorBadge_();
      const body = this.shadowRoot.getElementById('ghBody');
      const footer = this.shadowRoot.getElementById('ghFooter');
      if (body && footer) this._renderConnectedView_(body, footer);
      return;
    }

    const repo = this._repos.find((r) => r.full_name === fullName);
    const branch = repo?.default_branch || 'main';
    this._project = {
      repo:     fullName,
      branch,
      basePath: this._project?.basePath || '',
    };
    await this._saveProjectConfig_(this._project);
    this._branches = [];
    this._openDropdown = '';
    this._diffItems = [];
    this._selectedFiles.clear();
    this._updateAnchorBadge_();

    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (body && footer) this._renderConnectedView_(body, footer);

    this._loadBranches_(fullName);
    this._recomputeDiff_();
  }

  /**
   * Maneja el cambio de branch. Persiste la selección y recalcula diff.
   * @param {string} branchName
   * @private
   */
  async _onBranchChange_(branchName) {
    if (!this._project) return;
    this._project = { ...this._project, branch: branchName };
    this._openDropdown = '';
    await this._saveProjectConfig_(this._project);
    this._updateAnchorBadge_();

    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (body && footer) this._renderConnectedView_(body, footer);

    this._recomputeDiff_();
  }

  /**
   * Maneja el cambio de sub-folder dentro del repo.
   * @param {string} value
   * @private
   */
  async _onBasePathChange_(value) {
    if (!this._project) return;
    this._project = { ...this._project, basePath: (value || '').trim() };
    await this._saveProjectConfig_(this._project);
    this._recomputeDiff_();
  }

  /**
   * Persiste el binding del scriptId actual con la config de proyecto.
   * @param {{repo:string,branch:string,basePath:string}|null} config
   * @private
   */
  async _saveProjectConfig_(config) {
    if (!this._scriptId) return;
    await this._bridgeCall_('GAS_GH_SAVE_PROJECT', {
      scriptId: this._scriptId, config,
    });
  }

  /**
   * Abre el modal "Crear branch" y, si el usuario confirma, crea la
   * branch en GitHub y la activa.
   * @private
   */
  async _showCreateBranchPrompt_() {
    if (!this._project?.repo) return;

    const result = await this._openCreateBranchModal_();
    if (!result) return;

    this._toast_(`Creating branch ${result.name}…`, 'info', 1800);
    const res = await this._ghApi_('CREATE_BRANCH', {
      repo:       this._project.repo,
      name:       result.name,
      fromBranch: result.fromBranch,
    });

    if (res?.ok) {
      this._toast_(`Branch "${result.name}" created`, 'ok');
      // Insertar local para que aparezca al instante y cambiar a ella.
      this._branches = [{ name: result.name, commitSha: res.data?.commitSha || '' }, ...this._branches];
      await this._onBranchChange_(result.name);
    } else if (await this._handleAuthError_(res)) {
      return;
    } else {
      this._toast_(res?.error || 'Could not create branch', 'error', 5000);
    }
  }

  /**
   * Pinta el modal de creación de branch en el shadow root y resuelve
   * con `{name, fromBranch}` o `null` si el usuario cancela.
   * @returns {Promise<{name:string, fromBranch:string}|null>}
   * @private
   */
  _openCreateBranchModal_() {
    const branches = this._branches || [];
    const currentBranch = this._project?.branch || branches[0]?.name || '';

    const branchOptions = branches.map((b) => `
      <option value="${this._escape_(b.name)}" ${b.name === currentBranch ? 'selected' : ''}>
        ${this._escape_(b.name)}
      </option>
    `).join('') || `<option value="${this._escape_(currentBranch)}" selected>${this._escape_(currentBranch)}</option>`;

    const html = `
      <div class="qc__gh-modal" role="dialog" aria-label="New branch">
        <div class="qc__gh-modalTitle">New branch</div>

        <label class="qc__gh-fieldLabel" for="ghNewBranchName">Branch name</label>
        <input id="ghNewBranchName" class="qc__gh-input" type="text"
               placeholder="feature/awesome" autocomplete="off">

        <label class="qc__gh-fieldLabel" for="ghNewBranchFrom" style="margin-top:6px">
          Based on
        </label>
        <select id="ghNewBranchFrom" class="qc__gh-modalSelect">${branchOptions}</select>

        <div class="qc__gh-modalFooter">
          <button class="qc__gh-btn qc__gh-ghost" id="ghNewBranchCancel">Cancel</button>
          <button class="qc__gh-btn qc__gh-primary" id="ghNewBranchCreate" disabled>Create</button>
        </div>
      </div>
    `;

    return this._openModal_(html, (overlay, finish) => {
      const input  = overlay.querySelector('#ghNewBranchName');
      const from   = overlay.querySelector('#ghNewBranchFrom');
      const create = overlay.querySelector('#ghNewBranchCreate');
      const cancel = overlay.querySelector('#ghNewBranchCancel');

      // GitHub branch name rules: no spaces, no '..', no leading '-', etc.
      // We use a tolerant subset that catches the obvious mistakes.
      const validName = (v) => {
        const t = v.trim();
        return /^[A-Za-z0-9._\-/]+$/.test(t)
          && t.length > 0 && t.length <= 240
          && !t.startsWith('-') && !t.startsWith('/')
          && !t.endsWith('/') && !t.includes('..')
          && !this._branches.some((b) => b.name === t);
      };

      input.addEventListener('input', () => {
        create.disabled = !validName(input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && validName(input.value)) {
          e.preventDefault();
          create.click();
        }
        if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
      });
      cancel.addEventListener('click', () => finish(null));
      create.addEventListener('click', () => {
        finish({ name: input.value.trim(), fromBranch: from.value });
      });

      setTimeout(() => input.focus(), 30);
    });
  }

  /**
   * Abre el modal "Crear repositorio" y crea el repo si el usuario
   * confirma. Tras crearlo lo selecciona como activo.
   * @private
   */
  async _showCreateRepoPrompt_() {
    // Modal interno (los prompt/confirm nativos pueden estar bloqueados
    // por la página de GAS).
    const result = await this._openCreateRepoModal_();
    if (!result) return;

    const { name, isPrivate } = result;
    this._toast_(`Creating ${name}…`, 'info', 1800);
    const res = await this._ghApi_('CREATE_REPO', { name, isPrivate });
    if (res?.ok) {
      this._toast_(`Repository created: ${res.data.full_name}`, 'ok');
      this._repos = [{ ...res.data, private: isPrivate }, ...this._repos];
      this._reposLoaded = true;
      await this._onRepoChange_(res.data.full_name);
    } else if (await this._handleAuthError_(res)) {
      return;
    } else {
      this._toast_(res?.error || 'Could not create repository', 'error', 5000);
    }
  }

  /**
   * Abre un mini modal en el shadow DOM para capturar Name + visibilidad.
   * @returns {Promise<{name:string, isPrivate:boolean}|null>}
   * @private
   */
  /**
   * Pinta el modal de creación de repositorio. Resuelve con
   * `{name, isPrivate}` o `null` si se cancela.
   * @returns {Promise<{name:string, isPrivate:boolean}|null>}
   * @private
   */
  _openCreateRepoModal_() {
    const html = `
      <div class="qc__gh-modal" role="dialog" aria-label="New repository">
        <div class="qc__gh-modalTitle">New repository</div>

        <label class="qc__gh-fieldLabel" for="ghNewRepoName">Name</label>
        <input id="ghNewRepoName" class="qc__gh-input" type="text"
               placeholder="my-project" autocomplete="off">

        <div class="qc__gh-radioRow">
          <label class="qc__gh-radio">
            <input type="radio" name="ghVisibility" value="private" checked>
            <span class="qc__gh-radioCircle"></span>
            <span>
              <strong>Private</strong>
              <span class="qc__gh-radioHint">Only you can see it</span>
            </span>
          </label>
          <label class="qc__gh-radio">
            <input type="radio" name="ghVisibility" value="public">
            <span class="qc__gh-radioCircle"></span>
            <span>
              <strong>Public</strong>
              <span class="qc__gh-radioHint">Anyone can see it</span>
            </span>
          </label>
        </div>

        <div class="qc__gh-modalFooter">
          <button class="qc__gh-btn qc__gh-ghost" id="ghNewRepoCancel">Cancel</button>
          <button class="qc__gh-btn qc__gh-primary" id="ghNewRepoCreate" disabled>
            Create
          </button>
        </div>
      </div>
    `;

    return this._openModal_(html, (overlay, finish) => {
      const input  = overlay.querySelector('#ghNewRepoName');
      const create = overlay.querySelector('#ghNewRepoCreate');
      const cancel = overlay.querySelector('#ghNewRepoCancel');

      // Validación simple: GitHub permite letras, números, ., -, _.
      const validName = (v) => /^[A-Za-z0-9._-]+$/.test(v.trim()) && v.trim().length <= 100;

      input.addEventListener('input', () => {
        create.disabled = !validName(input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && validName(input.value)) {
          e.preventDefault();
          create.click();
        }
        if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
      });
      cancel.addEventListener('click', () => finish(null));
      create.addEventListener('click', () => {
        const isPrivate = overlay.querySelector('input[name="ghVisibility"]:checked').value === 'private';
        finish({ name: input.value.trim(), isPrivate });
      });

      setTimeout(() => input.focus(), 30);
    });
  }

  /**
   * Modal genérico de confirmación dentro del shadow root del panel.
   * Sustituye al `window.confirm` nativo (la página de GAS lo bloquea
   * en algunos casos).
   *
   * @param {{
   *   title:string,
   *   message:string,
   *   confirmLabel?:string,
   *   cancelLabel?:string,
   *   tone?:'primary'|'danger'
   * }} opts
   * @returns {Promise<boolean>}
   * @private
   */
  _showConfirm_(opts) {
    const tone = opts.tone === 'danger' ? 'qc__gh-danger' : 'qc__gh-primary';
    const cLabel = opts.confirmLabel || 'Confirm';
    const xLabel = opts.cancelLabel  || 'Cancel';

    const html = `
      <div class="qc__gh-modal" role="dialog" aria-label="${this._escape_(opts.title)}">
        <div class="qc__gh-modalTitle">${this._escape_(opts.title)}</div>
        <div class="qc__gh-modalTextWrap">
          <div class="qc__gh-modalText">${this._escape_(opts.message).replace(/\n/g, '<br>')}</div>
        </div>
        <div class="qc__gh-modalFooter">
          <button class="qc__gh-btn qc__gh-ghost" id="ghConfirmCancel">${this._escape_(xLabel)}</button>
          <button class="qc__gh-btn ${tone}" id="ghConfirmOk">${this._escape_(cLabel)}</button>
        </div>
      </div>
    `;

    return this._openModal_(html, (overlay, finish) => {
      const ok     = overlay.querySelector('#ghConfirmOk');
      const cancel = overlay.querySelector('#ghConfirmCancel');

      ok.addEventListener('click', () => finish(true));
      cancel.addEventListener('click', () => finish(false));

      const onKey = (e) => {
        if (e.key === 'Enter')   { e.preventDefault(); finish(true); }
        if (e.key === 'Escape')  { e.preventDefault(); finish(false); }
      };
      overlay.addEventListener('keydown', onKey);
      setTimeout(() => ok.focus(), 30);
    }, false);
  }

  /**
   * Modal especializado del pull: muestra solo los archivos que se van
   * a traer (status 'mod' y 'del'), con un badge `add`/`mod` y el delta
   * `+x -y` cuando aplica. El usuario puede optar por no recargar la
   * pestaña tras aplicar (por defecto sí, porque GAS solo refleja los
   * cambios tras un reload).
   *
   * @param {{
   *   files: Array<{path:string,status:'add'|'del'|'mod',plus?:number,minus?:number}>,
   *   reloadAvailable: boolean,
   *   localOnlyCount: number,
   * }} opts
   * @returns {Promise<{confirmed:boolean, reload:boolean}>}
   * @private
   */
  _showPullConfirm_(opts) {
    // Solo dibujamos los archivos que efectivamente entran (mod/del).
    // Los 'add' (locales) se mencionan en el footer como aclaración
    // pero no contaminan la lista visual.
    const incoming = opts.files.filter((f) => f.status === 'mod' || f.status === 'del');
    const incomingByKind = {
      add: incoming.filter((f) => f.status === 'del').length,  // 'del'=remoto-only=nuevo en GAS
      mod: incoming.filter((f) => f.status === 'mod').length,
    };

    const summaryParts = [];
    if (incomingByKind.add) summaryParts.push(`<span class="qc__gh-pullSummaryCount">${incomingByKind.add} new</span>`);
    if (incomingByKind.mod) summaryParts.push(`<span class="qc__gh-pullSummaryCount">${incomingByKind.mod} modified</span>`);
    const summaryText = summaryParts.length
      ? summaryParts.join(' · ')
      : '<span class="qc__gh-pullSummaryCount">Nothing to apply</span>';

    const itemsHtml = incoming.length
      ? incoming.map((f) => {
          const kindClass = f.status === 'del' ? 'add' : 'mod';
          const kindChar  = f.status === 'del' ? '+' : '~';
          const delta = f.status === 'mod'
            ? `<span class="qc__gh-pullDelta">
                 <span class="add">+${f.plus || 0}</span>
                 <span class="del">-${f.minus || 0}</span>
               </span>`
            : '';
          return `
            <div class="qc__gh-pullItem">
              <span class="qc__gh-pullStatus ${kindClass}">${kindChar}</span>
              <span class="qc__gh-pullPath">${this._escape_(f.path)}</span>
              ${delta}
            </div>
          `;
        }).join('')
      : `<div class="qc__gh-pullItem"><span class="qc__gh-pullPath" style="color: var(--gc-text-faint)">No incoming changes.</span></div>`;

    const localOnlyHint = opts.localOnlyCount
      ? `
        <div class="qc__gh-pullNote" style="margin-top:0">
          <strong>${opts.localOnlyCount} local-only file(s)</strong> will be
          ignored — they are not in the repo, push them separately if needed.
        </div>
      `
      : '';

    const reloadCheck = opts.reloadAvailable
      ? `
        <label class="qc__gh-pullCheckRow">
          <input id="ghPullReload" type="checkbox" checked>
          Reload this GAS tab after applying so the editor shows the new content.
        </label>
      `
      : '';

    const html = `
      <div class="qc__gh-modal" role="dialog" aria-label="Pull from repository"
           style="max-width: 460px">
        <div class="qc__gh-modalTitle">Pull from repository</div>

        <div class="qc__gh-modalTextWrap">
          <div class="qc__gh-pullSummary">
            <i class="material-icons">cloud_download</i>
            <span>${summaryText} from <strong>${this._escape_((this._project?.repo || '') + '@' + (this._project?.branch || ''))}</strong></span>
          </div>

          <div class="qc__gh-pullList">${itemsHtml}</div>

          ${localOnlyHint}
          ${reloadCheck}
        </div>

        <div class="qc__gh-modalFooter">
          <button class="qc__gh-btn qc__gh-ghost" id="ghConfirmCancel">Cancel</button>
          <button class="qc__gh-btn qc__gh-primary" id="ghConfirmOk"
                  ${incoming.length ? '' : 'disabled'}>
            Apply changes
          </button>
        </div>
      </div>
    `;

    // Cancel resuelve con `{confirmed:false, reload:false}` (no `null`).
    const cancelValue = { confirmed: false, reload: false };

    return this._openModal_(html, (overlay, finish) => {
      const ok     = overlay.querySelector('#ghConfirmOk');
      const cancel = overlay.querySelector('#ghConfirmCancel');
      const reload = overlay.querySelector('#ghPullReload');

      const finalize = (confirmed) => {
        finish({
          confirmed,
          reload: confirmed && opts.reloadAvailable && (reload?.checked ?? false),
        });
      };

      ok.addEventListener('click', () => finalize(true));
      cancel.addEventListener('click', () => finalize(false));
      const onKey = (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); if (!ok.disabled) finalize(true); }
        if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
      };
      overlay.addEventListener('keydown', onKey);
      setTimeout(() => ok.focus(), 30);
    }, cancelValue);
  }


  /**
   * Sube los archivos seleccionados al repo activo. Antes de leer el
   * snapshot del proyecto vía Apps Script API, fuerza Ctrl+S sobre el
   * editor de GAS para que cualquier cambio sin guardar quede
   * persistido (la API lee del storage interno de GAS, no de Monaco).
   * Al terminar OK limpia selección + commit + diff.
   * @private
   */
  async _push_() {
    if (!this._project || this._pushing || this._pulling) return;

    const message = (this._commitMessage || '').trim();
    if (!message) return this._toast_('Write a commit message', 'error');
    if (!this._selectedFiles.size) return this._toast_('No files selected', 'error');

    this._pushing = true;
    this._refreshFooterButtons_();
    this._setBodyBusy_(true);
    this._toast_('Saving GAS and preparing push…', 'info', 1800);

    // 1. Forzamos save en GAS y esperamos a que persista. Esto es
    //    crítico porque la API lee del storage de GAS, no de Monaco:
    //    sin este paso un push podría subir el contenido viejo de un
    //    archivo que el usuario acaba de editar pero todavía no guardó.
    //    `_fetchProjectFromApi_` también dispara Ctrl+S internamente,
    //    pero lo hacemos aquí explícito (con más tiempo de espera) para
    //    cubrir saves más lentos en archivos grandes.
    this._triggerGasSave_();
    await new Promise((r) => setTimeout(r, 600));

    // 2. Leemos el snapshot real del proyecto.
    const apiFiles = await this._fetchProjectFromApi_();
    if (!apiFiles) {
      this._pushing = false;
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
      // El error ya se mostró en _fetchProjectFromApi_.
      return;
    }

    const selectedFiles = apiFiles.filter((f) => this._selectedFiles.has(f.path));
    if (!selectedFiles.length) {
      this._pushing = false;
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
      return this._toast_('No files selected', 'error');
    }

    this._toast_(
      `Pushing ${selectedFiles.length} file(s) to ${this._project.repo}@${this._project.branch}…`,
      'info', 2400,
    );

    let res;
    try {
      res = await this._ghApi_('PUSH_FILES', {
        repo:     this._project.repo,
        branch:   this._project.branch,
        basePath: this._project.basePath || '',
        files:    selectedFiles.map((f) => ({
          path:    f.path,
          // Normalize line endings + trailing newline to match the
          // diff comparison so a fresh push leaves everything 'eq'.
          content: String(f.source ?? '').replace(/\r\n?/g, '\n').replace(/\n?$/, '\n'),
        })),
        message,
      });
    } finally {
      this._pushing = false;
    }

    if (res?.ok) {
      const sha = (res.data?.commitSha || '').slice(0, 7);

      // Optimistic update + snapshot: GitHub propaga el commit al CDN
      // con 1-3 s de latencia. Si el usuario cierra y reabre el panel
      // en ese intervalo, FETCH_FILES devuelve el árbol viejo y la UI
      // vuelve a mostrar archivos pendientes. Para evitarlo guardamos
      // un snapshot con TTL: durante los primeros 15 s post-push,
      // `_recomputeDiff_` superpone el contenido pusheado sobre la
      // respuesta remota.
      const norm = (s) => String(s ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n$/, '');
      const pushedByPath = new Map(
        selectedFiles.map((f) => [f.path, norm(f.source)])
      );

      this._postPushSnapshot = {
        expiresAt: Date.now() + 15000,
        repo:      this._project.repo,
        branch:    this._project.branch,
        basePath:  this._project.basePath || '',
        files:     pushedByPath,
      };

      this._diffItems = this._diffItems.map((it) => {
        if (!pushedByPath.has(it.path)) return it;
        const next = pushedByPath.get(it.path);
        return {
          ...it,
          status: 'eq',
          local:  next,
          remote: next,
          plus:   0,
          minus:  0,
        };
      });

      this._commitMessage = '';
      this._selectedFiles.clear();
      this._expandedDiffPaths = null;
      this._activeTab = 'changes';

      const body = this.shadowRoot.getElementById('ghBody');
      const footer = this.shadowRoot.getElementById('ghFooter');
      if (body && footer) this._renderConnectedView_(body, footer);

      this._setBodyBusy_(false);
      this._toast_(`Push successful · commit ${sha}`, 'ok');
    } else if (await this._handleAuthError_(res)) {
      this._setBodyBusy_(false);
    } else {
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
      this._toast_(res?.error || 'Push failed', 'error', 5000);
    }
  }

  /**
   * Aplica/quita un overlay traslúcido sobre el body para bloquear
   * interacciones mientras un push/pull está en vuelo.
   * @param {boolean} busy
   * @private
   */
  _setBodyBusy_(busy) {
    const body = this.shadowRoot.getElementById('ghBody');
    if (!body) return;
    body.classList.toggle('qc__gh-busy', !!busy);
  }

  /**
   * Aplica los cambios remotos sobre los modelos de Monaco. Le pide al
   * usuario que guarde con Ctrl+S al terminar (GAS no expone API pública
   * para guardar desde aquí).
   * @private
   */
  /**
   * Aplica los cambios del repo remoto sobre el proyecto GAS usando la
   * Apps Script API. Crea los archivos nuevos, sobrescribe los
   * modificados y conserva intactos los locales que no estén en el repo.
   * Por defecto recarga la pestaña al terminar para que el editor de GAS
   * muestre el contenido nuevo (la API edita el storage, Monaco solo lo
   * relee tras un reload).
   * @private
   */
  async _pull_() {
    if (!this._project || this._pushing || this._pulling) return;

    // Asegurar diff al día antes de pedir confirmación.
    if (!this._diffItems.length) {
      await this._recomputeDiff_();
    }
    const items = this._diffItems.filter((i) => i.status !== 'eq');
    if (!items.length) return this._toast_('Everything is up to date', 'ok');

    // Clasificación: 'mod' se sobrescribe, 'del' se crea, 'add' se ignora
    // (los locales que no están en el repo no los tocamos en pull).
    const remoteOnly  = items.filter((i) => i.status === 'del');
    const toOverwrite = items.filter((i) => i.status === 'mod');
    const localOnly   = items.filter((i) => i.status === 'add');

    if (!toOverwrite.length && !remoteOnly.length) {
      this._toast_('All changes are local only. Use Push instead.', 'info', 4000);
      return;
    }

    const pullResult = await this._showPullConfirm_({
      files:           items,
      reloadAvailable: true,
      localOnlyCount:  localOnly.length,
    });
    if (!pullResult.confirmed) return;

    this._pulling = true;
    this._refreshFooterButtons_();
    this._setBodyBusy_(true);
    this._toast_('Applying remote changes…', 'info', 1800);

    try {
      const { applied, skipped } = await this._pullWithApi_(items);

      this._selectedFiles.clear();
      this._commitMessage = '';
      this._expandedDiffPaths = null;

      // Si vamos a recargar la pestaña, no recomputamos diff (la página
      // se va a tirar abajo en un instante).
      if (!pullResult.reload) {
        await this._recomputeDiff_();
      }
      this._remoteHasChanges = false;

      if (applied) {
        if (pullResult.reload) {
          this._toast_(
            `${applied} file(s) applied. Reloading GAS…`,
            'ok', 1500,
          );
          setTimeout(() => {
            try { window.top.location.reload(); }
            catch (_) { window.location.reload(); }
          }, 800);
          return;
        }
        this._toast_(
          `${applied} file(s) applied via Apps Script API. ` +
          `Reload GAS to see them in the editor.`,
          'ok', 6000,
        );
      } else if (skipped.length) {
        this._toast_(
          `${skipped.length} file(s) skipped (local only — use Push for these).`,
          'info', 5000,
        );
      }
    } finally {
      this._pulling = false;
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
    }
  }

  /**
   * Aplica el pull sobre el proyecto GAS usando la Apps Script API.
   * Construye el set final de archivos (snapshot del proyecto + cambios
   * remotos a aplicar) y lo envía con un solo PUT atómico que crea,
   * actualiza y conserva en una sola operación.
   *
   * Garantías:
   *   1. Solo se modifican los archivos del diff. Los demás se incluyen
   *      en el PUT con su contenido actual leído desde la API, así que
   *      GAS los conserva exactos.
   *   2. Los archivos `add` (locales que no están en el repo) se
   *      preservan y NO se borran. Pull no decide eso, push sí.
   *   3. Si la lectura previa del proyecto falla, abortamos para no
   *      escribir un set incompleto.
   *
   * @param {Array} items  Items del diff (sin 'eq').
   * @returns {Promise<{applied:number, skipped:string[]}>}
   * @private
   */
  async _pullWithApi_(items) {
    const localFiles = await this._fetchProjectFromApi_();
    if (!localFiles) {
      return { applied: 0, skipped: items.map((i) => i.path) };
    }

    // Mapa con TODO lo que hoy está en el proyecto. Los cambios del
    // pull se aplican sobre esta copia.
    const byPath = new Map(localFiles.map((f) => [f.path, { ...f }]));
    const skipped = [];
    let applied = 0;

    for (const it of items) {
      if (it.status === 'add') {
        // Archivo solo local: pull no lo toca.
        skipped.push(it.path);
        continue;
      }

      const type = this._pathToScriptType_(it.path);
      const name = this._pathToScriptName_(it.path);
      if (!type || !name) {
        skipped.push(it.path);
        continue;
      }

      // 'mod' → reemplazamos el contenido por el remoto.
      // 'del' → archivo solo en remoto: lo creamos en el set final.
      byPath.set(it.path, {
        path:    it.path,
        name,
        type,
        source:  it.remote || '',
      });
      applied++;
    }

    if (!applied) {
      return { applied: 0, skipped };
    }

    const finalFiles = [...byPath.values()].map((f) => ({
      name:   f.name || this._pathToScriptName_(f.path),
      type:   f.type || this._pathToScriptType_(f.path),
      source: f.source ?? '',
    }));

    // Sanity check: si por algún bug el array final tiene menos archivos
    // que los que había antes, abortamos para no perder código.
    if (finalFiles.length < localFiles.length) {
      this._toast_(
        'Aborted: internal mismatch while building the file set. ' +
        'Nothing was written.',
        'error', 6000,
      );
      console.warn('[gas-github-panel] _pullWithApi_ abort: finalFiles<localFiles',
        { final: finalFiles.length, local: localFiles.length });
      return { applied: 0, skipped: items.map((i) => i.path) };
    }

    const ok = await this._pushProjectToApi_(finalFiles);
    if (!ok) {
      return { applied: 0, skipped: items.map((i) => i.path) };
    }
    return { applied, skipped };
  }


  /**
   * Despacha un CustomEvent al bridge y resuelve cuando llega el
   * resultado correspondiente. Timeout configurable: la mayoría de
   * llamadas usa 30 s, pero las de autenticación interactiva (Device
   * Flow de GitHub, consent de Google) pueden tardar varios minutos
   * mientras el usuario completa la autorización en otra ventana.
   *
   * @param {string} eventName
   * @param {object} [payload]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<*>}
   * @private
   */
  /**
   * Atajo para invocar la API de GitHub a través del bridge. Centraliza
   * el patrón `_bridgeCall_('GAS_GH_API_CALL', { action, payload })` que
   * se repite en todas las operaciones contra el background.
   *
   * @param {string} action - Acción reconocida por el background (ej. 'LIST_REPOS').
   * @param {object} [payload] - Argumentos específicos de la acción.
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean, data?:*, error?:string}>}
   * @private
   */
  _ghApi_(action, payload = {}, opts = {}) {
    return this._bridgeCall_('GAS_GH_API_CALL', { action, payload }, opts);
  }

  /**
   * Atajo equivalente para la API de Google (Apps Script API + userinfo).
   * @param {string} action
   * @param {object} [payload]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean, data?:*, error?:string}>}
   * @private
   */
  _ggApi_(action, payload = {}, opts = {}) {
    return this._bridgeCall_('GAS_GG_API_CALL', { action, payload }, opts);
  }

  _bridgeCall_(eventName, payload = {}, opts = {}) {
    return new Promise((resolve) => {
      const requestId = `gh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this._pendingBridgeCalls.set(requestId, resolve);

      // Llamadas de autenticación interactiva quedan a la espera del
      // usuario (puede tardar varios minutos). Para no abandonarlas con
      // un timeout corto, les damos 16 min — un poco más que la ventana
      // de 15 min que GitHub deja al Device Flow.
      const interactive = (
        eventName === 'GAS_GH_AUTHENTICATE' ||
        eventName === 'GAS_GG_AUTHENTICATE'
      );
      const ms = opts.timeoutMs ?? (interactive ? 16 * 60 * 1000 : 30000);

      setTimeout(() => {
        if (this._pendingBridgeCalls.has(requestId)) {
          this._pendingBridgeCalls.delete(requestId);
          resolve({ ok: false, error: 'Timeout' });
        }
      }, ms);
      document.dispatchEvent(new CustomEvent(eventName, {
        detail: JSON.stringify({ requestId, ...payload }),
      }));
    });
  }

  /**
   * Listener único de los eventos `GAS_GH_*_RESULT|DONE` del bridge.
   * Resuelve la promesa pendiente cuyo `requestId` coincida.
   * @param {CustomEvent} e
   * @private
   */
  _onBridgeResult(e) {
    let payload;
    try { payload = JSON.parse(e.detail); } catch (_) { return; }
    const { requestId } = payload || {};
    const resolver = this._pendingBridgeCalls.get(requestId);
    if (!resolver) return;
    this._pendingBridgeCalls.delete(requestId);

    if ('ok' in payload) {
      const { requestId: _, ...rest } = payload;
      resolver(rest);
    } else if ('data' in payload) {
      resolver(payload.data);
    } else {
      resolver(payload);
    }
  }


  /**
   * Sincroniza el indicador visual de TODOS los botones GitHub de la
   * toolbar:
   *   - Punto verde superpuesto cuando hay sesión activa.
   *   - Tooltip nativo con el repo conectado (si existe).
   * @private
   */
  _updateAnchorBadge_() {
    const buttons = document.querySelectorAll('#rsBtnGithubGas');
    if (!buttons.length) return;
    const isConnected = !!this._user;
    const repo = this._project?.repo || '';
    const branch = this._project?.branch || '';
    const tooltip = isConnected
      ? (repo ? `GitHub · ${repo}${branch ? ` (${branch})` : ''}` : 'GitHub · Connected')
      : 'GitHub sync';

    buttons.forEach((btn) => {
      btn.setAttribute('aria-label', tooltip);
      btn.setAttribute('title', tooltip);
      const wrapper = btn.closest('.RO63ad');
      if (wrapper) wrapper.setAttribute('data-tt', tooltip);

      let dot = btn.querySelector('.qc__gh-dot');
      if (isConnected && !dot) {
        dot = document.createElement('span');
        dot.className = 'qc__gh-dot';
        dot.style.cssText = [
          'position:absolute','top:6px','right:6px',
          'width:8px','height:8px','border-radius:999px',
          'background:#34a853','box-shadow:0 0 0 2px #fff',
          'pointer-events:none','z-index:1',
        ].join(';');
        if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
        btn.appendChild(dot);
      } else if (!isConnected && dot) {
        dot.remove();
      }
    });
  }


  /**
   * Extrae el `scriptId` del proyecto GAS desde la URL actual.
   * @returns {string} `''` si no se puede determinar.
   * @private
   */
  _extractScriptId_() {
    const m = location.pathname.match(/\/home\/projects\/([^/]+)/)
         || location.pathname.match(/\/d\/([^/]+)/);
    return m ? m[1] : '';
  }

  /**
   * Muestra un mensaje persistente en el log inferior del panel.
   * Usado para errores/estados que conviene que el usuario vea aunque
   * cambie de pestaña (los toasts desaparecen solos).
   * @param {string} text
   * @param {'ok'|'error'} [kind]
   * @private
   */
  _log_(text, kind) {
    const log = this.shadowRoot.getElementById('ghLog');
    if (!log) return;
    log.classList.toggle('qc__gh-error', kind === 'error');
    log.classList.toggle('qc__gh-ok',    kind === 'ok');
    log.classList.add('qc__gh-visible');
    log.textContent = text;
  }

  /**
   * Muestra un toast flotante en la parte superior del panel.
   * Pensado para mensajes efímeros (info / éxito / advertencia / error)
   * que no necesitan permanecer en pantalla.
   *
   * @param {string} text   Texto del mensaje.
   * @param {'ok'|'error'|'info'} [kind='info']  Variante visual.
   * @param {number} [duration=3200]  Tiempo en ms antes de auto-cerrar.
   * @private
   */
  _toast_(text, kind = 'info', duration = 3200) {
    const stack = this._ensureToastStack_();
    const toast = document.createElement('div');
    toast.className = `qc__gh-toast qc__gh-toast--${kind}`;
    const icon = kind === 'ok'    ? 'check_circle'
              : kind === 'error' ? 'error'
                                 : 'info';
    DomUtils.setHTML(toast, `
      <i class="material-icons qc__gh-toastIcon">${icon}</i>
      <span class="qc__gh-toastText">${this._escape_(text)}</span>
      <button class="qc__gh-toastClose" type="button" aria-label="Dismiss">
        <i class="material-icons">close</i>
      </button>
    `);
    stack.appendChild(toast);

    // Animación de entrada en el siguiente frame.
    requestAnimationFrame(() => toast.classList.add('qc__gh-toastShown'));

    const dismiss = () => {
      if (!toast.parentNode) return;
      toast.classList.remove('qc__gh-toastShown');
      // Esperamos a la transición antes de remover.
      setTimeout(() => toast.remove(), 180);
    };
    toast.querySelector('.qc__gh-toastClose').addEventListener('click', dismiss);
    if (duration > 0) setTimeout(dismiss, duration);
  }

  /**
   * Asegura que exista un contenedor (stack) de toasts dentro del shell
   * y lo devuelve. Idempotente.
   * @returns {HTMLElement}
   * @private
   */
  _ensureToastStack_() {
    let stack = this.shadowRoot.getElementById('ghToastStack');
    if (stack) return stack;
    stack = document.createElement('div');
    stack.id = 'ghToastStack';
    stack.className = 'qc__gh-toastStack';
    this.shadowRoot.querySelector('.qc__gh-shell').appendChild(stack);
    return stack;
  }

  /**
   * Escapa caracteres HTML básicos para evitar inyección al renderizar
   * texto de origen externo (p. ej. nombres de repos).
   * @param {*} s
   * @returns {string}
   * @private
   */
  _escape_(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Crea un overlay modal dentro del shadow root del panel y lo inserta
   * en `.qc__gh-shell`. Centraliza el patrón compartido por
   * `_openCreateBranchModal_`, `_openCreateRepoModal_`, `_showConfirm_`
   * y `_showPullConfirm_`: limpiar overlay anterior, crear el contenedor,
   * inyectar HTML y registrar los listeners de cierre por click fuera.
   *
   * El callback `onMount(overlay, finish)` recibe el overlay ya montado
   * y un helper `finish(value)` que lo desmonta y resuelve la promesa.
   * El consumidor se encarga de cablear botones y atajos de teclado.
   *
   * @param {string}   html        - Contenido HTML del overlay (incluye `.qc__gh-modal`).
   * @param {Function} onMount     - `(overlay, finish) => void`. Cablea los listeners.
   * @param {*}        [cancelValue=null] - Valor con el que se resuelve si se cancela
   *                                         haciendo click fuera del modal.
   * @returns {Promise<*>} Lo que `finish(value)` reciba.
   * @private
   */
  _openModal_(html, onMount, cancelValue = null) {
    return new Promise((resolve) => {
      // Si quedó un overlay previo, lo desmontamos antes de pintar el nuevo.
      this.shadowRoot.querySelector('.qc__gh-modalOverlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'qc__gh-modalOverlay';
      DomUtils.setHTML(overlay, html);
      this.shadowRoot.querySelector('.qc__gh-shell').appendChild(overlay);

      const finish = (value) => { overlay.remove(); resolve(value); };

      // Click fuera del modal = cancelar (los modales no son modales 100%
      // bloqueantes; se descartan con click en el backdrop).
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(cancelValue);
      });

      onMount(overlay, finish);
    });
  }


  /**
   * Posiciona el panel anclado al botón y calcula el offset de la flecha
   * para que apunte al centro del ancla.
   * @private
   */
  _positionPanel_() {
    if (!this._anchorEl) return;
    const rect = this._anchorEl.getBoundingClientRect();
    const w = this.offsetWidth || 720;
    const margin = 14;
    let left = rect.right - w;
    if (left < margin) left = margin;
    if (left + w + margin > window.innerWidth) left = window.innerWidth - w - margin;
    this.style.left = `${left}px`;
    this.style.top  = `${rect.bottom + 10}px`;
    this.style.right = 'auto';

    // Point the arrow to the center of the anchor button.
    const anchorCenter = rect.left + rect.width / 2;
    const arrowOffset = Math.max(
      14,
      Math.min(w - 14, left + w - anchorCenter - 8)
    );
    this.style.setProperty('--qc-gh-arrow-offset', `${arrowOffset}px`);
  }

  /**
   * Cierra el panel al hacer click fuera. Si hay un dropdown abierto,
   * solo cierra el dropdown sin tumbar el panel.
   * @param {MouseEvent} e
   * @private
   */
  _onDocumentMouseDown(e) {
    if (this.style.display !== 'block') return;
    const path = e.composedPath?.() || [];

    // Si hay un dropdown abierto y el click cae fuera de él (pero dentro
    // del shell), cerramos solo el dropdown y dejamos el panel abierto.
    if (this._openDropdown) {
      const dd = this.shadowRoot.querySelector('.qc__gh-dropdown');
      const trigger = this.shadowRoot.querySelector(
        this._openDropdown === 'repo' ? '#ghRepoSelector' : '#ghBranchSelector'
      );
      if (dd && !path.includes(dd) && !path.includes(trigger)) {
        this._openDropdown = '';
        const body = this.shadowRoot.getElementById('ghBody');
        const footer = this.shadowRoot.getElementById('ghFooter');
        if (body && footer) this._renderConnectedView_(body, footer);
        return;
      }
    }

    if (path.includes(this)) return;
    if (this._anchorEl && path.includes(this._anchorEl)) return;
    this.close();
  }

  /**
   * Cierra el dropdown abierto o el panel completo con Esc.
   * @param {KeyboardEvent} e
   * @private
   */
  _onWindowKeyDown(e) {
    if (e.key !== 'Escape' || this.style.display !== 'block') return;
    if (this._openDropdown) {
      this._openDropdown = '';
      const body = this.shadowRoot.getElementById('ghBody');
      const footer = this.shadowRoot.getElementById('ghFooter');
      if (body && footer) this._renderConnectedView_(body, footer);
      return;
    }
    this.close();
  }

  /** Reposiciona el panel cuando cambia el tamaño de la ventana. @private */
  _onWindowResize() {
    if (this.style.display === 'block') this._positionPanel_();
  }
}

if (!customElements.get('gas-github-panel')) {
  customElements.define('gas-github-panel', GasGithubPanel);
}
