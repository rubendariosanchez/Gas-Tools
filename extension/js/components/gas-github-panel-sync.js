"use strict";

/**
 * @fileoverview Mixin de <gas-github-panel>: Selección de repo/rama/basePath, recálculo del diff (ver `-diff.js`), push/pull y recolección de archivos locales.
 *
 * Script clásico (MAIN world). Se carga antes de `gas-github-panel.js`,
 * que copia estos métodos a `GasGithubPanel.prototype` con `Object.assign`.
 * Los métodos usan `this` como la instancia del elemento.
 */
const GasGithubPanelSyncMixin = {

  /**
   * Carga el binding scriptId → repo desde el background y, si existe,
   * dispara la carga de branches + recálculo de diff.
   * @private
   */
  async _loadProjectConfig_() {
    if (!this._scriptId) return;
    const gen = this._authGen;
    const cfg = await this._bridgeCall_('GAS_GH_GET_PROJECT', { scriptId: this._scriptId });
    // Descarta la respuesta si otra verificación de sesión empezó después.
    if (gen !== this._authGen) return;
    this._project = cfg && typeof cfg === 'object' ? cfg : null;
    this._renderBody_();
    this._updateAnchorBadge_();

    // Si hay un repo asociado al scriptId, traemos las branches y
    // recalculamos el diff contra el remoto.
    if (this._project?.repo && this._project?.branch) {
      this._loadBranches_(this._project.repo);
      this._recomputeDiff_();
    }
  },

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
      this._lastReposError = result?.error || DomUtils.t('edGhReposLoadFailed', 'Could not load repositories');
      this._log_(this._lastReposError, 'error');
    }
    this._renderBody_();
  },

  /**
   * Trae las branches del repo indicado y refresca el dropdown.
   * @param {string} fullName  `owner/repo`
   * @private
   */
  async _loadBranches_(fullName) {
    // Generación: si el usuario cambia de repo antes de que responda,
    // la respuesta vieja se descarta y no pisa las branches nuevas.
    const gen = ++this._branchesGen;
    this._loadingBranches = true;
    const res = await this._ghApi_('LIST_BRANCHES', { repo: fullName });
    if (gen !== this._branchesGen || this._project?.repo !== fullName) {
      if (gen === this._branchesGen) this._loadingBranches = false;
      return;
    }
    this._loadingBranches = false;
    if (res?.ok) {
      this._branches = Array.isArray(res.data) ? res.data : [];
      this._renderBody_();
    } else if (!(await this._handleAuthError_(res))) {
      this._toast_(res?.error || DomUtils.t('edGhBranchesLoadFailed', 'Could not list branches'), 'error', 5000);
    }
  },

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
              <span class="qc__gh-sectionTitle">${DomUtils.escapeHtml(DomUtils.t('edGhRepository', 'Repository'))}</span>
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
          <span class="qc__gh-spinner"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhLoadingRepos', 'Loading your repositories…'))}
        </div>
        <div id="ghLog" class="qc__gh-log"></div>
      `);
      return;
    }

    const repoLabel = selectedRepo
      ? `${this._ico_('folder', 'qc__gh-selectorIcon')}
         <span class="qc__gh-selectorLabel">${DomUtils.escapeHtml(selectedRepo)}</span>`
      : `${this._ico_('folderOpen', 'qc__gh-selectorIcon')}
         <span class="qc__gh-selectorLabel" style="color: var(--gt-on-surface-variant)">${DomUtils.escapeHtml(DomUtils.t('edGhSelectRepo', 'Select repository…'))}</span>`;

    const branchLabel = selectedBranch
      ? `${this._ico_('branch', 'qc__gh-selectorIcon')}
         <span class="qc__gh-selectorLabel">${DomUtils.escapeHtml(selectedBranch)}</span>
         ${this._isDefaultBranch_() ? `<span class="qc__gh-selectorBadge">${DomUtils.escapeHtml(DomUtils.t('edGhDefaultBadge', 'default'))}</span>` : ''}`
      : `${this._ico_('branch', 'qc__gh-selectorIcon')}
         <span class="qc__gh-selectorLabel" style="color: var(--gt-on-surface-variant)">${DomUtils.escapeHtml(DomUtils.t('edGhSelectBranch', 'Select branch…'))}</span>`;

    // URL "Open on GitHub" que apunta a la branch seleccionada cuando
    // está disponible (lleva al mismo código que se ve localmente).
    let repoUrl = '';
    if (selectedRepo) {
      repoUrl = selectedBranch
        ? `https://github.com/${selectedRepo}/tree/${encodeURIComponent(selectedBranch)}`
        : `https://github.com/${selectedRepo}`;
    }
    const repoUrlEsc = DomUtils.escapeHtml(repoUrl);
    const tabActive = this._activeTab;
    const totalChanges = this._diffItems.filter((i) => i.status !== 'eq').length;

    DomUtils.setHTML(body, `
      <div class="qc__gh-grid">
        <div class="qc__gh-col qc__gh-colLeft">
          <div class="qc__gh-sectionHead">
            <span class="qc__gh-sectionTitle">${DomUtils.escapeHtml(DomUtils.t('edGhRepository', 'Repository'))}</span>
            <div class="qc__gh-sectionActions">
              <button id="ghReloadRepos" class="gt-icon-btn qc__gh-iconBtn ${this._loadingRepos ? 'qc__gh-spin' : ''}"
                      title="${DomUtils.escapeHtml(DomUtils.t('edGhReloadRepos', 'Reload repositories'))}" ${this._loadingRepos ? 'disabled' : ''}>
                ${this._ico_('refresh')}
              </button>
              <button id="ghCreateRepo" class="gt-icon-btn qc__gh-iconBtn" title="${DomUtils.escapeHtml(DomUtils.t('edGhCreateRepoTitle', 'Create new repository'))}">
                ${this._ico_('plus')}
              </button>
            </div>
          </div>

          <div class="qc__gh-row">
            <div class="qc__gh-selectorWrap">
              <button class="qc__gh-selector" id="ghRepoSelector"
                      aria-expanded="${this._openDropdown === 'repo' ? 'true' : 'false'}">
                ${repoLabel}
                ${this._ico_('chevronDown', 'qc__gh-selectorChevron')}
              </button>
              ${this._openDropdown === 'repo' ? this._renderRepoDropdown_() : ''}
            </div>
            ${repoUrl ? `
              <a class="gt-icon-btn gt-icon-btn--outlined qc__gh-openExternal" href="${repoUrlEsc}"
                 target="_blank" rel="noopener noreferrer"
                 title="${DomUtils.escapeHtml(DomUtils.t('edGhOpenRepoOnGithub', 'Open $1 on GitHub', selectedRepo + (selectedBranch ? ` (${selectedBranch})` : '')))}">
                ${this._ico_('openInNew')}
              </a>
            ` : `
              <button class="gt-icon-btn gt-icon-btn--outlined qc__gh-openExternal" disabled title="${DomUtils.escapeHtml(DomUtils.t('edGhOpenOnGithub', 'Open on GitHub'))}">
                ${this._ico_('openInNew')}
              </button>
            `}
          </div>

          <div class="qc__gh-field">
            <label class="qc__gh-fieldLabel">${DomUtils.escapeHtml(DomUtils.t('edGhBranch', 'Branch'))}</label>
            <div class="qc__gh-selectorWrap">
              <button class="qc__gh-selector" id="ghBranchSelector"
                      aria-expanded="${this._openDropdown === 'branch' ? 'true' : 'false'}"
                      ${selectedRepo ? '' : 'disabled'}>
                ${branchLabel}
                ${this._ico_('chevronDown', 'qc__gh-selectorChevron')}
              </button>
              ${this._openDropdown === 'branch' ? this._renderBranchDropdown_() : ''}
            </div>
          </div>

          <div class="qc__gh-field">
            <label class="qc__gh-fieldLabel">${DomUtils.escapeHtml(DomUtils.t('edGhSubfolder', 'Subfolder'))}</label>
            <input id="ghBasePath" class="gt-input qc__gh-input" type="text"
                   placeholder="src/" value="${DomUtils.escapeHtml(basePath)}">
          </div>

          <div class="qc__gh-field qc__gh-grow">
            <label class="qc__gh-fieldLabel">${DomUtils.escapeHtml(DomUtils.t('edGhCommitMessage', 'Commit message'))}</label>
            <textarea id="ghCommitMsg" class="gt-input qc__gh-input qc__gh-commitArea"
                      placeholder="${DomUtils.escapeHtml(DomUtils.t('edGhCommitPlaceholder', 'Describe your changes…'))}">${DomUtils.escapeHtml(this._commitMessage)}</textarea>
          </div>
        </div>

        <!-- Columna derecha: tabs Changes / Diff -->
        <div class="qc__gh-col qc__gh-colRight">
          <div class="qc__gh-tabsRow">
            <div class="qc__gh-tabs" role="tablist">
              <button class="qc__gh-tab ${tabActive === 'changes' ? 'qc__gh-activeTab' : ''}"
                      data-tab="changes">
                ${this._ico_('list')}
                ${DomUtils.escapeHtml(DomUtils.t('edGhTabChanges', 'Changes'))}${totalChanges ? ` (${totalChanges})` : ''}
              </button>
              <button class="qc__gh-tab ${tabActive === 'diff' ? 'qc__gh-activeTab' : ''}"
                      data-tab="diff">
                ${this._ico_('eye')}
                ${DomUtils.escapeHtml(DomUtils.t('edGhTabDiff', 'Diff'))}
              </button>
            </div>
            <button id="ghRefreshDiff"
                    class="gt-icon-btn qc__gh-iconBtn ${this._loadingDiff ? 'qc__gh-spin' : ''}"
                    title="${DomUtils.escapeHtml(DomUtils.t('edGhRecheckChanges', 'Re-check changes against the repository'))}"
                    ${(!selectedRepo || !selectedBranch || this._loadingDiff) ? 'disabled' : ''}>
              ${this._ico_('refresh')}
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
        this._renderConnectedView_(body, footer);
      });
    });

    // Cablear los inputs de búsqueda de los dropdowns.
    this._wireDropdownEvents_();
  },

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
  },

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
               data-repo="${DomUtils.escapeHtml(r.full_name)}">
            ${this._ico_(r.private ? 'lock' : 'folder')}
            <span class="qc__gh-ddItemLabel">${DomUtils.escapeHtml(r.full_name)}</span>
            ${r.full_name === selected
              ? `${this._ico_('check', 'qc__gh-ddCheck')}` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">${
          filter
            ? DomUtils.escapeHtml(DomUtils.t('edGhNoMatchesFor', 'No matches for "$1"', filter))
            : (this._repos.length ? '' : DomUtils.escapeHtml(DomUtils.t('edGhNoRepos', 'No repositories available')))
        }</div>`;

    return `
      <div class="qc__gh-dropdown" data-dd="repo">
        <div class="qc__gh-ddSearch">
          ${this._ico_('search')}
          <input id="ghRepoFilterInput" type="text"
                 placeholder="${DomUtils.escapeHtml(DomUtils.t('edGhSearchRepo', 'Search repository…'))}"
                 value="${DomUtils.escapeHtml(this._repoFilter)}">
        </div>
        <div class="qc__gh-ddList">${items}</div>
      </div>
    `;
  },

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
               data-branch="${DomUtils.escapeHtml(b.name)}">
            ${this._ico_('branch')}
            <span class="qc__gh-ddItemLabel">${DomUtils.escapeHtml(b.name)}</span>
            ${b.name === selected
              ? `${this._ico_('check', 'qc__gh-ddCheck')}` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">${
          this._loadingBranches
            ? `<span class="qc__gh-spinner"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhLoadingBranches', 'Loading branches…'))}`
            : DomUtils.escapeHtml(DomUtils.t('edGhNoBranches', 'No branches'))
        }</div>`;

    return `
      <div class="qc__gh-dropdown" data-dd="branch">
        <div class="qc__gh-ddSearch">
          ${this._ico_('search')}
          <input id="ghBranchFilterInput" type="text"
                 placeholder="${DomUtils.escapeHtml(DomUtils.t('edGhSearchBranch', 'Search branch…'))}"
                 value="${DomUtils.escapeHtml(this._branchFilter)}">
        </div>
        <div class="qc__gh-ddList">${items}</div>
        <div class="qc__gh-ddFooter">
          <button id="ghCreateBranch" class="qc__gh-ddFooterBtn" type="button">
            ${this._ico_('plus')}
            ${DomUtils.escapeHtml(DomUtils.t('edGhCreateBranchItem', 'Create new branch…'))}
          </button>
        </div>
      </div>
    `;
  },

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
      setTimeout(() => repoInput.focus({ preventScroll: true }), 0);
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
      setTimeout(() => branchInput.focus({ preventScroll: true }), 0);
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

    this._fitDropdown_();
  },

  /**
   * Ajusta el dropdown abierto al espacio visible de sus contenedores con scroll:
   * recorta la lista (buscador y pie siempre visibles) y lo abre hacia arriba si cabe mejor.
   * @private
   */
  _fitDropdown_() {
    const dd = this.shadowRoot.querySelector('.qc__gh-dropdown');
    const list = dd?.querySelector('.qc__gh-ddList');
    const anchor = dd?.parentElement;
    if (!list || !anchor) return;

    // Límites: viewport ∩ cada ancestro que recorta (overflow distinto de visible).
    let top = 0;
    let bottom = window.innerHeight;
    for (let el = anchor.parentElement; el && el !== this; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
      const r = el.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
    }

    const GAP = 8;
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = bottom - rect.bottom - GAP;
    const spaceAbove = rect.top - top - GAP;
    const chrome = dd.offsetHeight - list.offsetHeight;   // buscador + pie
    const listFull = list.scrollHeight;
    const dropUp = spaceBelow < chrome + Math.min(listFull, 120) && spaceAbove > spaceBelow;
    const space = dropUp ? spaceAbove : spaceBelow;

    dd.classList.toggle('qc__gh-dropUp', dropUp);
    list.style.maxHeight = `${Math.max(72, Math.min(240, Math.floor(space - chrome)))}px`;
  },

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
               data-repo="${DomUtils.escapeHtml(r.full_name)}">
            ${this._ico_(r.private ? 'lock' : 'folder')}
            <span class="qc__gh-ddItemLabel">${DomUtils.escapeHtml(r.full_name)}</span>
            ${r.full_name === selected
              ? `${this._ico_('check', 'qc__gh-ddCheck')}` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">${DomUtils.escapeHtml(DomUtils.t('edGhNoMatches', 'No matches'))}</div>`;
  },

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
               data-branch="${DomUtils.escapeHtml(b.name)}">
            ${this._ico_('branch')}
            <span class="qc__gh-ddItemLabel">${DomUtils.escapeHtml(b.name)}</span>
            ${b.name === selected
              ? `${this._ico_('check', 'qc__gh-ddCheck')}` : ''}
          </div>
        `).join('')
      : `<div class="qc__gh-ddEmpty">${DomUtils.escapeHtml(DomUtils.t('edGhNoMatches', 'No matches'))}</div>`;
  },

  /** Cablea los items del dropdown de repos para que disparen el cambio. @private */
  _wireRepoItems_() {
    this.shadowRoot.querySelectorAll('[data-repo]').forEach((el) => {
      el.addEventListener('click', () => this._onRepoChange_(el.dataset.repo));
    });
  },

  /** Cablea los items del dropdown de branches para que disparen el cambio. @private */
  _wireBranchItems_() {
    this.shadowRoot.querySelectorAll('[data-branch]').forEach((el) => {
      el.addEventListener('click', () => this._onBranchChange_(el.dataset.branch));
    });
  },

  /**
   * @returns {boolean} `true` si la branch activa es la default del repo.
   * @private
   */
  _isDefaultBranch_() {
    if (!this._project?.repo || !this._project?.branch) return false;
    const r = this._repos.find((x) => x.full_name === this._project.repo);
    return r?.default_branch === this._project.branch;
  },

  /** Pinta el body de la tab activa (Changes o Diff). @private */
  _renderTabBody_() {
    const wrap = this.shadowRoot.getElementById('ghTabBody');
    if (!wrap) return;

    if (this._activeTab === 'changes') {
      this._renderChangesTab_(wrap);
    } else {
      this._renderDiffTab_(wrap);
    }
  },

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
          ${DomUtils.escapeHtml(DomUtils.t('edGhSelectRepoBranchChanges', 'Select a repository and branch to see changes.'))}
        </div>
      `);
      return;
    }

    if (this._loadingDiff) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-hint" style="text-align:center; padding:20px">
          <span class="qc__gh-spinner"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhComparing', 'Comparing with repository…'))}
        </div>
      `);
      return;
    }

    const items = this._diffItems.filter((i) => i.status !== 'eq');
    if (!items.length) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          ${this._ico_('success', 'qc__gh-icoOk qc__gh-icoXl')}
          <div style="margin-top:8px">${DomUtils.escapeHtml(DomUtils.t('edGhNoPendingChanges', 'No pending changes'))}</div>
        </div>
      `);
      return;
    }

    const selectable = items.filter((i) => !i.unavailable);
    const total = items.length;
    const selected = this._countSelectedFiles_();
    const allSelected = selectable.length > 0 && selected === selectable.length;

    DomUtils.setHTML(wrap, `
      ${this._baseNoticeHtml_()}
      <div class="qc__gh-changesCard">
        <div class="qc__gh-changesHead">
          <button class="qc__gh-selectAll ${allSelected ? 'qc__gh-selected' : ''}" id="ghSelectAll">
            <span class="qc__gh-check">
              ${this._ico_('check')}
            </span>
            ${DomUtils.escapeHtml(DomUtils.t('edGhSelectAll', 'Select all'))}
          </button>
          <span>${DomUtils.escapeHtml(DomUtils.t('edGhSelectedCount', '$1 of $2 selected', selected, total))}</span>
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
        selectable.forEach((i) => this._selectedFiles.add(i.path));
      }
      this._renderTabBody_();
      this._refreshFooterButtons_();
    });

    wrap.querySelectorAll('.qc__gh-changeItem').forEach((el) => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        if (el.classList.contains('qc__gh-unavailable')) return;
        if (this._selectedFiles.has(path)) this._selectedFiles.delete(path);
        else this._selectedFiles.add(path);
        this._renderTabBody_();
        this._refreshFooterButtons_();
      });
    });
  },

  /**
   * Devuelve el HTML de una fila de la lista de cambios (con su origen y `+x −y`).
   * @param {{path:string,status:string,origin:string,plus:number,minus:number}} item
   * @returns {string}
   * @private
   */
  _renderChangeRow_(item) {
    const isSelected = this._selectedFiles.has(item.path);
    const cls = `${isSelected ? 'qc__gh-selected' : ''} ${item.unavailable ? 'qc__gh-unavailable' : ''}`;

    return `
      <div class="qc__gh-changeItem ${cls}" data-path="${DomUtils.escapeHtml(item.path)}" title="${DomUtils.escapeHtml(item.path)}">
        <span class="qc__gh-check">${this._ico_('check')}</span>
        ${this._statusMarkHtml_(item)}
        <span class="qc__gh-changePath">${this._pathHtml_(item.path)}</span>
        ${this._renderDiffOriginBadge_(item)}
        ${this._deltaHtml_(item)}
      </div>
    `;
  },

  /** Pinta el footer (Pull/Push) según el estado actual. @private */
  _renderFooter_(footer) {
    const project = this._project;
    const enabled = !!(project?.repo && project?.branch);
    const selectedCount = this._countSelectedFiles_();
    const hasMessage = (this._commitMessage || '').trim().length > 0;
    const busy = this._pushing || this._pulling;
    const loading = !!this._loadingDiff;
    const pullRequired = !loading && this._pullRequired_();
    const canPush = enabled && selectedCount > 0 && hasMessage && !busy && !loading && !pullRequired;
    const canPull = enabled && !busy && !loading;

    const pullLabel = this._pulling
      ? `<span class="qc__gh-spinner qc__gh-spinnerOnDark"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhPulling', 'Pulling…'))}`
      : `${this._ico_('cloudDownload')} ${DomUtils.escapeHtml(DomUtils.t('edGhPull', 'Pull'))}`;

    const pushLabel = this._pushing
      ? `<span class="qc__gh-spinner qc__gh-spinnerOnDark"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhPushing', 'Pushing…'))}`
      : `${this._ico_('cloudUpload')} ${DomUtils.escapeHtml(DomUtils.t('edGhPush', 'Push'))}${selectedCount ? ` (${selectedCount})` : ''}`;

    let hint = '';
    if (this._pushing)           hint = DomUtils.t('edGhHintSending', 'Sending changes to GitHub…');
    else if (this._pulling)      hint = DomUtils.t('edGhHintFetching', 'Fetching changes from GitHub…');
    else if (!enabled)           hint = DomUtils.t('edGhHintSelectRepoBranch', 'Select repo and branch');
    else if (pullRequired)       hint = DomUtils.t('edGhHintPullFirst', '⚠️ Pull remote changes before pushing to avoid conflicts');
    else if (selectedCount === 0) hint = DomUtils.t('edGhHintSelectFiles', 'Select files to push');
    hint = DomUtils.escapeHtml(hint);

    DomUtils.setHTML(footer, `
      ${pullRequired ? `
        <div class="qc__gh-pullWarning">
          ${this._ico_('warn')}
          <span>${DomUtils.escapeHtml(DomUtils.t('edGhRemoteHasChanges', 'The remote has changes. $1 to avoid conflicts.'))
            .split('$1').join(`<strong>${DomUtils.escapeHtml(DomUtils.t('edGhPullFirst', 'Pull first'))}</strong>`)}</span>
        </div>
      ` : ''}
      <div class="qc__gh-footerRow">
        <button id="ghPull" class="gt-btn qc__gh-btn ${pullRequired ? 'gt-btn--filled' : 'gt-btn--outlined'}" ${canPull ? '' : 'disabled'}>
          ${pullLabel}
        </button>
        <button id="ghPush" class="gt-btn gt-btn--filled qc__gh-btn" ${canPush ? '' : 'disabled'}>
          ${pushLabel}
        </button>
      </div>
      <div class="qc__gh-footerHint" id="ghFooterHint">${hint}</div>
    `);
    footer.style.display = 'block';

    footer.querySelector('#ghPull')?.addEventListener('click', () => this._pull_());
    footer.querySelector('#ghPush')?.addEventListener('click', () => this._push_());
  },

  /** Re-renderiza el footer si está visible (para reflejar cambios de estado). @private */
  _refreshFooterButtons_() {
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (footer && footer.style.display !== 'none') this._renderFooter_(footer);
  },

  /**
   * @returns {number} Cantidad de archivos modificados seleccionados para push.
   * @private
   */
  _countSelectedFiles_() {
    const items = this._diffItems.filter((i) => i.status !== 'eq');
    let count = 0;
    for (const it of items) if (!it.unavailable && this._selectedFiles.has(it.path)) count++;
    return count;
  },

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
  },

  /**
   * Compara GAS con GitHub y la base (`baseSha`) por SHA de blob y produce `_diffItems`.
   * Solo descarga los blobs que difieren; sin base, comparación de dos vías.
   * @private
   */
  async _recomputeDiff_() {
    // Generación monotónica: cualquier recálculo posterior (cambio de
    // repo/branch/basePath, refresh) invalida los resultados en vuelo.
    const gen = ++this._diffGen;
    const isStale_ = () => gen !== this._diffGen;
    this._recomputing = gen;
    // El visor muestra el diff anterior: sus decisiones ya no valdrían.
    this._closeDiffViewer_?.();
    const finish_ = () => { if (this._recomputing === gen) this._recomputing = null; };

    if (!this._project?.repo || !this._project?.branch) {
      finish_();
      this._loadingDiff = false;
      this._diffItems = [];
      this._selectedFiles.clear();
      this._renderTabBody_();
      this._refreshFooterButtons_();
      return;
    }

    this._loadingDiff = true;
    this._renderTabBody_();
    this._refreshFooterButtons_();

    // Snapshot de la configuración con la que se lanza la petición.
    const target = {
      repo:     this._project.repo,
      branch:   this._project.branch,
      basePath: this._project.basePath || '',
    };
    /** Termina el recálculo con error (lista vacía). */
    const fail = async (res) => {
      finish_();
      this._loadingDiff = false;
      if (await this._handleAuthError_(res)) return;
      this._log_(res?.error || DomUtils.t('edGhRemoteLoadFailed', 'Could not load remote repository'), 'error');
      this._diffItems = [];
      this._renderTabBody_();
      this._refreshFooterButtons_();
    };

    const res = await this._ghApi_('FETCH_TREE', { ...target, baseSha: this._project.baseSha || null },
      { timeoutMs: 2 * 60 * 1000 });
    if (isStale_()) return;
    if (!res?.ok) return fail(res);

    const tree = res.data || {};
    // Extensiones de GAS; los blobs > 1 MB quedan como "no disponibles".
    const toMap = (list) => new Map((list || [])
      .filter((f) => this._isSyncablePath_(f.path))
      .map((f) => [f.path, (f.size || 0) > 1_000_000 ? { sha: f.sha, tooLarge: true } : { sha: f.sha }]));
    const remote = toMap(tree.files);
    const base = tree.baseFiles ? toMap(tree.baseFiles) : null;

    // Mientras esté vigente el snapshot post-push, lo superponemos al
    // remoto para enmascarar el lag del CDN de GitHub.
    const snap = this._postPushSnapshot;
    if (snap
        && Date.now() < snap.expiresAt
        && snap.repo     === target.repo
        && snap.branch   === target.branch
        && (snap.basePath || '') === target.basePath) {
      for (const [path, entry] of snap.files) remote.set(path, { sha: entry.sha, content: entry.content });
    } else if (snap && Date.now() >= snap.expiresAt) {
      this._postPushSnapshot = null;
    }

    const localFiles = await this._collectLocalFiles_();
    if (isStale_()) return;
    if (!localFiles) {
      // Sin snapshot de GAS no se compara: todo parecería borrado en GAS.
      finish_();
      this._loadingDiff = false;
      this._diffItems = [];
      this._renderTabBody_();
      this._refreshFooterButtons_();
      return;
    }
    const local = new Map(localFiles.map((f) => [f.path, f.content]));

    if (remote.size === 0 && local.size > 0) {
      console.warn(
        `[gas-github-panel] Remote returned 0 files but local has ${local.size}.`,
        {
          repo:       target.repo,
          branch:     target.branch,
          basePath:   target.basePath || '(none)',
          rawCount:   (tree.files || []).length,
          firstLocal: [...local.keys()].slice(0, 5),
        },
      );
    }

    let items;
    try {
      items = await this._buildDiffItems_({
        local, remote, base,
        fetchBlobs: (shas) => this._fetchBlobs_(target.repo, shas),
        remoteIncomplete: !!tree.incomplete,
        baseIncomplete: !!tree.baseIncomplete,
      });
    } catch (err) {
      if (isStale_()) return;
      return fail({ ok: false, error: String(err?.message || err) });
    }
    if (isStale_()) return;
    finish_();

    this._loadingDiff = false;
    this._diffItems = items;
    // Las decisiones del visor solo valen para el mismo contenido de GAS y GitHub.
    this._pruneResolutions_();
    this._remoteCommitSha = tree.commitSha || null;
    this._diffBaseMissing = !!tree.baseMissing;
    this._treeIncomplete = !!(tree.incomplete || tree.baseIncomplete);
    this._diffFoldsOpen = null;
    // La base guardada ya no existe en GitHub (404/422): se olvida para no pedirla más.
    if (tree.baseMissing && this._project?.baseSha) {
      this._project = { ...this._project };
      delete this._project.baseSha;
      this._saveProjectConfig_(this._project);
    }

    this._selectedFiles = new Set(items.filter((i) => i.status !== 'eq' && !i.unavailable).map((i) => i.path));
    this._activeDiffPath = null;
    if (this._expandedDiffPaths) {
      const valid = new Set(items.map((i) => i.path));
      this._expandedDiffPaths = new Set(
        [...this._expandedDiffPaths].filter((p) => valid.has(p))
      );
    }

    this._renderTabBody_();
    this._refreshFooterButtons_();
    // Actualizar el contador de la pestaña con el conteo de cambios.
    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (body && footer) {
      // Re-render para que el (n) en la tab refleje los Changes.
      this._renderConnectedView_(body, footer);
    }
  },

  /**
   * Descarga blobs por SHA en el background (`FETCH_BLOBS`, concurrencia 6).
   * @param {string} repo `owner/repo`.
   * @param {string[]} shas SHAs a descargar.
   * @returns {Promise<Map<string,string>>} SHA → contenido.
   * @throws {Error} Si la llamada falla.
   * @private
   */
  async _fetchBlobs_(repo, shas) {
    const out = new Map();
    if (!shas.length) return out;
    const res = await this._ghApi_('FETCH_BLOBS', { repo, shas }, { timeoutMs: 5 * 60 * 1000 });
    if (!res?.ok) throw new Error(res?.error || DomUtils.t('edGhRemoteLoadFailed', 'Could not load remote repository'));
    for (const [sha, content] of Object.entries(res.data?.blobs || {})) out.set(sha, content);
    return out;
  },

  /**
   * Indica si un path está soportado para sincronización (push/pull/diff).
   * Solo incluimos extensiones que GAS exporta nativamente.
   * @param {string} path
   * @returns {boolean}
   * @private
   */
  _isSyncablePath_(path) {
    return /\.(gs|html|json)$/i.test(String(path || ''));
  },

  /**
   * Devuelve los archivos del proyecto GAS leídos desde la Apps Script
   * API (fuente de verdad). El panel solo entra a la vista 'connected'
   * cuando hay sesión Google activa, así que la API siempre debería
   * estar disponible aquí. Si falla el caller decide
   * cómo seguir (toast/error ya se mostró en `_fetchProjectFromApi_`).
   * Devuelve `null` en ese caso.
   *
   * @returns {Promise<Array<{path:string, content:string, name:string, type:string}>|null>} `null` si la API falla.
   * @private
   */
  async _collectLocalFiles_() {
    const apiFiles = await this._fetchProjectFromApi_();
    if (!apiFiles) return null;
    return apiFiles
      .filter((f) => this._isSyncablePath_(f.path))
      .map((f) => ({
        path:    f.path,
        content: f.source || '',
        name:    f.name,
        type:    f.type,
      }));
  },

  /**
   * Lee el contenido completo del proyecto GAS desde la Apps Script API
   * (GET /v1/projects/{scriptId}/content). Antes del GET fuerza un
   * Ctrl+S para que la API devuelva el snapshot al día; salta el save
   * cuando Monaco está marcado como stale (justo después de un pull
   * sin reload) para no sobrescribir los archivos recién traídos.
   *
   * @returns {Promise<Array<{path:string,content:string,name:string,type:string}>|null>}
   *   `null` si no hay sesión Google activa o falla la llamada.
   * @private
   */
  async _fetchProjectFromApi_() {
    if (!this._googleUser || !this._scriptId) return null;

    if (!this._monacoStale) {
      this._triggerGasSave_();
      await new Promise((r) => setTimeout(r, 350));
    }

    const res = await this._ggApi_('GET_CONTENT', { scriptId: this._scriptId });
    if (!res?.ok || !res.data) {
      const msg = String(res?.error || '');
      if (/\b(401|403)\b/.test(msg)) {
        this._googleUser = null;
        this._view = 'unauth';
        this._renderHeader_();
        this._renderBody_();
        this._toast_(DomUtils.t('edGhGoogleSessionExpired', 'Google session expired. Please sign in again.'), 'error', 5000);
      } else if (msg) {
        this._log_(msg, 'error');
      }
      return null;
    }
    return res.data.files || [];
  },

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
      const msg = String(res?.error || DomUtils.t('edGhWriteContentFailed', 'Could not write project content'));
      if (/\b(401|403)\b/.test(msg)) {
        this._googleUser = null;
        this._toast_(DomUtils.t('edGhGoogleSessionExpired', 'Google session expired. Please sign in again.'), 'error', 5000);
      } else {
        this._toast_(msg, 'error', 6000);
      }
      return false;
    }
    return true;
  },

  /**
   * Devuelve el `type` que la Apps Script API espera para una ruta
   * dada (extensión `.gs`/`.js` → `SERVER_JS`, `.html` → `HTML`,
   * `.json` → `JSON`). Devuelve `null` si la extensión no es soportada.
   *
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
  },

  /**
   * Convierte un path estilo filesystem en el `name` que la Apps
   * Script API guarda. GAS no soporta carpetas reales: emula la
   * jerarquía permitiendo `/` dentro del nombre. Normalizamos para
   * que separadores `\` (Windows), `//` repetidos, y `/` al inicio o
   * final no rompan el formato esperado por la API.
   *
   * @param {string} path
   * @returns {string}
   * @private
   */
  _pathToScriptName_(path) {
    return String(path || '')
      .replace(/\\/g, '/')
      .replace(/\.(gs|js|html|json)$/i, '')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
  },

  /**
   * Valida un `name` ya normalizado contra las restricciones que la
   * Apps Script API impone. Sin esto un archivo con caracteres
   * inválidos pasa al PUT y la API rechaza la operación entera, no
   * solo el archivo problemático.
   *
   * Reglas combinadas (UI del IDE + experiencia con la API):
   *   - No vacío y ≤ 100 caracteres por segmento.
   *   - Cada segmento permite letras, dígitos, guiones, guion bajo,
   *     punto y espacios. Los demás caracteres rompen la validación.
   *   - Sin segmentos vacíos (`a//b`) ni segmentos `.` o `..`.
   *
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  _isValidGasName_(name) {
    const s = String(name || '');
    if (!s || s.length > 1024) return false;
    const segs = s.split('/');
    if (segs.length > 16) return false;
    return segs.every((seg) =>
      seg.length > 0 && seg.length <= 100 &&
      seg !== '.' && seg !== '..' &&
      /^[A-Za-z0-9 _.\-]+$/.test(seg),
    );
  },

  /**
   * Maneja el cambio de repo en el dropdown. Persiste la selección,
   * carga las branches y dispara el cómputo de diff.
   * @param {string} fullName  `owner/repo` o cadena vacía para limpiar.
   * @private
   */
  async _onRepoChange_(fullName) {
    if (this.isBusy()) { this._warnBusy_(); return; }
    this._pushBlobCache = null;
    if (!fullName) {
      this._project = null;
      // Invalida diff/branches en vuelo del repo anterior.
      this._diffGen++;
      this._branchesGen++;
      this._loadingDiff = false;
      this._loadingBranches = false;
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

    // Re-elegir el mismo repo no cambia nada (conserva rama y base).
    if (fullName === this._project?.repo) {
      this._openDropdown = '';
      const b = this.shadowRoot.getElementById('ghBody');
      const f = this.shadowRoot.getElementById('ghFooter');
      if (b && f) this._renderConnectedView_(b, f);
      return;
    }
    this._resolutions?.clear();
    const repo = this._repos.find((r) => r.full_name === fullName);
    const branch = repo?.default_branch || 'main';
    this._project = {
      repo:     fullName,
      branch,
      basePath: this._project?.basePath || '',
    };
    const project = this._project;
    await this._saveProjectConfig_(project);
    // Otro cambio de selección ocurrió durante el guardado: él manda.
    if (this._project !== project) return;
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
  },

  /**
   * Maneja el cambio de branch. Persiste la selección y recalcula diff.
   * @param {string} branchName
   * @private
   */
  async _onBranchChange_(branchName) {
    if (!this._project) return;
    if (this.isBusy()) { this._warnBusy_(); return; }
    this._pushBlobCache = null;
    // La base de sincronización es de la rama anterior: se descarta, igual que el diff.
    this._project = { ...this._project, branch: branchName };
    delete this._project.baseSha;
    this._invalidateDiff_();
    this._openDropdown = '';
    const project = this._project;
    await this._saveProjectConfig_(project);
    if (this._project !== project) return;
    this._updateAnchorBadge_();

    const body = this.shadowRoot.getElementById('ghBody');
    const footer = this.shadowRoot.getElementById('ghFooter');
    if (body && footer) this._renderConnectedView_(body, footer);

    this._recomputeDiff_();
  },

  /**
   * Maneja el cambio de sub-folder dentro del repo.
   * @param {string} value
   * @private
   */
  async _onBasePathChange_(value) {
    if (!this._project) return;
    if (this.isBusy()) { this._warnBusy_(); return; }
    this._pushBlobCache = null;
    this._project = { ...this._project, basePath: (value || '').trim() };
    delete this._project.baseSha;
    this._invalidateDiff_();
    const project = this._project;
    await this._saveProjectConfig_(project);
    if (this._project !== project) return;
    this._recomputeDiff_();
  },

  /**
   * Descarta el diff vigente y cualquier recálculo en vuelo (cambio de rama o subcarpeta).
   * @private
   */
  _invalidateDiff_() {
    this._closeDiffViewer_?.();
    this._diffGen++;
    this._resolutions?.clear();
    this._recomputing = null;
    this._diffItems = [];
    this._selectedFiles.clear();
    this._remoteCommitSha = null;
    this._expandedDiffPaths = null;
    this._diffFoldsOpen = null;
  },

  /**
   * Invalida un recálculo en vuelo antes de push/pull (sus resultados pisarían los nuevos).
   * @returns {boolean} `true` si había uno en curso (se relanza al terminar).
   * @private
   */
  _interruptRecompute_() {
    const was = this._recomputing != null;
    this._diffGen++;
    this._recomputing = null;
    return was;
  },

  /**
   * Persiste el binding del scriptId actual con la config de proyecto.
   * @param {{repo:string,branch:string,basePath:string,baseSha?:string}|null} config
   * @private
   */
  async _saveProjectConfig_(config) {
    if (!this._scriptId) return;
    await this._bridgeCall_('GAS_GH_SAVE_PROJECT', {
      scriptId: this._scriptId, config,
    });
  },

  /**
   * Sube los archivos seleccionados al repo activo. Fuerza Ctrl+S
   * sobre Monaco antes de leer el snapshot vía Apps Script API para
   * que la subida refleje cambios sin guardar. Al terminar OK limpia
   * selección, commit y diff.
   * @private
   */
  async _push_() {
    if (!this._project || this._pushing || this._pulling) return;
    if (this._loadingDiff || this._pullRequired_()) {
      return this._toast_(this._loadingDiff
        ? DomUtils.t('edGhWaitDiff', 'Wait for the comparison with GitHub to finish.')
        : DomUtils.t('edGhHintPullFirst', '⚠️ Pull remote changes before pushing to avoid conflicts'), 'info', 4000);
    }

    const message = (this._commitMessage || '').trim();
    if (!message) return this._toast_(DomUtils.t('edGhWriteCommitMsg', 'Write a commit message'), 'error');
    if (!this._selectedFiles.size) return this._toast_(DomUtils.t('edGhNoFilesSelected', 'No files selected'), 'error');

    const resumeRecompute = this._interruptRecompute_();
    let recomputeAfter = resumeRecompute;
    this._pushing = true;
    this._lockTab_();
    this._refreshFooterButtons_();
    this._setBodyBusy_(true);
    this._toast_(DomUtils.t('edGhPreparingPush', 'Saving GAS and preparing push…'), 'info', 1800);
    try {
      recomputeAfter = await this._pushInner_(message) || resumeRecompute;
    } finally {
      if (recomputeAfter) this._recomputeDiff_();
    }
  },

  /**
   * Cuerpo del push (ver `_push_`).
   * @param {string} message Mensaje del commit.
   * @returns {Promise<boolean>} `true` si conviene recalcular el diff al terminar.
   * @private
   */
  async _pushInner_(message) {

    /** Termina la operación liberando la UI y opcionalmente avisando al usuario. */
    const abort = (toastMsg) => {
      this._pushing = false;
      this._unlockTab_();
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
      if (toastMsg) this._toast_(toastMsg, 'error');
    };

    // Save explícito antes de leer: la API lee del storage de GAS, no
    // de Monaco. Sin esto se podrían subir cambios sin guardar.
    this._triggerGasSave_();
    await new Promise((r) => setTimeout(r, 600));

    const apiFiles = await this._fetchProjectFromApi_();
    if (!apiFiles) return abort();

    const unavailable = new Set(this._diffItems.filter((i) => i.unavailable).map((i) => i.path));
    const selectedFiles = apiFiles.filter((f) => this._selectedFiles.has(f.path) && !unavailable.has(f.path));
    if (!selectedFiles.length) return abort(DomUtils.t('edGhNoFilesSelected', 'No files selected'));

    // Saneo de paths: normaliza separadores y descarta los que tienen
    // caracteres no aceptados por Git/Windows (`:*?"<>|`) o segmentos
    // vacíos. GAS emula carpetas con `/` dentro del nombre.
    const sanitizePath = (p) => String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const isPushablePath = (p) =>
      !!p && p.length <= 1024 &&
      !/[:*?"<>|]/.test(p) &&
      !p.split('/').some((seg) => !seg || seg === '.' || seg === '..');

    const sanitizedFiles = [];
    const droppedPaths = [];
    for (const f of selectedFiles) {
      const path = sanitizePath(f.path);
      if (!isPushablePath(path)) { droppedPaths.push(f.path); continue; }
      sanitizedFiles.push({ ...f, path });
    }
    if (droppedPaths.length) {
      this._toast_(
        DomUtils.t('edGhSkippedInvalidPath', '$1 file(s) skipped due to invalid path: $2',
          droppedPaths.length,
          droppedPaths.slice(0, 3).join(', ') + (droppedPaths.length > 3 ? '…' : '')),
        'error', 6000,
      );
      console.warn('[gas-github-panel] Invalid paths skipped:', droppedPaths);
    }
    if (!sanitizedFiles.length) return abort();

    this._openProgress_({
      kind:  'push',
      title: DomUtils.t('edGhProgressPushing', 'Pushing to $1', `${this._project.repo}@${this._project.branch}`),
      files: sanitizedFiles,
    });
    this._setProgressPhase_('snapshot', 'done',
      { hint: DomUtils.t('edGhFilesReadFromProject', '$1 file(s) read from the project.', apiFiles.length) });
    this._setProgressPhase_('blobs', 'active',
      { meta: DomUtils.t('edGhFilesProgress', '$1/$2 files', 0, sanitizedFiles.length),
        files: sanitizedFiles.map((f) => ({ path: f.path, status: 'pending' })) });

    // Inicializa o reutiliza la cache de blobs si seguimos en el mismo
    // repo/branch/basePath. Eso permite que un reintento tras un error
    // intermedio salte los blobs ya subidos sin gastar cuota.
    const projKey = {
      repo:     this._project.repo,
      branch:   this._project.branch,
      basePath: this._project.basePath || '',
    };
    const same = this._pushBlobCache
      && this._pushBlobCache.repo     === projKey.repo
      && this._pushBlobCache.branch   === projKey.branch
      && this._pushBlobCache.basePath === projKey.basePath;
    if (!same) {
      this._pushBlobCache = { ...projKey, blobs: new Map() };
    }
    const existingBlobs = Object.fromEntries(this._pushBlobCache.blobs);

    let res;
    try {
      // Timeout dinámico según el tamaño del push: 60 s base + 1.5 s
      // por archivo, con un techo de 30 min. Cubre repos grandes con
      // reintentos por rate limit sin que el bridge corte la promesa
      // mientras los blobs aún están subiéndose.
      const pushTimeoutMs = Math.min(
        60000 + sanitizedFiles.length * 1500,
        30 * 60 * 1000,
      );
      res = await this._ghApi_('PUSH_FILES', {
        repo:     this._project.repo,
        branch:   this._project.branch,
        basePath: this._project.basePath || '',
        files:    sanitizedFiles.map((f) => ({
          path:    f.path,
          // Normaliza saltos de línea y asegura un único `\n` final
          // para que el diff vea `eq` después del push.
          content: String(f.source ?? '').replace(/\r\n?/g, '\n').replace(/\n?$/, '\n'),
        })),
        message,
        existingBlobs,
        // Commit con el que se calculó el diff: si la rama avanzó tocando estos archivos, se rechaza.
        expectedParentSha: this._remoteCommitSha || null,
      }, { timeoutMs: pushTimeoutMs });
    } finally {
      this._pushing = false;
      this._unlockTab_();
    }

    // El background devuelve `uploadedBlobs` también en errores (ver
    // el handler GITHUB_API_CALL); los volcamos a la cache para el
    // siguiente intento.
    if (res?.uploadedBlobs && this._pushBlobCache) {
      for (const [path, sha] of Object.entries(res.uploadedBlobs)) {
        this._pushBlobCache.blobs.set(path, sha);
      }
    }

    if (res?.ok) {
      const sha = (res.data?.commitSha || '').slice(0, 7);

      this._setProgressPhase_('blobs',  'done');
      this._setProgressPhase_('tree',   'done');
      this._setProgressPhase_('commit', 'done', { hint: `commit ${sha}` });
      this._setProgressPhase_('ref',    'done');
      this._finishProgress_({
        success: true,
        title:   DomUtils.t('edGhPushedFiles', 'Pushed $1 file(s) · commit $2', sanitizedFiles.length, sha),
      });

      // Push completo: descartamos la cache para que un push posterior
      // arranque limpio y suba blobs frescos.
      this._pushBlobCache = null;

      // Snapshot post-push: GitHub propaga el commit al CDN con 1-3 s
      // de latencia. Si el usuario reabre el panel en ese intervalo
      // FETCH_TREE puede devolver el árbol viejo. Mientras el TTL no expire
      // `_recomputeDiff_` superpone el contenido (y SHA) recién subidos.
      const pushedByPath = new Map();
      for (const f of sanitizedFiles) {
        const content = this._pushForm_(f.source);
        pushedByPath.set(f.path, { content, sha: await this._gitBlobSha_(content) });
      }

      this._postPushSnapshot = {
        expiresAt: Date.now() + 15000,
        repo:      this._project.repo,
        branch:    this._project.branch,
        basePath:  this._project.basePath || '',
        files:     pushedByPath,
      };

      // Base nueva: el commit recién creado, si no deja cambios de GitHub sin traer.
      const commitSha = res.data?.commitSha || null;
      const parentSha = res.data?.parentSha ?? null;
      const nextBase = this._nextBaseAfterPush_({ commitSha, parentSha, pushedPaths: new Set(pushedByPath.keys()) });
      const parentMatched = parentSha === this._remoteCommitSha;
      this._remoteCommitSha = parentMatched ? commitSha : null;

      this._diffItems = this._diffItems.map((it) => {
        if (!pushedByPath.has(it.path)) return it;
        const next = this._normContent_(pushedByPath.get(it.path).content);
        return {
          path:   it.path,
          status: 'eq',
          origin: null,
          local:  next,
          remote: next,
          plus:   0,
          minus:  0,
        };
      });
      if (nextBase) await this._commitBaseSha_(nextBase);

      this._commitMessage = '';
      this._selectedFiles.clear();
      this._expandedDiffPaths = null;
      this._activeTab = 'changes';

      const body = this.shadowRoot.getElementById('ghBody');
      const footer = this.shadowRoot.getElementById('ghFooter');
      if (body && footer) this._renderConnectedView_(body, footer);

      this._setBodyBusy_(false);
      this._toast_(DomUtils.t('edGhPushSuccess', 'Push successful · commit $1', sha), 'ok');
      // La rama tenía commits que no se compararon (sin tocar estos archivos): recalcular.
      return !parentMatched;
    } else if (await this._handleAuthError_(res)) {
      this._setBodyBusy_(false);
      this._closeProgress_();
    } else {
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
      const raw = String(res?.error || DomUtils.t('edGhPushFailed', 'Push failed'));
      let userMsg;
      let branchChanged = false;
      if (/secondary rate limit|abuse detection|exceeded.*rate limit/i.test(raw)) {
        userMsg = DomUtils.t('edGhRateLimit', 'GitHub rate limit reached. Wait 1–2 minutes and retry — already-uploaded files will be reused.');
      } else if (/GH_BRANCH_CHANGED/.test(raw)) {
        userMsg = DomUtils.t('edGhBranchChanged', 'The branch changed on GitHub. The diff will be recomputed; review it and push again.');
        branchChanged = true;
      } else if (/not a fast forward/i.test(raw)) {
        userMsg = DomUtils.t('edGhNotFastForward', 'Branch was updated remotely. Pull first to merge changes.');
      } else {
        userMsg = raw;
      }
      const cachedCount = this._pushBlobCache?.blobs?.size || 0;
      const hint = cachedCount
        ? DomUtils.t('edGhBlobsCached', '$1 blob(s) already uploaded — retry will resume from there.', cachedCount)
        : '';
      this._finishProgress_({
        success: false,
        title:   DomUtils.t('edGhPushFailed', 'Push failed'),
        meta:    hint ? `${userMsg} · ${hint}` : userMsg,
      });
      this._toast_(userMsg, 'error', 6000);
      return branchChanged;
    }
    return false;
  },

  /**
   * Pide confirmación al usuario y aplica los cambios remotos al
   * proyecto GAS vía Apps Script API. Crea archivos nuevos, sobrescribe
   * los modificados y preserva los locales que no estén en el repo.
   * Por defecto recarga la pestaña para que Monaco muestre el contenido
   * nuevo (la API edita el storage, no Monaco).
   * @private
   */
  async _pull_() {
    if (!this._project || this._pushing || this._pulling) return;
    if (this._loadingDiff) {
      return this._toast_(DomUtils.t('edGhWaitDiff', 'Wait for the comparison with GitHub to finish.'), 'info', 4000);
    }

    if (!this._diffItems.length) await this._recomputeDiff_();
    if (this._loadingDiff) return;

    const all = this._diffItems.filter((i) => i.status !== 'eq');
    if (!all.length) return this._toast_(DomUtils.t('edGhUpToDate', 'Everything is up to date'), 'ok');

    // Candidatos: lo que existe en GitHub (los 'add' solo están en GAS y el pull no los toca).
    const candidates = all.filter((i) => i.status !== 'add');
    const localOnly  = all.filter((i) => i.status === 'add');
    if (!candidates.length) {
      this._toast_(DomUtils.t('edGhAllLocalOnly', 'All changes are local only. Use Push instead.'), 'info', 4000);
      return;
    }

    const pullResult = await this._showPullConfirm_({
      files:           candidates,
      reloadAvailable: true,
      localOnlyCount:  localOnly.length,
    });
    if (!pullResult.confirmed) return;
    const { apply: items, left } = this._pullPlan_(candidates, new Set(pullResult.selected || []));
    if (!items.length) {
      this._toast_(DomUtils.t('edGhNothingToApply', 'Nothing to apply'), 'info', 3000);
      return;
    }
    const resumeRecompute = this._interruptRecompute_();

    this._pulling = true;
    this._lockTab_();
    this._refreshFooterButtons_();
    this._setBodyBusy_(true);

    // Lista de archivos que efectivamente se van a aplicar al pull
    // (excluye los 'add' locales que no se tocan).
    const incoming = items.filter((i) => i.status !== 'add');
    this._openProgress_({
      kind:  'pull',
      title: DomUtils.t('edGhProgressPulling', 'Pulling from $1', `${this._project.repo}@${this._project.branch}`),
      files: incoming,
    });
    // Las dos primeras fases ya las hizo el FETCH_TREE previo (que
    // ocurrió al recomputar el diff antes de mostrar el modal).
    this._setProgressPhase_('tree',  'done');
    this._setProgressPhase_('blobs', 'done',
      { hint: DomUtils.t('edGhFilesDownloaded', '$1 file(s) downloaded.', incoming.length) });
    this._setProgressPhase_('merge', 'active',
      { meta: DomUtils.t('edGhFilesProgress', '$1/$2 files', 0, incoming.length),
        files: incoming.map((i) => ({ path: i.path, status: 'pending' })) });

    const pulledFrom = this._remoteCommitSha;
    try {
      const { applied, skipped } = await this._pullWithApi_(items);

      this._selectedFiles.clear();
      this._commitMessage = '';
      this._expandedDiffPaths = null;

      // Pull aplicado: la base pasa a ser el commit remoto comparado (antes del reload),
      // salvo que quede algo de GitHub sin traer (no elegido, sin resolver o fallido).
      const baseSafe = !this._treeIncomplete && !skipped.length && this._pullLeavesBaseSafe_([...left, ...localOnly]);
      if (applied && pulledFrom && baseSafe) await this._commitBaseSha_(pulledFrom);
      if (!pullResult.reload || resumeRecompute) await this._recomputeDiff_();

      if (applied) {
        this._finishProgress_({
          success: true,
          title:   pullResult.reload
            ? DomUtils.t('edGhPulledFilesReloading', 'Pulled $1 file(s) · reloading…', applied)
            : DomUtils.t('edGhPulledFiles', 'Pulled $1 file(s)', applied),
        });
        if (pullResult.reload) {
          this._toast_(DomUtils.t('edGhAppliedReloading', '$1 file(s) applied. Reloading GAS…', applied), 'ok', 1500);
          setTimeout(() => {
            try { window.top.location.reload(); }
            catch (_) { window.location.reload(); }
          }, 800);
          return;
        }
        this._toast_(
          DomUtils.t('edGhAppliedViaApi', '$1 file(s) applied via Apps Script API. Reload GAS to see them in the editor.', applied),
          'ok', 6000,
        );
      } else if (skipped.length) {
        this._closeProgress_();
        this._toast_(
          DomUtils.t('edGhSkippedLocalOnly', '$1 file(s) skipped (local only — use Push for these).', skipped.length),
          'info', 5000,
        );
      } else {
        this._closeProgress_();
      }
    } catch (err) {
      this._finishProgress_({
        success: false,
        title:   DomUtils.t('edGhPullFailed', 'Pull failed'),
        meta:    err?.message || String(err),
      });
      throw err;
    } finally {
      this._pulling = false;
      this._unlockTab_();
      this._setBodyBusy_(false);
      this._refreshFooterButtons_();
    }
  },

  /**
   * Aplica los cambios del diff sobre el proyecto GAS usando la Apps
   * Script API. Trae el snapshot actual, fusiona los cambios remotos
   * (`mod` y `del` → reemplaza/crea) y reescribe todo el proyecto en un
   * único PUT atómico. Los archivos `add` (solo locales) se preservan.
   *
   * @param {Array} items  Items del diff (sin 'eq').
   * @returns {Promise<{applied:number, skipped:string[]}>}
   * @private
   */
  async _pullWithApi_(items) {
    const localFiles = await this._fetchProjectFromApi_();
    if (!localFiles) return { applied: 0, skipped: items.map((i) => i.path) };

    const byPath = new Map(localFiles.map((f) => [f.path, { ...f }]));
    const skipped = [];
    const stale = [];
    const appliedDetails = [];
    let applied = 0;

    let i = 0;
    for (const it of items) {
      i++;
      if (it.status === 'add') {
        skipped.push(it.path);
        this._markProgressFile_('merge', it.path, 'reused',
          { done: i, total: items.length });
        if (i % 25 === 0) await this._yieldToUi_();
        continue;
      }

      const type = this._pathToScriptType_(it.path);
      const name = this._pathToScriptName_(it.path);
      if (!type || !name || !this._isValidGasName_(name) || this._isUnsafeRemotePath_(it.path) || it.unavailable) {
        skipped.push(it.path);
        this._markProgressFile_('merge', it.path, 'error',
          { done: i, total: items.length });
        if (i % 25 === 0) await this._yieldToUi_();
        continue;
      }

      // GAS cambió después de calcular el diff: traerlo pisaría trabajo no revisado.
      const fresh = byPath.get(it.path);
      const nowInGas = fresh ? this._normContent_(fresh.source ?? '') : null;
      const seenInGas = it.status === 'del' ? null : (it.local ?? '');
      if (nowInGas !== seenInGas) {
        skipped.push(it.path);
        stale.push(it.path);
        this._markProgressFile_('merge', it.path, 'error', { done: i, total: items.length });
        if (i % 25 === 0) await this._yieldToUi_();
        continue;
      }

      // Resultado editado en el visor o, si no, el contenido remoto tal cual (con su salto final).
      byPath.set(it.path, { path: it.path, name, type, source: this._pullContent_(it) });
      const slash = name.lastIndexOf('/');
      appliedDetails.push({
        path:    it.path,
        gasName: name,
        type,
        action:  it.status === 'mod' ? 'overwrite' : 'create',
        folder:  slash >= 0 ? name.slice(0, slash) : '(root)',
      });
      applied++;
      this._markProgressFile_('merge', it.path, 'done',
        { done: i, total: items.length });
      if (i % 25 === 0) await this._yieldToUi_();
    }
    if (stale.length) {
      this._toast_(DomUtils.t('edGhPullStale', '$1 file(s) changed in GAS after the comparison and were not pulled: $2. Refresh the diff.',
        stale.length, stale.slice(0, 3).join(', ') + (stale.length > 3 ? '…' : '')), 'warn', 8000);
    }
    this._setProgressPhase_('merge', 'done',
      { hint: DomUtils.t('edGhMergedSkipped', '$1 merged, $2 skipped.', applied, skipped.length) });

    const repoLabel = this._project
      ? `${this._project.repo}@${this._project.branch}` : '(no project)';
    console.groupCollapsed(
      `[gas-github-panel] Pull ${repoLabel} · ${applied} file(s)` +
      (skipped.length ? `, ${skipped.length} skipped` : ''),
    );
    if (appliedDetails.length) console.table(appliedDetails);
    if (skipped.length) console.debug('Skipped:', skipped);
    console.groupEnd();

    if (!applied) return { applied: 0, skipped };

    const finalFiles = [...byPath.values()].map((f) => ({
      name:   f.name || this._pathToScriptName_(f.path),
      type:   f.type || this._pathToScriptType_(f.path),
      source: f.source ?? '',
    }));

    // Defensa contra pérdidas de archivos: nunca reducir el set final
    // por debajo del snapshot local actual.
    if (finalFiles.length < localFiles.length) {
      this._toast_(
        DomUtils.t('edGhAbortMismatch', 'Aborted: internal mismatch while building the file set. Nothing was written.'),
        'error', 6000,
      );
      console.warn('[gas-github-panel] _pullWithApi_ abort: finalFiles<localFiles',
        { final: finalFiles.length, local: localFiles.length });
      return { applied: 0, skipped: items.map((i) => i.path) };
    }

    this._setProgressPhase_('apply', 'active',
      { hint: DomUtils.t('edGhSendingToApi', 'Sending $1 file(s) to Apps Script API…', finalFiles.length) });

    const ok = await this._pushProjectToApi_(finalFiles);
    if (!ok) {
      this._setProgressPhase_('apply', 'error');
      return { applied: 0, skipped: items.map((i) => i.path) };
    }
    this._setProgressPhase_('apply', 'done',
      { hint: DomUtils.t('edGhWrittenViaApi', '$1 file(s) written via Apps Script API.', applied) });
    // PUT exitoso: la API ya tiene el contenido nuevo, pero Monaco
    // sigue mostrando el viejo hasta que el usuario recargue. Marcamos
    // a Monaco como "stale" para que los próximos GET no disparen el
    // Ctrl+S preventivo: si lo hicieran, sobrescribirían el contenido
    // recién aplicado con el código viejo del editor y revertirían el
    // pull, devolviendo la lista de cambios a "pendientes" al reabrir
    // el panel.
    this._monacoStale = true;
    return { applied, skipped };
  },
};
