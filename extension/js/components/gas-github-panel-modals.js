"use strict";

/**
 * @fileoverview Mixin de <gas-github-panel>: modales (`gt-dialog`), confirmación
 * (`GasUi.confirm`), creación de rama/repo y toasts (`GasUi.toast`).
 *
 * Script clásico (MAIN world). Se carga antes de `gas-github-panel.js`,
 * que copia estos métodos a `GasGithubPanel.prototype` con `Object.assign`.
 * Los métodos usan `this` como la instancia del elemento.
 */
const GasGithubPanelModalsMixin = {

  /**
   * Abre el modal "Crear branch" y, si el usuario confirma, crea la
   * branch en GitHub y la activa.
   * @private
   */
  async _showCreateBranchPrompt_() {
    if (!this._project?.repo) return;

    const result = await this._openCreateBranchModal_();
    if (!result) return;

    this._toast_(DomUtils.t('edGhCreatingBranch', 'Creating branch $1…', result.name), 'info', 1800);
    const res = await this._ghApi_('CREATE_BRANCH', {
      repo:       this._project.repo,
      name:       result.name,
      fromBranch: result.fromBranch,
    });

    if (res?.ok) {
      this._toast_(DomUtils.t('edGhBranchCreated', 'Branch "$1" created', result.name), 'ok');
      // Insertar local para que aparezca al instante y cambiar a ella.
      this._branches = [{ name: result.name, commitSha: res.data?.commitSha || '' }, ...this._branches];
      await this._onBranchChange_(result.name);
    } else if (await this._handleAuthError_(res)) {
      return;
    } else {
      this._toast_(res?.error || DomUtils.t('edGhBranchCreateFailed', 'Could not create branch'), 'error', 5000);
    }
  },

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
      <option value="${DomUtils.escapeHtml(b.name)}" ${b.name === currentBranch ? 'selected' : ''}>
        ${DomUtils.escapeHtml(b.name)}
      </option>
    `).join('') || `<option value="${DomUtils.escapeHtml(currentBranch)}" selected>${DomUtils.escapeHtml(currentBranch)}</option>`;

    const html = `
      <div class="gt-dialog qc__gh-modal" role="dialog" aria-modal="true" aria-label="${DomUtils.escapeHtml(DomUtils.t('edGhNewBranch', 'New branch'))}">
        <h2 class="gt-dialog__title">${DomUtils.escapeHtml(DomUtils.t('edGhNewBranch', 'New branch'))}</h2>

        <label class="qc__gh-fieldLabel" for="ghNewBranchName">${DomUtils.escapeHtml(DomUtils.t('edGhBranchName', 'Branch name'))}</label>
        <input id="ghNewBranchName" class="gt-input qc__gh-input" type="text"
               placeholder="feature/awesome" autocomplete="off">

        <label class="qc__gh-fieldLabel" for="ghNewBranchFrom">
          ${DomUtils.escapeHtml(DomUtils.t('edGhBasedOn', 'Based on'))}
        </label>
        <select id="ghNewBranchFrom" class="gt-select">${branchOptions}</select>

        <div class="gt-dialog__actions qc__gh-modalFooter">
          <button class="gt-btn gt-btn--text" id="ghNewBranchCancel">${DomUtils.escapeHtml(DomUtils.t('edGhCancel', 'Cancel'))}</button>
          <button class="gt-btn gt-btn--filled" id="ghNewBranchCreate" disabled>${DomUtils.escapeHtml(DomUtils.t('edGhCreate', 'Create'))}</button>
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
      });
      cancel.addEventListener('click', () => finish(null));
      create.addEventListener('click', () => {
        finish({ name: input.value.trim(), fromBranch: from.value });
      });

      setTimeout(() => input.focus(), 30);
    });
  },

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
    this._toast_(DomUtils.t('edGhCreatingRepo', 'Creating $1…', name), 'info', 1800);
    const res = await this._ghApi_('CREATE_REPO', { name, isPrivate });
    if (res?.ok) {
      this._toast_(DomUtils.t('edGhRepoCreated', 'Repository created: $1', res.data.full_name), 'ok');
      this._repos = [{ ...res.data, private: isPrivate }, ...this._repos];
      this._reposLoaded = true;
      await this._onRepoChange_(res.data.full_name);
    } else if (await this._handleAuthError_(res)) {
      return;
    } else {
      this._toast_(res?.error || DomUtils.t('edGhRepoCreateFailed', 'Could not create repository'), 'error', 5000);
    }
  },

  /**
   * Pinta el modal de creación de repositorio dentro del Shadow DOM
   * (los prompt/confirm nativos pueden estar bloqueados por GAS).
   * Resuelve con `{name, isPrivate}` o `null` si se cancela.
   * @returns {Promise<{name:string, isPrivate:boolean}|null>}
   * @private
   */
  _openCreateRepoModal_() {
    const html = `
      <div class="gt-dialog qc__gh-modal" role="dialog" aria-modal="true" aria-label="${DomUtils.escapeHtml(DomUtils.t('edGhNewRepo', 'New repository'))}">
        <h2 class="gt-dialog__title">${DomUtils.escapeHtml(DomUtils.t('edGhNewRepo', 'New repository'))}</h2>

        <label class="qc__gh-fieldLabel" for="ghNewRepoName">${DomUtils.escapeHtml(DomUtils.t('edGhName', 'Name'))}</label>
        <input id="ghNewRepoName" class="gt-input qc__gh-input" type="text"
               placeholder="my-project" autocomplete="off">

        <div class="qc__gh-radioRow">
          <label class="qc__gh-radio">
            <input type="radio" name="ghVisibility" value="private" checked>
            <span class="qc__gh-radioCircle"></span>
            <span>
              <strong>${DomUtils.escapeHtml(DomUtils.t('edGhPrivate', 'Private'))}</strong>
              <span class="qc__gh-radioHint">${DomUtils.escapeHtml(DomUtils.t('edGhPrivateHint', 'Only you can see it'))}</span>
            </span>
          </label>
          <label class="qc__gh-radio">
            <input type="radio" name="ghVisibility" value="public">
            <span class="qc__gh-radioCircle"></span>
            <span>
              <strong>${DomUtils.escapeHtml(DomUtils.t('edGhPublic', 'Public'))}</strong>
              <span class="qc__gh-radioHint">${DomUtils.escapeHtml(DomUtils.t('edGhPublicHint', 'Anyone can see it'))}</span>
            </span>
          </label>
        </div>

        <div class="gt-dialog__actions qc__gh-modalFooter">
          <button class="gt-btn gt-btn--text" id="ghNewRepoCancel">${DomUtils.escapeHtml(DomUtils.t('edGhCancel', 'Cancel'))}</button>
          <button class="gt-btn gt-btn--filled" id="ghNewRepoCreate" disabled>
            ${DomUtils.escapeHtml(DomUtils.t('edGhCreate', 'Create'))}
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
      });
      cancel.addEventListener('click', () => finish(null));
      create.addEventListener('click', () => {
        const isPrivate = overlay.querySelector('input[name="ghVisibility"]:checked').value === 'private';
        finish({ name: input.value.trim(), isPrivate });
      });

      setTimeout(() => input.focus(), 30);
    });
  },

  /**
   * Confirmación con `GasUi.confirm` (Escape, foco atrapado y botón
   * destructivo en rojo con `tone: 'danger'`). Se registra en
   * `_activeModal` para poder cancelarla al desmontar o abrir otro modal.
   *
   * @param {{title:string, message:string, confirmLabel?:string, cancelLabel?:string, tone?:'primary'|'danger'}} opts
   * @returns {Promise<boolean>}
   * @private
   */
  _showConfirm_(opts) {
    this._activeModal?.finish(this._activeModal.cancelValue);
    const ctrl = new AbortController();
    const entry = { overlay: null, finish: () => ctrl.abort(), cancelValue: false };
    this._activeModal = entry;
    return GasUi.confirm(this.shadowRoot, {
      title: opts.title,
      body: opts.message,
      confirmLabel: opts.confirmLabel || DomUtils.t('edGhConfirm', 'Confirm'),
      cancelLabel: opts.cancelLabel || DomUtils.t('edGhCancel', 'Cancel'),
      danger: opts.tone === 'danger',
      signal: ctrl.signal,
    }).finally(() => {
      if (this._activeModal === entry) this._activeModal = null;
    });
  },

  /**
   * Confirmación del pull con una casilla por archivo y su origen. Los conflictos se
   * resuelven en el visor (botón "Resolver") antes de poder incluirlos.
   *
   * @param {{files:Array, reloadAvailable:boolean, localOnlyCount:number}} opts `files`: items del diff sin `add`.
   * @returns {Promise<{confirmed:boolean, reload:boolean, selected:Set<string>}>}
   * @private
   */
  _showPullConfirm_(opts) {
    const esc = DomUtils.escapeHtml;
    const files = Array.isArray(opts.files) ? opts.files : [];
    const checked = new Map(files.map((f) => [f.path, this._pullRowDefault_(f).checked]));
    const target = `<strong>${esc((this._project?.repo || '') + '@' + (this._project?.branch || ''))}</strong>`;

    const localOnlyHint = opts.localOnlyCount
      ? `<div class="qc__gh-pullNote">${esc(DomUtils.t('edGhLocalOnlyIgnored', '$1 will be ignored — they are not in the repo, push them separately if needed.'))
        .split('$1').join(`<strong>${esc(DomUtils.t('edGhLocalOnlyFiles', '$1 local-only file(s)', opts.localOnlyCount))}</strong>`)}</div>`
      : '';
    const reloadCheck = opts.reloadAvailable
      ? `<label class="qc__gh-pullCheckRow"><input id="ghPullReload" type="checkbox" checked>
           ${esc(DomUtils.t('edGhPullReloadHint', 'Reload this GAS tab after applying so the editor shows the new content.'))}</label>`
      : '';

    const html = `
      <div class="gt-dialog qc__gh-modal qc__gh-modal--wide" role="dialog" aria-modal="true" aria-labelledby="ghPullTitle">
        <h2 class="gt-dialog__title" id="ghPullTitle">${esc(DomUtils.t('edGhPullFromRepo', 'Pull from repository'))}</h2>
        <div class="qc__gh-modalTextWrap">
          <div class="qc__gh-pullSummary">${this._ico_('cloudDownload')}<span id="ghPullSummary"></span></div>
          <div class="qc__gh-pullList" id="ghPullList" role="group" aria-label="${esc(DomUtils.t('edGhPullFilesGroup', 'Files to pull'))}"></div>
          ${localOnlyHint}
          ${reloadCheck}
        </div>
        <div class="gt-dialog__actions qc__gh-modalFooter">
          <button class="gt-btn gt-btn--text" id="ghConfirmCancel">${esc(DomUtils.t('edGhCancel', 'Cancel'))}</button>
          <button class="gt-btn gt-btn--filled" id="ghConfirmOk">${esc(DomUtils.t('edGhApplyChanges', 'Apply changes'))}</button>
        </div>
      </div>
    `;
    const cancelValue = { confirmed: false, reload: false, selected: new Set() };

    return this._openModal_(html, (overlay, finish) => {
      const ok = overlay.querySelector('#ghConfirmOk');
      const list = overlay.querySelector('#ghPullList');
      const summary = overlay.querySelector('#ghPullSummary');
      const reload = overlay.querySelector('#ghPullReload');
      const usable = () => files.filter((f) => checked.get(f.path) && !this._pullRowDefault_(f).disabled);

      const render = (focusPath) => {
        DomUtils.setHTML(list, files.map((f) => this._pullRowHtml_(f, !!checked.get(f.path))).join(''));
        const n = usable().length;
        const count = n === 1
          ? DomUtils.t('edGhPullSelectedOne', '$1 file selected', n)
          : DomUtils.t('edGhPullSelectedMany', '$1 files selected', n);
        DomUtils.setHTML(summary, esc(DomUtils.t('edGhPullSummaryFrom', '$1 from $2')).split('$1').join(esc(count)).split('$2').join(target));
        ok.disabled = n === 0;
        if (focusPath) [...list.querySelectorAll('[data-path],[data-resolve]')].find((el) => (el.dataset.path || el.dataset.resolve) === focusPath)?.focus();
      };

      list.addEventListener('change', (e) => {
        const box = e.target?.closest?.('.qc__gh-pullCheck');
        if (!box) return;
        checked.set(box.dataset.path, box.checked);
        render(box.dataset.path);
      });
      list.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('[data-resolve]');
        if (!btn) return;
        const path = btn.dataset.resolve;
        this._openDiffViewer_(path, {
          onClose: () => {
            const it = files.find((f) => f.path === path);
            if (it) checked.set(path, this._pullRowDefault_(it).checked);
            if (overlay.isConnected) render(path);
          },
        });
      });

      render();
      ok.addEventListener('click', () => finish({
        confirmed: true,
        reload: !!opts.reloadAvailable && (reload?.checked ?? false),
        selected: new Set(usable().map((f) => f.path)),
      }));
      overlay.querySelector('#ghConfirmCancel').addEventListener('click', () => finish(cancelValue));
      setTimeout(() => (ok.disabled ? list.querySelector('input:not(:disabled), button') : ok)?.focus(), 30);
    }, cancelValue);
  },

  /**
   * Toast del panel (`GasUi.toast`) en una pila anclada a `.qc__gh-shell`.
   * @param {string} text Mensaje (texto plano).
   * @param {'ok'|'success'|'info'|'warn'|'warning'|'error'} [kind='info']
   * @param {number} [durationMs] 3200 ms (6000 ms si es error).
   * @returns {{element:HTMLElement, dismiss:Function}|null}
   * @private
   */
  _toast_(text, kind = 'info', durationMs) {
    const shell = this.shadowRoot?.querySelector('.qc__gh-shell');
    if (!shell) return null;
    let stack = shell.querySelector(':scope > .gt-toast-stack');
    if (!stack) {
      // Sin aria-live: cada toast lleva role=status|alert.
      stack = document.createElement('div');
      stack.className = 'gt-toast-stack qc__gh-toastStack';
      shell.appendChild(stack);
    }
    const kinds = { ok: 'success', success: 'success', info: 'info', warn: 'warning', warning: 'warning', error: 'error' };
    return GasUi.toast(stack, {
      text: String(text ?? ''),
      kind: kinds[kind] || 'info',
      // Por defecto 3200 ms; los errores se quedan más (6000 ms).
      durationMs: durationMs ?? (kind === 'error' ? 6000 : 3200),
      closeLabel: DomUtils.t('edGhClose', 'Close'),
    });
  },

  /**
   * Crea un overlay modal dentro del shadow root del panel y lo inserta
   * en `.qc__gh-shell`. Centraliza el patrón compartido por
   * `_openCreateBranchModal_`, `_openCreateRepoModal_`, `_showConfirm_`
   * y `_showPullConfirm_`: limpiar overlay anterior, crear el contenedor,
   * inyectar HTML y registrar los cierres por click fuera y Escape.
   *
   * El callback `onMount(overlay, finish)` recibe el overlay ya montado
   * y un helper `finish(value)` que lo desmonta y resuelve la promesa.
   * El consumidor se encarga de cablear botones y atajos de teclado.
   *
   * @param {string}   html        - Contenido HTML del overlay (incluye `.gt-dialog`).
   * @param {Function} onMount     - `(overlay, finish) => void`. Cablea los listeners.
   * @param {*}        [cancelValue=null] - Valor con el que se resuelve si se cancela
   *                                         haciendo click fuera del modal.
   * @returns {Promise<*>} Lo que `finish(value)` reciba.
   * @private
   */
  _openModal_(html, onMount, cancelValue = null) {
    return new Promise((resolve) => {
      // Si quedó un modal previo, lo cancelamos (resolviendo su promesa
      // con su valor de cancelación) antes de pintar el nuevo; así ningún
      // `await` queda colgado.
      const prev = this._activeModal;
      if (prev) prev.finish(prev.cancelValue);
      this.shadowRoot.querySelector('.qc__gh-modalOverlay')?.remove();

      const overlay = document.createElement('div');
      overlay.className = 'gt-scrim qc__gh-modalOverlay';
      DomUtils.setHTML(overlay, html);
      this.shadowRoot.querySelector('.qc__gh-shell').appendChild(overlay);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        overlay.remove();
        if (this._activeModal?.overlay === overlay) this._activeModal = null;
        resolve(value);
      };
      this._activeModal = { overlay, finish, cancelValue };

      // Click fuera del modal = cancelar (los modales no son modales 100%
      // bloqueantes; se descartan con click en el backdrop).
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(cancelValue);
      });
      // Escape cancela solo el modal (no llega al cierre del panel).
      overlay.addEventListener('keydown', (e) => {
        // Tab / Mayús+Tab quedan dentro del diálogo (misma trampa que GasUi.confirm).
        if (e.key === 'Tab') { GasUi.trapTab(e, overlay.querySelector('.gt-dialog') || overlay, this.shadowRoot); return; }
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(cancelValue);
      });
      // El foco no se escapa del modal hacia el resto del panel.
      overlay.addEventListener('focusout', (e) => {
        const next = e.relatedTarget;
        if (next && this.shadowRoot.contains(next) && !overlay.contains(next)) {
          overlay.querySelector('.gt-dialog button:not([disabled]), .gt-dialog input:not([disabled])')?.focus();
        }
      });

      onMount(overlay, finish);
    });
  },
};
