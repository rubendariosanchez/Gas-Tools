"use strict";

/**
 * @fileoverview Mixin de <gas-github-panel>: Panel de progreso de push/pull y bloqueo de la pestaña durante operaciones.
 *
 * Script clásico (MAIN world). Se carga antes de `gas-github-panel.js`,
 * que copia estos métodos a `GasGithubPanel.prototype` con `Object.assign`.
 * Los métodos usan `this` como la instancia del elemento.
 */
const GasGithubPanelProgressMixin = {

  /**
   * Bloquea el cierre/recarga de la pestaña mientras hay un push o
   * pull en curso. El navegador mostrará el aviso nativo "¿Salir del
   * sitio?" si el usuario intenta cerrar; se puede ignorar pero queda
   * la advertencia para evitar abandonos accidentales que dejarían el
   * proyecto a medio sincronizar.
   * @private
   */
  _lockTab_() {
    if (this._tabLocked) return;
    this._tabLocked = true;
    window.addEventListener('beforeunload', this._onBeforeUnload_, { capture: true });
    this._refreshHeaderActionsBusy_();
  },

  /** Quita el bloqueo de cierre. @private */
  _unlockTab_() {
    if (!this._tabLocked) return;
    this._tabLocked = false;
    window.removeEventListener('beforeunload', this._onBeforeUnload_, { capture: true });
    this._refreshHeaderActionsBusy_();
  },

  /**
   * Handler de `beforeunload`. Devolver string + `preventDefault` es
   * lo que dispara el modal nativo del navegador.
   * @param {BeforeUnloadEvent} e
   * @private
   */
  _onBeforeUnload_(e) {
    if (!this._pushing && !this._pulling) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  },

  // ─────────────────────────────────────────────
  // PROGRESS PANEL (push/pull)
  // Sustituye el toast "Sending changes…" por un mini-bloque colapsable
  // anclado al pie del panel. Permite al usuario ver qué fase está en
  // curso y la lista de archivos involucrados sin tapar el resto de
  // la UI ni forzar a esperar.
  // ─────────────────────────────────────────────

  /**
   * Configura las fases canónicas para una operación. Cada fase tiene:
   *   - id: clave única para `_setProgressPhase_`.
   *   - label: texto principal.
   *   - icon: nombre del registro `GasUi` mostrado al lado.
   *   - hint?: descripción complementaria (opcional).
   *   - files?: lista de paths involucrados (opcional, expandida en el body).
   *
   * @param {'push'|'pull'} kind
   * @param {Array<{path:string}>} files
   * @returns {Array<{id:string,label:string,icon:string,files?:Array<string>}>}
   * @private
   */
  _buildProgressPhases_(kind, files) {
    const filePaths = (files || []).map((f) => f.path);
    if (kind === 'push') {
      return [
        { id: 'snapshot', label: DomUtils.t('edGhPhaseReadSnapshot', 'Reading project snapshot'),
          icon: 'cloudDownload',
          hint: DomUtils.t('edGhPhaseReadSnapshotHint', 'Asking Apps Script API for the current state.') },
        { id: 'blobs', label: DomUtils.t('edGhPhaseUploadBlobs', 'Uploading file blobs'),
          icon: 'uploadFile',
          hint: DomUtils.t('edGhPhaseFilesQueued', '$1 file(s) queued.', filePaths.length),
          files: filePaths },
        { id: 'tree', label: DomUtils.t('edGhPhaseBuildTree', 'Building Git tree'),
          icon: 'accountTree' },
        { id: 'commit', label: DomUtils.t('edGhPhaseCreateCommit', 'Creating commit'),
          icon: 'commit' },
        { id: 'ref', label: DomUtils.t('edGhPhaseUpdateRef', 'Updating branch ref'),
          icon: 'altRoute' },
      ];
    }
    // pull
    return [
      { id: 'tree', label: DomUtils.t('edGhPhaseReadRemoteTree', 'Reading remote tree'),
        icon: 'accountTree' },
      { id: 'blobs', label: DomUtils.t('edGhPhaseDownloadBlobs', 'Downloading file blobs'),
        icon: 'cloudDownload',
        hint: DomUtils.t('edGhPhaseFilesToApply', '$1 file(s) to apply.', filePaths.length) },
      { id: 'merge', label: DomUtils.t('edGhPhaseMerge', 'Merging into project snapshot'),
        icon: 'merge',
        files: filePaths },
      { id: 'apply', label: DomUtils.t('edGhPhaseWriteBack', 'Writing back via Apps Script API'),
        icon: 'save' },
    ];
  },

  /**
   * Abre el panel de progreso y construye su DOM una sola vez. Las
   * actualizaciones posteriores (`_setProgressPhase_`,
   * `_markProgressFile_`, `_finishProgress_`) modifican únicamente los
   * nodos afectados para preservar el scroll del usuario y evitar
   * reflows innecesarios cuando hay cientos de archivos.
   *
   * @param {{kind:'push'|'pull', title:string, files:Array}} opts
   * @private
   */
  _openProgress_({ kind, title, files }) {
    const root = this.shadowRoot.getElementById('ghProgress');
    if (!root) return;

    this._progressState = {
      kind,
      title,
      meta: '',
      phases: this._buildProgressPhases_(kind, files).map((p) => ({
        ...p, status: 'pending',
      })),
      open: true,
      finished: false,
      success: null,
      /** Mapa path → <li> ya pintado, para localizar rápido en updates. */
      fileNodes: new Map(),
      /** Map phaseId → root <div> de la fase. */
      phaseNodes: new Map(),
    };

    root.style.display = 'block';
    this._buildProgressShell_();
  },

  /**
   * Construye el árbol DOM completo del panel de progreso una sola vez
   * y lo guarda en `_progressState.phaseNodes` / `.fileNodes` para
   * actualizaciones puntuales posteriores.
   * @private
   */
  _buildProgressShell_() {
    const root = this.shadowRoot.getElementById('ghProgress');
    const s = this._progressState;
    if (!root || !s) return;

    DomUtils.setHTML(root, `
      <div class="qc__gh-progressHead" id="ghProgressHead">
        <div class="qc__gh-progressIcon" id="ghProgressIcon"></div>
        <div class="qc__gh-progressTitle" id="ghProgressTitle"></div>
        <div class="qc__gh-progressActions">
          <button class="gt-icon-btn qc__gh-iconBtn" id="ghProgressToggle" title="${DomUtils.escapeHtml(DomUtils.t('edGhToggleDetails', 'Toggle details'))}">
            ${this._ico_('chevronUp', 'qc__gh-progressChevron')}
          </button>
          <button class="gt-icon-btn qc__gh-iconBtn" id="ghProgressClose" title="${DomUtils.escapeHtml(DomUtils.t('edGhClose', 'Close'))}" style="display:none">
            ${this._ico_('close')}
          </button>
        </div>
      </div>
      <div class="qc__gh-progressBody" id="ghProgressBody"></div>
    `);

    const body = root.querySelector('#ghProgressBody');
    s.phaseNodes.clear();
    s.fileNodes.clear();

    for (const p of s.phases) {
      const phaseEl = document.createElement('div');
      phaseEl.className = `qc__gh-progressPhase ${p.status}`;
      phaseEl.dataset.phase = p.id;

      const iconWrap = document.createElement('div');
      iconWrap.className = 'qc__gh-progressPhaseIcon';
      iconWrap.appendChild(this._icoNode_(this._phaseIconName_(p)));

      const textWrap = document.createElement('div');
      textWrap.className = 'qc__gh-progressPhaseText';

      const labelEl = document.createElement('div');
      labelEl.className = 'qc__gh-progressPhaseLabel';
      labelEl.textContent = p.label;

      const hintEl = document.createElement('div');
      hintEl.className = 'qc__gh-progressPhaseHint';
      hintEl.style.display = 'none';

      const ul = document.createElement('ul');
      ul.className = 'qc__gh-progressFiles';
      ul.style.display = 'none';

      textWrap.append(labelEl, hintEl, ul);
      phaseEl.append(iconWrap, textWrap);

      if (Array.isArray(p.files) && p.files.length) {
        for (const entry of p.files) {
          const path  = typeof entry === 'string' ? entry : entry.path;
          const fstat = typeof entry === 'string' ? '' : (entry.status || '');
          const li = this._buildProgressFileNode_(path, fstat);
          ul.appendChild(li);
          s.fileNodes.set(path, li);
        }
        if (p.status !== 'pending') ul.style.display = '';
      }

      body.appendChild(phaseEl);
      s.phaseNodes.set(p.id, phaseEl);
    }

    this._refreshProgressHead_();
    root.classList.toggle('qc__gh-progressOpen', !!s.open);

    root.querySelector('#ghProgressHead').addEventListener('click', (e) => {
      if (e.target.closest('#ghProgressClose')) return;
      s.open = !s.open;
      root.classList.toggle('qc__gh-progressOpen', !!s.open);
    });
    root.querySelector('#ghProgressClose').addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeProgress_();
    });
  },

  /**
   * Construye un <li> para un archivo concreto con su icono según
   * estado. Se reutiliza en la creación inicial y en los updates por
   * archivo.
   * @param {string} path
   * @param {string} fstat
   * @returns {HTMLLIElement}
   * @private
   */
  _buildProgressFileNode_(path, fstat) {
    const li = document.createElement('li');
    if (fstat) li.className = `qc__gh-progressFile-${fstat}`;
    const icon = this._fileIconName_(fstat);
    if (icon) li.appendChild(this._icoNode_(icon));
    const span = document.createElement('span');
    span.textContent = path;
    li.appendChild(span);
    return li;
  },

  /** Icono (registro `GasUi`) de la cabecera de una fase. */
  _phaseIconName_(p) {
    if (p.status === 'done')   return 'success';
    if (p.status === 'error')  return 'error';
    if (p.status === 'active') return p.icon || 'autorenew';
    return p.icon || 'radioUnchecked';
  },

  /** Icono (registro `GasUi`) de un archivo. */
  _fileIconName_(fstat) {
    if (fstat === 'done')   return 'check';
    if (fstat === 'reused') return 'cached';
    if (fstat === 'error')  return 'error';
    return '';
  },

  /**
   * Repinta solo la cabecera (icono, título, meta, botón close) sin
   * tocar el body.
   * @private
   */
  _refreshProgressHead_() {
    const root = this.shadowRoot.getElementById('ghProgress');
    const s = this._progressState;
    if (!root || !s) return;

    root.classList.toggle('qc__gh-progressDone',  s.finished && s.success === true);
    root.classList.toggle('qc__gh-progressError', s.finished && s.success === false);

    const iconEl = root.querySelector('#ghProgressIcon');
    if (iconEl) {
      iconEl.replaceChildren();
      if (s.finished) {
        iconEl.appendChild(this._icoNode_(s.success ? 'success' : 'error'));
      } else {
        const sp = document.createElement('span');
        sp.className = 'qc__gh-spinner';
        iconEl.appendChild(sp);
      }
    }

    const titleEl = root.querySelector('#ghProgressTitle');
    if (titleEl) {
      titleEl.replaceChildren();
      titleEl.appendChild(document.createTextNode(s.title));
      if (s.meta) {
        const span = document.createElement('span');
        span.className = 'qc__gh-progressMeta';
        span.textContent = ` · ${s.meta}`;
        titleEl.appendChild(span);
      }
    }

    const closeBtn = root.querySelector('#ghProgressClose');
    if (closeBtn) closeBtn.style.display = s.finished ? '' : 'none';
  },

  /**
   * Repinta una fase concreta (icono + label + hint + visibilidad de
   * la lista de archivos) sin tocar las demás.
   * @private
   */
  _refreshProgressPhase_(phaseId) {
    const s = this._progressState;
    if (!s) return;
    const phase = s.phases.find((p) => p.id === phaseId);
    const node  = s.phaseNodes.get(phaseId);
    if (!phase || !node) return;

    node.className = `qc__gh-progressPhase ${phase.status}`;
    node.querySelector('.qc__gh-progressPhaseIcon')?.replaceChildren(this._icoNode_(this._phaseIconName_(phase)));

    const hintEl = node.querySelector('.qc__gh-progressPhaseHint');
    if (phase.hint && phase.status !== 'pending') {
      hintEl.textContent = phase.hint;
      hintEl.style.display = '';
    } else {
      hintEl.style.display = 'none';
    }

    const ul = node.querySelector('.qc__gh-progressFiles');
    ul.style.display = (phase.files && phase.files.length && phase.status !== 'pending')
      ? '' : 'none';
  },

  /**
   * Marca una fase como `active`/`done`/`error` y actualiza la UI. Si
   * la fase recibe `meta` (ej. "3/9 files"), la añade junto al título
   * principal del header.
   *
   * @param {string} phaseId
   * @param {'active'|'done'|'error'} status
   * @param {{meta?:string, hint?:string, files?:Array<string>}} [opts]
   * @private
   */
  _setProgressPhase_(phaseId, status, opts = {}) {
    const s = this._progressState;
    if (!s) return;
    const phase = s.phases.find((p) => p.id === phaseId);
    if (!phase) return;
    phase.status = status;
    if (opts.hint  !== undefined) phase.hint  = opts.hint;
    if (opts.meta  !== undefined) s.meta = opts.meta;

    // Actualización lazy de la lista de archivos solo si cambió: evita
    // recrear los <li> existentes.
    if (opts.files !== undefined) {
      phase.files = opts.files;
      const node = s.phaseNodes.get(phaseId);
      if (node) {
        const ul = node.querySelector('.qc__gh-progressFiles');
        ul.replaceChildren();
        for (const entry of phase.files) {
          const path  = typeof entry === 'string' ? entry : entry.path;
          const fstat = typeof entry === 'string' ? '' : (entry.status || '');
          const li = this._buildProgressFileNode_(path, fstat);
          ul.appendChild(li);
          s.fileNodes.set(path, li);
        }
      }
    }

    this._refreshProgressPhase_(phaseId);
    this._refreshProgressHead_();
  },

  /**
   * Marca un archivo concreto como `done`/`reused`/`error` dentro de
   * la fase activa de blobs y actualiza el contador del header.
   * Reescribe únicamente el `<li>` afectado para preservar el scroll.
   * @param {string} phaseId
   * @param {string} path
   * @param {'done'|'reused'|'error'} status
   * @param {{done?:number, total?:number}} [counters]
   * @private
   */
  _markProgressFile_(phaseId, path, status, counters = {}) {
    const s = this._progressState;
    if (!s) return;
    const phase = s.phases.find((p) => p.id === phaseId);
    if (!phase || !Array.isArray(phase.files)) return;

    let updated = false;
    phase.files = phase.files.map((entry) => {
      const ePath = typeof entry === 'string' ? entry : entry.path;
      if (ePath !== path) return entry;
      updated = true;
      return { path: ePath, status };
    });
    if (!updated) phase.files.push({ path, status });

    // Actualiza solo el <li> afectado: nuevo nodo, swap puntual.
    const oldLi = s.fileNodes.get(path);
    const newLi = this._buildProgressFileNode_(path, status);
    if (oldLi && oldLi.parentNode) {
      oldLi.parentNode.replaceChild(newLi, oldLi);
    } else {
      const node = s.phaseNodes.get(phaseId);
      const ul = node?.querySelector('.qc__gh-progressFiles');
      if (ul) ul.appendChild(newLi);
    }
    s.fileNodes.set(path, newLi);

    if (counters.done != null && counters.total != null) {
      s.meta = DomUtils.t('edGhFilesProgress', '$1/$2 files', counters.done, counters.total);
      this._refreshProgressHead_();
    }
  },

  /**
   * Recibe los eventos `GAS_GH_PUSH_PROGRESS` que el background emite
   * mientras procesa un push: cambios de fase y blobs subidos. Mantiene
   * la cache de blobs para que un reintento omita lo ya hecho.
   * @param {CustomEvent} e
   * @private
   */
  _onPushProgress_(e) {
    let payload;
    try { payload = JSON.parse(e.detail); } catch (_) { return; }
    if (!payload || !this._progressState) return;

    if (payload.type === 'phase') {
      const phaseId = payload.phase;
      if (!phaseId) return;
      this._setProgressPhase_(phaseId, 'active');
      return;
    }

    if (payload.type === 'blob') {
      const cache = this._pushBlobCache?.blobs;
      if (cache) cache.set(payload.path, payload.sha);
      this._markProgressFile_(
        'blobs',
        payload.path,
        payload.reused ? 'reused' : 'done',
        { done: payload.done, total: payload.total },
      );
    }
  },

  /**
   * Cierra el panel de progreso al instante.
   * @private
   */
  _closeProgress_() {
    const root = this.shadowRoot.getElementById('ghProgress');
    if (root) {
      root.style.display = 'none';
      DomUtils.setHTML(root, '');
    }
    this._progressState = null;
  },

  /**
   * Marca la operación como completada (éxito o fallo). Mantiene el
   * panel visible para que el usuario pueda revisar el listado, pero
   * cambia el icono del header y revela el botón de cerrar.
   *
   * @param {{success:boolean, title?:string, meta?:string}} opts
   * @private
   */
  _finishProgress_({ success, title, meta }) {
    const s = this._progressState;
    if (!s) return;
    s.finished = true;
    s.success = !!success;
    if (title !== undefined) s.title = title;
    if (meta  !== undefined) s.meta  = meta;
    for (const p of s.phases) {
      if (p.status === 'active') {
        p.status = success ? 'done' : 'error';
        this._refreshProgressPhase_(p.id);
      }
    }
    this._refreshProgressHead_();
  },
};
