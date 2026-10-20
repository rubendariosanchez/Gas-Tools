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

  /** Selector del botón ancla (la toolbar puede reinyectarse). */
  static ANCHOR_SELECTOR = '#rsBtnGithubGas';

  /** Id del `<style>` del badge de conexión (light DOM de la toolbar). */
  static BADGE_STYLE_ID = 'qc__gh-badge-style';

  /** CSS del badge de conexión: anillo con la superficie del tema. */
  static BADGE_CSS = `
    .qc__gh-dot {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 1;
      width: 8px;
      height: 8px;
      border-radius: var(--gt-shape-full);
      background: var(--gt-success);
      box-shadow: 0 0 0 2px var(--gt-surface);
      pointer-events: none;
    }
  `;

  /** Eventos de respuesta del bridge que escucha `_onBridgeResult`. */
  static BRIDGE_RESULT_EVENTS = Object.freeze([
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
  ]);

  /**
   * Inicializa el estado interno del panel y los binds estables de los
   * listeners globales. No toca el DOM aquí; el shell se renderiza en
   * `connectedCallback`.
   */
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    /** @type {object|null} Editor Monaco activo. */
    this._editor = null;
    /** @type {HTMLElement|null} Botón ancla del popover. */
    this._anchorEl = null;
    /** @type {'loading'|'unauth'|'connected'} */
    this._view = 'loading';
    /** @type {{login:string,name:string|null,avatar_url:string,html_url:string}|null} */
    this._user = null;
    /** @type {{email:string,name:string|null,picture:string|null}|null} Perfil Google. */
    this._googleUser = null;
    /** @type {boolean} */
    this._googleAuthInFlight = false;
    /** @type {{user_code:string,verification_uri:string}|null} */
    this._deviceCode = null;
    /** @type {boolean} */
    this._waitingAuth = false;

    /** @type {{repo:string,branch:string,basePath:string,baseSha?:string}|null} `baseSha`: commit de la última sincronización. */
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

    /**
     * Diff por archivo; `origin` sale de la comparación a tres vías (ver `-diff.js`).
     * @type {Array<{path:string,status:'eq'|'add'|'del'|'mod',origin:'local'|'remote'|'conflict'|'unknown'|null,
     *   local:string,remote:string,base?:string,plus:number,minus:number}>}
     */
    this._diffItems = [];
    this._loadingDiff = false;
    /** @type {boolean} */
    this._pushing = false;
    /** @type {boolean} */
    this._pulling = false;

    /**
     * Marca a Monaco como desincronizado de la API tras un pull sin
     * reload, para que `_fetchProjectFromApi_` evite el Ctrl+S preventivo.
     * @type {boolean}
     */
    this._monacoStale = false;

    /** @type {string|null} Commit remoto contra el que se calculó el diff actual. */
    this._remoteCommitSha = null;
    /** @type {boolean} El `baseSha` guardado ya no existe en GitHub. */
    this._diffBaseMissing = false;
    /** @type {Map<string,Set<number>>|null} Tramos de contexto desplegados por archivo. */
    this._diffFoldsOpen = null;

    /**
     * Snapshot del último push para enmascarar el lag de propagación
     * del CDN de GitHub durante los segundos posteriores al commit.
     *
     * @type {{expiresAt:number, repo:string, branch:string, basePath:string,
     *         files:Map<string,{content:string, sha:string|null}>}|null}
     */
    this._postPushSnapshot = null;

    /**
     * Cache de blobs subidos al repo activo durante un push en curso.
     * Si la operación falla a la mitad (rate limit, conflicto en el
     * tree/ref) este mapa permite reintentar sin re-subir blobs ya
     * resueltos. Se vacía al cambiar de repo/branch o tras un push OK.
     * @type {{ repo:string, branch:string, basePath:string,
     *          blobs:Map<string,string> }|null}
     */
    this._pushBlobCache = null;

    /**
     * Decisiones del visor por archivo (ligadas al contenido con que se tomaron).
     * @type {Map<string,{action:'keep-local'|'take-remote'|'merged', content?:string, local:string, remote:string}>}
     */
    this._resolutions = new Map();

    /** @type {Set<string>} Paths seleccionados para push. */
    this._selectedFiles = new Set();
    /** @type {string|null} Path activo en la pestaña Diff. */
    this._activeDiffPath = null;
    /** @type {string} Commit message (persists while the panel is open). */
    this._commitMessage = '';

    /** @type {{overlay:HTMLElement, finish:Function, cancelValue:*}|null} Modal abierto. */
    this._activeModal = null;
    /** Contadores de generación: descartan resultados async obsoletos. */
    this._authGen = 0;
    this._diffGen = 0;
    this._branchesGen = 0;

    /** @type {Map<string,{resolve:Function,timerId:number}>} */
    this._pendingBridgeCalls = new Map();

    // Binds estables.
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onWindowKeyDown     = this._onWindowKeyDown.bind(this);
    this._onWindowResize      = this._onWindowResize.bind(this);
    this._onBridgeResult      = this._onBridgeResult.bind(this);
    this._onDeviceCodePush_   = this._onDeviceCodePush_.bind(this);
    this._onPushProgress_     = this._onPushProgress_.bind(this);
    this._onBeforeUnload_     = this._onBeforeUnload_.bind(this);
  }

  /**
   * Se ejecuta cuando el componente entra en el DOM. Pinta el shell,
   * registra listeners globales y dispara la verificación silenciosa
   * para que el indicador del botón refleje la sesión existente.
   */
  connectedCallback() {
    this._renderShell_();
    document.addEventListener('mousedown', this._onDocumentMouseDown, true);
    window.addEventListener('keydown',     this._onWindowKeyDown);
    window.addEventListener('resize',      this._onWindowResize);

    GasGithubPanel.BRIDGE_RESULT_EVENTS.forEach((evt) => document.addEventListener(evt, this._onBridgeResult));

    document.addEventListener('GAS_GH_DEVICE_CODE', this._onDeviceCodePush_);
    document.addEventListener('GAS_GH_PUSH_PROGRESS', this._onPushProgress_);

    // Silent ping to update the toolbar button badge.
    this._initBadgeFromAuth_();
  }

  /** Limpia listeners globales al desmontar el componente. */
  disconnectedCallback() {
    document.removeEventListener('mousedown', this._onDocumentMouseDown, true);
    window.removeEventListener('keydown',     this._onWindowKeyDown);
    window.removeEventListener('resize',      this._onWindowResize);
    GasGithubPanel.BRIDGE_RESULT_EVENTS.forEach((evt) => document.removeEventListener(evt, this._onBridgeResult));
    document.removeEventListener('GAS_GH_DEVICE_CODE', this._onDeviceCodePush_);
    document.removeEventListener('GAS_GH_PUSH_PROGRESS', this._onPushProgress_);
    this._flushBridgeCalls_();
    if (this._activeModal) this._activeModal.finish(this._activeModal.cancelValue);
    this._unlockTab_();
    this._closeDiffViewer_?.();
  }

  /**
   * Recibe la instancia de Monaco activa. Conservado por compatibilidad
   * con `gas-tools.js`; el panel sincroniza vía Apps Script API y solo
   * guarda esta referencia por si features futuras la requieren.
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
    this._diffFoldsOpen = null;
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

  /**
   * Indica si hay un push o pull en vuelo. Mientras `true`, el panel
   * ignora intentos de cerrar/togglear y de cambiar repo/branch.
   * @returns {boolean}
   */
  isBusy() {
    return !!(this._pushing || this._pulling);
  }

  /**
   * Aviso uniforme cuando el usuario intenta una acción bloqueante.
   * @private
   */
  _warnBusy_() {
    this._toast_(
      DomUtils.t('edGhSyncBusy', 'Sync in progress. Wait for it to finish before changing repo, branch or closing the panel.'),
      'info', 4000,
    );
  }

  /** Cierra el panel. */
  close() {
    if (this.isBusy()) { this._warnBusy_(); return; }
    this.style.display = 'none';
    this._openDropdown = '';
    this._closeDiffViewer_?.();
    this._closeProgress_();
  }

  /**
   * Alterna abierto/cerrado. Si hay sync en curso ignora la acción
   * para que el usuario no oculte la operación accidentalmente desde
   * el botón de la toolbar.
   * @param {HTMLElement|null} [anchorEl]
   */
  toggle(anchorEl) {
    if (this.isBusy()) { this._warnBusy_(); return; }
    if (this.style.display === 'block') this.close();
    else this.open(anchorEl);
  }

  /**
   * Pinta el esqueleto del Shadow DOM y adopta `GasUi.BASE_CSS` más el CSS
   * del panel (`gas-github-panel-styles.js`, global `GAS_GITHUB_PANEL_STYLES`).
   * @private
   */
  _renderShell_() {
    DomUtils.setHTML(this.shadowRoot, `
      <div class="qc__gh-shell">
        <div id="ghHeader" class="qc__gh-header"></div>
        <div id="ghBody" class="qc__gh-body"></div>
        <div id="ghFooter" class="qc__gh-footer" style="display:none"></div>
        <div id="ghProgress" class="qc__gh-progress" style="display:none"></div>
      </div>
    `);
    GasUi.adopt(this.shadowRoot, GAS_GITHUB_PANEL_STYLES);
  }

  /**
   * Icono SVG del registro compartido; el tamaño lo fija el CSS (`font-size`).
   * @param {string} name Nombre en `GasUi.ICON_NAMES`.
   * @param {string} [cls] Clases extra.
   * @returns {string} Marcado `<i class="qc__gh-ico">`.
   * @private
   */
  _ico_(name, cls = '') {
    return `<i class="qc__gh-ico${cls ? ` ${cls}` : ''}" aria-hidden="true">${GasUi.icon(name)}</i>`;
  }

  /**
   * Variante DOM de `_ico_` (sin parsear HTML).
   * @param {string} name Nombre en `GasUi.ICON_NAMES`.
   * @returns {HTMLElement} Nodo `<i class="qc__gh-ico">`.
   * @private
   */
  _icoNode_(name) {
    const i = document.createElement('i');
    i.className = 'qc__gh-ico';
    i.setAttribute('aria-hidden', 'true');
    const svg = GasUi.iconNode(document, name);
    if (svg) i.appendChild(svg);
    return i;
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
            : `${this._ico_('person')}`}
        </span>
        <span class="qc__gh-hdrText">
          <div class="qc__gh-hdrTitle">${DomUtils.escapeHtml(u.name || u.login)}</div>
          <div class="qc__gh-hdrSub">@${DomUtils.escapeHtml(u.login)}${
            gg ? ` · <span title="${DomUtils.escapeHtml(gg.email || '')}">${DomUtils.escapeHtml(gg.email || gg.name || '')}</span>` : ''
          }</div>
        </span>
        <button class="gt-icon-btn" id="ghLogoutAll"
                title="${DomUtils.escapeHtml(gg ? DomUtils.t('edGhSignOutGithubGoogle', 'Sign out of GitHub and Google') : DomUtils.t('edGhSignOutGithub', 'Sign out of GitHub'))}">
          ${this._ico_('logout')}
        </button>
        <button class="gt-icon-btn" id="ghClose" title="${DomUtils.escapeHtml(DomUtils.t('edGhClose', 'Close'))}">
          ${this._ico_('close')}
        </button>
      `);
    } else {
      DomUtils.setHTML(header, `
        <span class="qc__gh-avatar">${this._ico_('code')}</span>
        <span class="qc__gh-hdrText">
          <div class="qc__gh-hdrTitle">${DomUtils.escapeHtml(DomUtils.t('edGhTitle', 'GitHub sync'))}</div>
          <div class="qc__gh-hdrSub">${DomUtils.escapeHtml(DomUtils.t('edGhNotConnected', 'Not connected'))}</div>
        </span>
        <button class="gt-icon-btn" id="ghClose" title="${DomUtils.escapeHtml(DomUtils.t('edGhClose', 'Close'))}">
          ${this._ico_('close')}
        </button>
      `);
    }

    header.querySelector('#ghClose')?.addEventListener('click', () => this.close());
    header.querySelector('#ghLogoutAll')?.addEventListener('click', () => this._logoutAll_());
    this._refreshHeaderActionsBusy_();
  }

  /**
   * Refleja el estado busy en los botones de logout y close del
   * header, deshabilitándolos mientras hay un push o pull en curso
   * para que el usuario no pueda romper la operación a la mitad.
   * @private
   */
  _refreshHeaderActionsBusy_() {
    const header = this.shadowRoot.getElementById('ghHeader');
    if (!header) return;
    const busy = this.isBusy();
    for (const id of ['ghClose', 'ghLogoutAll']) {
      const btn = header.querySelector(`#${id}`);
      if (!btn) continue;
      btn.disabled = busy;
      btn.title = busy
        ? DomUtils.t('edGhWaitSync', 'Wait for the sync to finish')
        : (id === 'ghClose' ? DomUtils.t('edGhClose', 'Close') : btn.dataset.titleOriginal || DomUtils.t('edGhSignOut', 'Sign out'));
    }
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

    if (this._view === 'loading') {
      DomUtils.setHTML(body, `
        <div class="qc__gh-loader">
          <div class="qc__gh-loaderRow">
            <span class="qc__gh-spinner qc__gh-spinnerLg"></span>
            <div>
              <div class="qc__gh-loaderTitle">${DomUtils.escapeHtml(DomUtils.t('edGhVerifying', 'Verifying connection…'))}</div>
              <div class="qc__gh-loaderSub">${DomUtils.escapeHtml(DomUtils.t('edGhVerifyingSub', 'Checking GitHub session and project sync'))}</div>
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
   * Cede el control al event loop para que el navegador pueda pintar
   * actualizaciones acumuladas en la UI antes de continuar con un
   * trabajo síncrono pesado (loops de cientos de archivos).
   * @returns {Promise<void>}
   * @private
   */
  _yieldToUi_() {
    return new Promise((r) => setTimeout(r, 0));
  }

  /**
   * Atajo para invocar una acción de la API de GitHub a través del
   * bridge (`GAS_GH_API_CALL`).
   * @param {string} action  Acción del background (`LIST_REPOS`, `PUSH_FILES`, …).
   * @param {object} [payload]
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

  /**
   * Despacha un CustomEvent al bridge y resuelve cuando llega el
   * resultado con el mismo `requestId`. Las llamadas interactivas
   * (Device Flow, consent de Google) usan un timeout de 16 min para
   * cubrir la espera por aprobación del usuario; el resto, 30 s.
   * @param {string} eventName
   * @param {object} [payload]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<*>}
   * @private
   */
  _bridgeCall_(eventName, payload = {}, opts = {}) {
    return new Promise((resolve) => {
      const requestId = `gh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Llamadas de autenticación interactiva quedan a la espera del
      // usuario (puede tardar varios minutos). Para no abandonarlas con
      // un timeout corto, les damos 16 min — un poco más que la ventana
      // de 15 min que GitHub deja al Device Flow.
      const interactive = (
        eventName === 'GAS_GH_AUTHENTICATE' ||
        eventName === 'GAS_GG_AUTHENTICATE'
      );
      const ms = opts.timeoutMs ?? (interactive ? 16 * 60 * 1000 : 30000);

      // La entrada pendiente guarda el timer para limpiarlo al resolver;
      // así respuesta, timeout y desmontaje siempre liberan la entrada.
      const timerId = setTimeout(() => {
        this._settleBridgeCall_(requestId, { ok: false, error: DomUtils.t('edGhTimeout', 'Timeout') });
      }, ms);
      this._pendingBridgeCalls.set(requestId, { resolve, timerId });

      document.dispatchEvent(new CustomEvent(eventName, {
        detail: JSON.stringify({ requestId, ...payload }),
      }));
    });
  }

  /**
   * Resuelve y elimina una llamada pendiente del bridge (idempotente).
   * @param {string} requestId
   * @param {*} value
   * @private
   */
  _settleBridgeCall_(requestId, value) {
    const entry = this._pendingBridgeCalls.get(requestId);
    if (!entry) return;
    this._pendingBridgeCalls.delete(requestId);
    clearTimeout(entry.timerId);
    entry.resolve(value);
  }

  /**
   * Resuelve con error todas las llamadas pendientes (usado al desmontar
   * para no dejar promesas colgadas ni timers vivos).
   * @private
   */
  _flushBridgeCalls_() {
    for (const requestId of [...this._pendingBridgeCalls.keys()]) {
      this._settleBridgeCall_(requestId, { ok: false, error: 'Disconnected' });
    }
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
    if (!this._pendingBridgeCalls.has(requestId)) return;

    if ('ok' in payload) {
      const { requestId: _, ...rest } = payload;
      this._settleBridgeCall_(requestId, rest);
    } else if ('data' in payload) {
      this._settleBridgeCall_(requestId, payload.data);
    } else {
      this._settleBridgeCall_(requestId, payload);
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
    const buttons = document.querySelectorAll(GasGithubPanel.ANCHOR_SELECTOR);
    if (!buttons.length) return;
    this._ensureBadgeStyles_();
    const isConnected = !!this._user;
    const repo = this._project?.repo || '';
    const branch = this._project?.branch || '';
    const tooltip = isConnected
      ? (repo ? `GitHub · ${repo}${branch ? ` (${branch})` : ''}` : DomUtils.t('edGhBadgeConnected', 'GitHub · Connected'))
      : DomUtils.t('edGhTitle', 'GitHub sync');

    // Tooltip nativo del contenedor (puede no existir si GAS cambió el DOM).
    document.querySelector('#buttonGithubGas .yggLIc')?.setAttribute('data-tt', tooltip);

    // Cada botón con el mismo ID, por si Google recrea los paneles.
    buttons.forEach((btn) => {
      btn.closest('.RO63ad')?.setAttribute('data-tt', tooltip);
      const dot = btn.querySelector('.qc__gh-dot');
      if (isConnected && !dot) {
        const badge = document.createElement('span');
        badge.className = 'qc__gh-dot';
        if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
        btn.appendChild(badge);
      } else if (!isConnected && dot) {
        dot.remove();
      }
    });
  }

  /**
   * Inyecta una sola vez el CSS del badge en el documento (light DOM).
   * @private
   */
  _ensureBadgeStyles_() {
    if (document.getElementById(GasGithubPanel.BADGE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = GasGithubPanel.BADGE_STYLE_ID;
    style.textContent = GasGithubPanel.BADGE_CSS;
    (document.head || document.documentElement).appendChild(style);
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
   * Ancla el panel al botón con `GasUi.positionPopover` (alineado a la
   * derecha, flip vertical y flecha) y limita la altura al espacio libre.
   * Si la toolbar se reinyectó, re-resuelve el botón visible.
   * @private
   */
  _positionPanel_() {
    this._anchorEl = GasUi.liveAnchor(this._anchorEl, GasGithubPanel.ANCHOR_SELECTOR);
    if (!this._anchorEl) return;
    // Altura limitada al espacio bajo el botón (antes: top fijo de 102px).
    const below = window.innerHeight - this._anchorEl.getBoundingClientRect().bottom - 24;
    this.style.setProperty('--qc-gh-max-h', `${Math.max(240, Math.round(below))}px`);
    if (GasUi.positionPopover(this, this._anchorEl, { align: 'end', gap: 10, margin: 14 })) this.style.right = 'auto';
  }

  /**
   * Cierra el panel al hacer click fuera. Si hay un dropdown abierto,
   * solo cierra el dropdown sin tumbar el panel.
   * @param {MouseEvent} e
   * @private
   */
  _onDocumentMouseDown(e) {
    if (this.style.display !== 'block') return;
    // Con el visor abierto, sus clics no cierran el panel.
    if (window.gasDiffViewer?.isOpen?.()) return;
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
    if (this.isBusy()) return;   // sync en curso → no cerramos al click fuera
    this.close();
  }

  /**
   * Cierra el dropdown abierto o el panel completo con Esc.
   * @param {KeyboardEvent} e
   * @private
   */
  _onWindowKeyDown(e) {
    if (e.key !== 'Escape' || this.style.display !== 'block') return;
    if (window.gasDiffViewer?.isOpen?.()) return;   // Escape es del visor
    if (this._openDropdown) {
      this._openDropdown = '';
      const body = this.shadowRoot.getElementById('ghBody');
      const footer = this.shadowRoot.getElementById('ghFooter');
      if (body && footer) this._renderConnectedView_(body, footer);
      return;
    }
    if (this.isBusy()) return;   // sync en curso → ignoramos Escape
    this.close();
  }

  /** Reposiciona el panel cuando cambia el tamaño de la ventana. @private */
  _onWindowResize() {
    if (this.style.display === 'block') this._positionPanel_();
  }
}

// Métodos repartidos en mixins (scripts clásicos cargados antes que este).
(() => {
  const mixins = {
    GasGithubPanelAuthMixin: typeof GasGithubPanelAuthMixin !== 'undefined' ? GasGithubPanelAuthMixin : null,
    GasGithubPanelSyncMixin: typeof GasGithubPanelSyncMixin !== 'undefined' ? GasGithubPanelSyncMixin : null,
    GasGithubPanelDiffMixin: typeof GasGithubPanelDiffMixin !== 'undefined' ? GasGithubPanelDiffMixin : null,
    GasGithubPanelModalsMixin: typeof GasGithubPanelModalsMixin !== 'undefined' ? GasGithubPanelModalsMixin : null,
    GasGithubPanelProgressMixin: typeof GasGithubPanelProgressMixin !== 'undefined' ? GasGithubPanelProgressMixin : null,
  };
  for (const [name, mixin] of Object.entries(mixins)) {
    if (!mixin) {
      console.error(`[gas-github-panel] Falta el mixin ${name}: revisa el orden de inyección de scripts.`);
      continue;
    }
    Object.assign(GasGithubPanel.prototype, mixin);
  }
})();

if (!customElements.get('gas-github-panel')) {
  customElements.define('gas-github-panel', GasGithubPanel);
}
