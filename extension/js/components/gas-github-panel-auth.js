"use strict";

/**
 * @fileoverview Mixin de <gas-github-panel>: Autenticación de Google y GitHub (device flow, logout, vista no autenticada y badge inicial).
 *
 * Script clásico (MAIN world). Se carga antes de `gas-github-panel.js`,
 * que copia estos métodos a `GasGithubPanel.prototype` con `Object.assign`.
 * Los métodos usan `this` como la instancia del elemento.
 */
const GasGithubPanelAuthMixin = {

  /**
   * Verifica las dos sesiones que el panel necesita (Google primero,
   * GitHub después) y decide la vista a mostrar:
   *   - sin Google → 'unauth' Step 1.
   *   - con Google + sin GitHub → 'unauth' Step 2.
   *   - con ambos válidos → 'connected' + carga repos y diff frescos.
   *   - token revocado → logout silencioso del afectado y vuelta al paso.
   * @private
   */
  async _refreshAuth_() {
    // Re-entrancia: cada llamada invalida las anteriores aún en vuelo.
    const gen = ++this._authGen;
    const isStale_ = () => gen !== this._authGen;

    this._view = 'loading';
    this._renderHeader_();
    this._renderBody_();

    // Paso 1: verificar Google. Sin esta sesión no avanzamos.
    const gg = await this._bridgeCall_('GAS_GG_GET_AUTH');
    if (isStale_()) return;
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
    // El background ya no expone el token: `data` es `{ user }` o null.
    const auth = await this._bridgeCall_('GAS_GH_GET_AUTH');
    if (isStale_()) return;
    if (!auth?.user) {
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
    if (isStale_()) return;

    if (!ping?.ok) {
      const msg = String(ping?.error || '');
      if (/\b(401|403|Bad credentials)\b/i.test(msg)) {
        await this._bridgeCall_('GAS_GH_LOGOUT');
        if (isStale_()) return;
        this._user = null;
        this._view = 'unauth';
        this._renderHeader_();
        this._renderBody_();
        this._log_(DomUtils.t('edGhSessionExpired', 'Session expired or revoked. Please sign in again.'), 'error');
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
  },

  /**
   * Cierra la sesión de GitHub solo cuando la respuesta indica
   * inequívocamente token caducado o revocado. Acepta 401 (siempre
   * credenciales inválidas en la API REST) y 403 con mensajes tipo
   * "Bad credentials" o "token revoked/expired". Cualquier otro 403
   * (rama protegida, scope insuficiente, rate limit, SSO) se devuelve
   * `false` para que el caller muestre el error normal.
   *
   * @returns {Promise<boolean>} true si se cerró sesión por auth error.
   */
  async _handleAuthError_(response) {
    if (!response || response.ok) return false;
    const msg = String(response.error || '');

    const is401 = /\b401\b/.test(msg);
    const is403WithAuthMessage =
      /\b403\b/.test(msg) &&
      /(bad credentials|token .*(revoked|expired)|requires authentication)/i.test(msg);

    if (!is401 && !is403WithAuthMessage) return false;

    await this._bridgeCall_('GAS_GH_LOGOUT');
    this._user = null;
    this._view = 'unauth';
    this._repos = [];
    this._reposLoaded = false;
    this._branches = [];
    this._renderHeader_();
    this._renderBody_();
    this._log_(DomUtils.t('edGhSessionExpired', 'Session expired or revoked. Please sign in again.'), 'error');
    this._updateAnchorBadge_();
    return true;
  },

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
      const userCode = this._deviceCode?.user_code || '••••-••••';
      const url  = this._deviceCode?.verification_uri || 'https://github.com/login/device';
      DomUtils.setHTML(body, `
        <div class="qc__gh-connectCard">
          <div class="qc__gh-connectIcon">${this._ico_('hourglass')}</div>
          <div class="qc__gh-connectTitle">${DomUtils.escapeHtml(DomUtils.t('edGhWaitingAuth', 'Waiting for authorization…'))}</div>
          <div class="qc__gh-connectHint">
            ${DomUtils.escapeHtml(DomUtils.t('edGhDeviceHint', 'A small window opened with GitHub\'s authorization page. If the Code didn\'t pre-fill, paste it manually:'))}
          </div>
          <div class="qc__gh-codeBox">
            <span class="qc__gh-Code">${DomUtils.escapeHtml(userCode)}</span>
            <button id="ghCopyCode" class="gt-btn gt-btn--outlined qc__gh-btn" title="${DomUtils.escapeHtml(DomUtils.t('edGhCopyCode', 'Copy Code'))}">
              ${this._ico_('copy')}
            </button>
          </div>
          <div class="qc__gh-connectHint" style="margin-top:8px">
            <span class="qc__gh-spinner"></span>
            ${DomUtils.escapeHtml(DomUtils.t('edGhAuthorizeHint', 'Authorize the app in GitHub. You\'ll be signed in automatically here.'))}
          </div>
          <div style="margin-top:10px; display:flex; gap:6px; justify-content:center">
            <button id="ghCancelAuth" class="gt-btn gt-btn--outlined qc__gh-btn">${DomUtils.escapeHtml(DomUtils.t('edGhCancel', 'Cancel'))}</button>
            <button id="ghReopenTab" class="gt-btn gt-btn--outlined qc__gh-btn">
              ${this._ico_('openInNew')}
              ${DomUtils.escapeHtml(DomUtils.t('edGhReopenWindow', 'Reopen window'))}
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
      ? `${this._ico_('success', 'qc__gh-icoOk')}`
      : `${this._ico_('looksOne')}`;
    const githubStepIcon  = `${this._ico_('looksTwo')}`;

    const googleStatus = googleConnected
      ? DomUtils.escapeHtml(DomUtils.t('edGhSignedInAs', 'Signed in as $1'))
          .split('$1').join(`<strong>${DomUtils.escapeHtml(this._googleUser.email || this._googleUser.name || '')}</strong>`)
      : DomUtils.escapeHtml(DomUtils.t('edGhGoogleRequired', 'Required to read and write files in your Apps Script project.'));

    const googleBtnLabel = this._googleAuthInFlight
      ? `<span class="qc__gh-spinner ${googleConnected ? '' : 'qc__gh-spinnerOnDark'}"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhConnecting', 'Connecting…'))}`
      : (googleConnected
          ? `${this._ico_('refresh')} ${DomUtils.escapeHtml(DomUtils.t('edGhSwitchAccount', 'Switch account'))}`
          : `${this._ico_('login')} ${DomUtils.escapeHtml(DomUtils.t('edGhSignInGoogle', 'Sign in with Google'))}`);

    const githubDisabled = !googleConnected;

    DomUtils.setHTML(body, `
      <div class="qc__gh-connectCard">
        <div class="qc__gh-connectStep">
          <div class="qc__gh-connectStepIcon">${googleStepIcon}</div>
          <div class="qc__gh-connectStepBody">
            <div class="qc__gh-connectStepTitle">${DomUtils.escapeHtml(DomUtils.t('edGhConnectGoogle', 'Connect Google'))}</div>
            <div class="qc__gh-connectStepHint">${googleStatus}</div>
            <div class="qc__gh-connectStepActions">
              <button id="ggConnect"
                      class="gt-btn qc__gh-btn ${googleConnected ? 'gt-btn--outlined' : 'gt-btn--filled'}"
                      ${this._googleAuthInFlight ? 'disabled' : ''}>
                ${googleBtnLabel}
              </button>
              ${googleConnected ? `
                <button id="ggDisconnect" class="gt-btn gt-btn--outlined qc__gh-btn"
                        title="${DomUtils.escapeHtml(DomUtils.t('edGhDisconnectGoogleTitle', 'Disconnect this Google account'))}">
                  ${this._ico_('logout')}
                </button>
              ` : ''}
            </div>
          </div>
        </div>

        <div class="qc__gh-connectDivider"></div>

        <div class="qc__gh-connectStep ${githubDisabled ? 'qc__gh-stepDisabled' : ''}">
          <div class="qc__gh-connectStepIcon">${githubStepIcon}</div>
          <div class="qc__gh-connectStepBody">
            <div class="qc__gh-connectStepTitle">${DomUtils.escapeHtml(DomUtils.t('edGhConnectGithub', 'Connect GitHub'))}</div>
            <div class="qc__gh-connectStepHint">
              ${githubDisabled
                ? DomUtils.escapeHtml(DomUtils.t('edGhAfterGoogle', 'Available after connecting Google.'))
                : DomUtils.escapeHtml(DomUtils.t('edGhGithubHint', 'A small window will open. Approve the app to finish. Your token never leaves your browser.'))}
            </div>
            <div class="qc__gh-connectStepActions">
              <button id="ghConnect" class="gt-btn gt-btn--filled qc__gh-btn"
                      ${githubDisabled ? 'disabled' : ''}>
                ${this._ico_('login')}
                ${DomUtils.escapeHtml(DomUtils.t('edGhSignInGithub', 'Sign in with GitHub'))}
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
  },

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
    this._toast_(DomUtils.t('edGhOpeningGithubAuth', 'Opening GitHub authorization window…'), 'info', 2000);

    const res = await this._bridgeCall_('GAS_GH_AUTHENTICATE');
    this._waitingAuth = false;
    this._deviceCode  = null;

    if (res?.ok) {
      this._user = res.user;
      this._view = 'connected';
      this._toast_(DomUtils.t('edGhConnectedAs', 'Connected as $1', `@${res.user.login}`), 'ok');
      this._renderHeader_();
      this._renderBody_();
      this._loadProjectConfig_();
      this._refreshRepos_(true);
      this._updateAnchorBadge_();
    } else {
      this._renderBody_();
      this._toast_(res?.error || DomUtils.t('edGhAuthFailed', 'Authentication failed'), 'error', 5000);
    }
  },

  /** Cancela el Device Flow en curso. @private */
  async _cancelAuth_() {
    await this._bridgeCall_('GAS_GH_CANCEL_AUTH');
    this._waitingAuth = false;
    this._deviceCode = null;
    this._renderBody_();
  },

  /** Copia el `user_code` del Device Flow al portapapeles. @private */
  async _copyDeviceCode_() {
    if (!this._deviceCode?.user_code) return;
    try {
      await navigator.clipboard.writeText(this._deviceCode.user_code);
      this._toast_(DomUtils.t('edGhCodeCopied', 'Code copied to clipboard'), 'ok');
    } catch (_) {
      this._toast_(DomUtils.t('edGhCodeCopyFailed', 'Could not copy code'), 'error');
    }
  },

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
  },

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
    if (this.isBusy()) { this._warnBusy_(); return; }
    const hasGoogle = !!this._googleUser;
    const hasGithub = !!this._user;

    const confirmed = await this._showConfirm_({
      title:        DomUtils.t('edGhSignOutConfirmTitle', 'Sign out?'),
      message:      hasGoogle && hasGithub
        ? DomUtils.t('edGhSignOutBothMsg', 'Disconnect both your GitHub and Google accounts from this browser. You can reconnect either from the panel.')
        : (hasGithub
            ? DomUtils.t('edGhSignOutGithubMsg', 'The GitHub token will be removed from this browser.')
            : DomUtils.t('edGhSignOutGoogleMsg', 'The Google account will be disconnected from this browser.')),
      confirmLabel: DomUtils.t('edGhSignOut', 'Sign out'),
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
  },

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
    this._toast_(DomUtils.t('edGhOpeningGoogle', 'Opening Google sign-in…'), 'info', 1800);

    const res = await this._bridgeCall_('GAS_GG_AUTHENTICATE');
    this._googleAuthInFlight = false;

    if (res?.ok && res.user) {
      this._googleUser = res.user;
      this._toast_(DomUtils.t('edGhConnectedAs', 'Connected as $1', res.user.email || res.user.name || DomUtils.t('edGhGoogleAccount', 'Google account')), 'ok');
      // Si el usuario vino aquí desde Step 1, dejamos visible Step 2 con
      // el botón de GitHub habilitado; si ya tenía GitHub conectado, el
      // refresh asciende a 'connected'.
      this._refreshAuth_();
    } else {
      this._renderBody_();
      const msg = res?.error || DomUtils.t('edGhGoogleConnectFailed', 'Could not connect to Google.');
      // Mensaje específico cuando la extensión no fue empaquetada con un
      // OAuth client_id válido (manifest.oauth2.client_id placeholder).
      if (/OAuth2 not granted|client_id|invalid_client/i.test(msg)) {
        this._toast_(
          DomUtils.t('edGhGoogleNotConfigured', 'Google sign-in not configured. Set manifest.oauth2.client_id and reload the extension.'),
          'error', 7000,
        );
      } else {
        this._toast_(msg, 'error', 5000);
      }
    }
  },

  /**
   * Cierra la sesión de Google: pide confirmación, llama al background
   * para limpiar el token cacheado, e invalida la vista (vuelve a Step 1
   * porque GitHub depende de Google para tener una fuente de verdad).
   * @private
   */
  async _logoutGoogle_() {
    const confirmed = await this._showConfirm_({
      title:        DomUtils.t('edGhDisconnectGoogleConfirmTitle', 'Disconnect Google?'),
      message:      DomUtils.t('edGhDisconnectGoogleMsg', 'GitHub sync will be paused until you reconnect a Google account. Your GitHub session is not affected.'),
      confirmLabel: DomUtils.t('edGhDisconnect', 'Disconnect'),
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
  },

  /**
   * Carga silenciosa al montar: si hay token válido pinta el dot verde
   * en el botón sin abrir el panel; si está revocado lo limpia del
   * storage.
   * @private
   */
  async _initBadgeFromAuth_() {
    const gen = ++this._authGen;
    const isStale_ = () => gen !== this._authGen;
    this._scriptId = this._extractScriptId_();
    const auth = await this._bridgeCall_('GAS_GH_GET_AUTH');
    if (isStale_()) return;
    if (!auth?.user) {
      this._user = null;
      this._updateAnchorBadge_();
      return;
    }
    const ping = await this._ghApi_('GET_USER', {});
    if (isStale_()) return;
    if (ping?.ok && ping.data) {
      this._user = ping.data;
      if (this._scriptId) {
        const cfg = await this._bridgeCall_('GAS_GH_GET_PROJECT', { scriptId: this._scriptId });
        if (isStale_()) return;
        this._project = cfg && typeof cfg === 'object' ? cfg : null;
      }
    } else if (ping && !ping.ok && /\b(401|403|Bad credentials)\b/i.test(String(ping.error || ''))) {
      await this._bridgeCall_('GAS_GH_LOGOUT');
      if (isStale_()) return;
      this._user = null;
      this._project = null;
    } else {
      this._user = auth.user;
    }
    this._updateAnchorBadge_();
  },
};
