"use strict";

/**
 * @fileoverview Mixin de <gas-github-panel>: comparación a tres vías (GAS, GitHub y la base
 * de la última sincronización) por SHA de blob y render compacto del diff (pestaña Diff).
 *
 * Script clásico (MAIN world). Se carga antes de `gas-github-panel.js`, que copia estos
 * métodos a `GasGithubPanel.prototype` con `Object.assign`. Usa `GasLineDiff`
 * (`extension/js/shared/line-diff.js`) y, si existe, `window.Diff.diffWordsWithSpace` (jsdiff).
 */

/** Líneas de contexto alrededor de cada bloque (igual que GitHub). */
const GH_DIFF_CONTEXT = 3;
/** Filas máximas de los bloques de cambios; por encima se remite al visor. */
const GH_DIFF_MAX_ROWS = 1500;
/** Líneas de contexto que se despliegan por pulsación. */
const GH_DIFF_FOLD_STEP = 200;
/** Longitud máxima de línea para el resaltado intra-línea. */
const GH_DIFF_MAX_INTRALINE = 1000;
const GH_SHA_RE = /^[0-9a-f]{40}$/;
/** Rutas remotas no aceptables en GAS: `.`/`..`, absolutas, `\`, controles, bidi e invisibles. */
const GH_UNSAFE_PATH_RE = /(^\/)|\\|[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|(^|\/)\.{1,2}(\/|$)/;

const GasGithubPanelDiffMixin = {

  // ── Normalizado y SHA de blob ─────────────────────────────────────

  /**
   * Contenido tal como lo sube el push: saltos LF y un `\n` final.
   * @param {string} text
   * @returns {string}
   */
  _pushForm_(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n?$/, '\n');
  },

  /**
   * Normalizado de comparación y de vista: LF y sin UN salto final (varios cuentan como cambio).
   * @param {string} text
   * @returns {string}
   */
  _normContent_(text) {
    return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  },

  /**
   * SHA-1 de blob de git (`"blob <bytes UTF-8>\0" + contenido`), igual que `git hash-object`.
   * @param {string} text Contenido exacto (sin normalizar).
   * @returns {Promise<string|null>} Hex de 40 caracteres o `null` sin `crypto.subtle`.
   */
  async _gitBlobSha_(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const body = new TextEncoder().encode(String(text ?? ''));
    const head = new TextEncoder().encode(`blob ${body.length}\0`);
    const buf = new Uint8Array(head.length + body.length);
    buf.set(head, 0);
    buf.set(body, head.length);
    const digest = new Uint8Array(await subtle.digest('SHA-1', buf));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return hex;
  },

  /**
   * Ruta remota que no se debe escribir en GAS (`..`, absoluta, `\`, controles o bidi).
   * @param {string} path
   * @returns {boolean}
   */
  _isUnsafeRemotePath_(path) {
    return GH_UNSAFE_PATH_RE.test(String(path ?? ''));
  },

  // ── Comparación a tres vías ───────────────────────────────────────

  /**
   * Construye `_diffItems` comparando por SHA de blob y descargando solo lo que difiere.
   * Sin `base` el origen es `'unknown'`. Un blob remoto no descargable (o > 1 MB) deja ese
   * archivo como `unavailable` (no se sube ni se trae). Con árboles incompletos, lo que se
   * deduciría de una ausencia queda `unknown` y `uncertain`.
   * @param {{
   *   local: Map<string,string>,
   *   remote: Map<string,{sha:string, content?:string, tooLarge?:boolean}>,
   *   base: Map<string,{sha:string}>|null,
   *   fetchBlobs: (shas:string[]) => Promise<Map<string,string>>,
   *   remoteIncomplete?: boolean,
   *   baseIncomplete?: boolean,
   * }} input `remote[].content` precargado evita la descarga (snapshot post-push).
   * @returns {Promise<Array<{path:string,status:'eq'|'add'|'del'|'mod',origin:'local'|'remote'|'conflict'|'unknown'|null,
   *   local:string,remote:string,base?:string,plus:number,minus:number,unavailable?:string,uncertain?:boolean,approx?:boolean}>>}
   */
  async _buildDiffItems_({ local, remote, base, fetchBlobs, remoteIncomplete = false, baseIncomplete = false }) {
    const norm = (s) => this._normContent_(s);
    const localSha = new Map();
    for (const [path, content] of local) localSha.set(path, await this._gitBlobSha_(this._pushForm_(content)));

    const paths = [...new Set([...local.keys(), ...remote.keys()])].sort();

    // 1) Blobs remotos necesarios: solo si el SHA local no coincide.
    const remoteText = new Map();
    const unavailable = new Map();
    const need = [];
    for (const path of paths) {
      const r = remote.get(path);
      if (!r) continue;
      if (local.has(path) && r.sha && localSha.get(path) === r.sha) continue;
      if (typeof r.content === 'string') remoteText.set(path, r.content);
      else if (r.tooLarge) unavailable.set(path, 'tooLarge');
      else need.push(path);
    }
    if (need.length) {
      let got = new Map();
      try { got = await fetchBlobs([...new Set(need.map((p) => remote.get(p).sha))]); } catch (err) {
        console.warn('[gas-github-panel] blob download failed:', err?.message || err);
      }
      for (const p of need) {
        const c = got.get(remote.get(p).sha);
        if (typeof c === 'string') remoteText.set(p, c);
        else unavailable.set(p, 'failed');
      }
    }

    // 2) Estado por archivo; si el SHA difiere se confirma por contenido normalizado.
    const items = [];
    for (const path of paths) {
      const hasLocal = local.has(path);
      const r = remote.get(path);
      if (unavailable.has(path)) {
        items.push({ path, status: hasLocal ? 'mod' : 'del', origin: 'unknown', local: hasLocal ? norm(local.get(path)) : '',
          remote: '', unavailable: unavailable.get(path) });
        continue;
      }
      const shaMatch = !!(hasLocal && r?.sha && localSha.get(path) === r.sha);
      const l = hasLocal ? norm(local.get(path)) : '';
      const rem = !r ? '' : shaMatch ? l : norm(remoteText.get(path));
      let status;
      if (!r) status = 'add';
      else if (!hasLocal) status = 'del';
      else status = shaMatch || l === rem ? 'eq' : 'mod';
      const it = { path, status, origin: status === 'eq' ? null : (base ? undefined : 'unknown'), local: l, remote: rem };
      // Texto remoto sin recortar el salto final: es lo que escribe el pull.
      if (r) {
        const raw = shaMatch ? this._pushForm_(local.get(path)) : String(remoteText.get(path) ?? '').replace(/\r\n?/g, '\n');
        Object.defineProperty(it, 'remoteRaw', { value: raw, writable: true, configurable: true });
      }
      // Árbol remoto incompleto: no estar en él no prueba que se borrara.
      if (status === 'add' && remoteIncomplete) { it.origin = 'unknown'; it.uncertain = true; }
      items.push(it);
    }

    // 3) Origen respecto a la base; contenido base solo para posibles conflictos.
    if (base) {
      const pending = [];
      for (const it of items) {
        if (it.origin !== undefined) continue;
        const b = base.get(it.path);
        // Base incompleta: una ausencia en ella no se puede interpretar.
        if (!b && baseIncomplete) { it.origin = 'unknown'; it.uncertain = true; continue; }
        const rSha = remote.get(it.path)?.sha || null;
        const lSha = localSha.get(it.path) || null;
        if (it.status === 'mod') {
          // Creado en los dos lados con contenido distinto.
          if (!b) { it.origin = 'conflict'; it.base = ''; }
          else if (rSha && rSha === b.sha) it.origin = 'local';
          else if (lSha && lSha === b.sha) it.origin = 'remote';
          else pending.push(it);
        } else if (it.status === 'add') {
          // Solo en GAS: nuevo local, o borrado en GitHub.
          if (!b) it.origin = 'local';
          else if (lSha && lSha === b.sha) it.origin = 'remote';
          else pending.push(it);
        } else {
          // Solo en GitHub: nuevo remoto, o borrado en GAS.
          if (!b) it.origin = 'remote';
          else if (rSha && rSha === b.sha) it.origin = 'local';
          else pending.push(it);
        }
      }
      if (pending.length) {
        let got = new Map();
        try { got = await fetchBlobs([...new Set(pending.map((it) => base.get(it.path).sha))]); } catch (_) { /* conflicto */ }
        for (const it of pending) {
          const raw = got.get(base.get(it.path).sha);
          if (typeof raw !== 'string') { it.origin = 'conflict'; continue; }
          const b = norm(raw);
          const localChanged = it.status === 'del' ? true : it.local !== b;
          const remoteChanged = it.status === 'add' ? true : it.remote !== b;
          if (localChanged && remoteChanged) { it.origin = 'conflict'; it.base = b; }
          else it.origin = localChanged ? 'local' : 'remote';
        }
      }
    }

    // 4) Estadísticas con GasLineDiff (ops reutilizadas por el render).
    for (const it of items) {
      it.plus = 0;
      it.minus = 0;
      if (it.status === 'eq' || it.unavailable) continue;
      const ops = GasLineDiff.diffLines(it.remote, it.local);
      const st = GasLineDiff.stats(ops);
      it.plus = st.added;
      it.minus = st.removed;
      if (ops.overBudget) it.approx = true;
      Object.defineProperty(it, 'ops', { value: ops, writable: true, configurable: true });
    }
    return items;
  },

  /**
   * Push bloqueado si algún seleccionado viene de GitHub o está en conflicto (sin base: si solo
   * existe en GitHub), salvo que el usuario eligiera "Quedarme con GAS". Mientras se recalcula
   * el diff también bloquea.
   * @returns {boolean}
   */
  _pullRequired_() {
    if (this._loadingDiff) return true;
    return this._diffItems.some((it) => it.status !== 'eq'
      && this._selectedFiles.has(it.path)
      && this._resolutionFor_(it)?.action !== 'keep-local'
      && (it.origin === 'remote' || it.origin === 'conflict' || (it.origin === 'unknown' && it.status === 'del')));
  },

  /**
   * Decide la nueva base tras un push correcto. Sin base previa basta con que el padre sea el
   * commit comparado; con base, además no deben quedar cambios remotos sin traer.
   * @param {{commitSha:string, parentSha:string|null, pushedPaths:Set<string>}} res
   * @returns {string|null} SHA a fijar o `null` para conservar la base actual.
   */
  _nextBaseAfterPush_({ commitSha, parentSha, pushedPaths }) {
    if (!commitSha || !GH_SHA_RE.test(commitSha)) return null;
    // Auto-rebase sobre un head que no se comparó: puede traer cambios remotos desconocidos.
    if ((parentSha || null) !== (this._remoteCommitSha || null)) return null;
    if (!this._project?.baseSha) return commitSha;
    const leftover = this._diffItems.filter((it) => it.status !== 'eq' && !pushedPaths.has(it.path));
    const safe = leftover.every((it) => !it.uncertain && !it.unavailable
      && (it.origin === 'local' || (it.origin === 'unknown' && it.status === 'add')));
    return safe ? commitSha : null;
  },

  /**
   * Persiste `baseSha` en la config del proyecto (`gasToolsGhProject:<scriptId>`).
   * @param {string} sha Commit de la última sincronización.
   * @returns {Promise<void>}
   */
  async _commitBaseSha_(sha) {
    if (!this._project || !sha || !GH_SHA_RE.test(sha) || this._project.baseSha === sha) return;
    this._project = { ...this._project, baseSha: sha };
    await this._saveProjectConfig_(this._project);
  },

  /**
   * Motivo por el que un archivo nunca entra en el pull, o `null` si se puede elegir.
   * @param {{path:string,unavailable?:string,uncertain?:boolean}} it
   * @returns {'unavailable'|'unsafe'|'uncertain'|null}
   */
  _pullExclusion_(it) {
    if (it.unavailable) return 'unavailable';
    if (it.uncertain) return 'uncertain';
    if (this._isUnsafeRemotePath_(it.path)) return 'unsafe';
    return null;
  },

  /**
   * Reparte los candidatos del pull entre lo que se aplica y lo que queda. La decisión del
   * visor manda: "Quedarme con GAS" nunca se aplica; un conflicto solo con "Traer de GitHub"
   * o "Resultado editado".
   * @param {Array} candidates Items del diff que existen en GitHub.
   * @param {Set<string>} selected Rutas marcadas en la confirmación.
   * @returns {{apply:Array, left:Array}}
   */
  _pullPlan_(candidates, selected) {
    const apply = [];
    const left = [];
    for (const it of candidates) {
      const action = this._resolutionFor_(it)?.action;
      const ok = selected.has(it.path) && !this._pullExclusion_(it) && action !== 'keep-local'
        && (it.origin !== 'conflict' || action === 'take-remote' || action === 'merged');
      (ok ? apply : left).push(it);
    }
    return { apply, left };
  },

  /**
   * `true` si lo que no se trajo (incluidos los archivos que solo están en GAS) no impide mover
   * la base: cambios de GAS, decisiones "Quedarme con GAS" o archivos nuevos sin base.
   * Un borrado de GitHub sin aplicar (`add` de origen remoto) la bloquea: con la base nueva
   * parecería "Nuevo en GAS" y un push lo resucitaría.
   * @param {Array} left Items que no se aplicaron (`left` del plan + los `add`).
   * @returns {boolean}
   */
  _pullLeavesBaseSafe_(left) {
    return left.every((it) => it.origin === 'local'
      || this._resolutionFor_(it)?.action === 'keep-local'
      || (it.status === 'add' && it.origin === 'unknown'));
  },

  /**
   * Texto que el pull escribe en GAS: el resultado editado o el remoto sin recortar.
   * @param {object} it Item del diff.
   * @returns {string}
   */
  _pullContent_(it) {
    const r = this._resolutionFor_(it);
    if (r?.action === 'merged') return r.content;
    return it.remoteRaw ?? it.remote ?? '';
  },

  /**
   * Estado inicial de la casilla de un archivo en la confirmación del pull. La decisión del
   * visor manda ("Quedarme con GAS" → fuera; "Traer de GitHub"/resultado → dentro); si no hay,
   * GitHub y desconocido marcados, GAS desmarcado, conflicto bloqueado hasta resolverlo.
   * Bloqueados (no disponible, incompleto, ruta no segura): nunca.
   * @param {object} it Item del diff.
   * @returns {{checked:boolean, disabled:boolean}}
   */
  _pullRowDefault_(it) {
    if (this._pullExclusion_(it)) return { checked: false, disabled: true };
    const action = this._resolutionFor_(it)?.action;
    if (action === 'keep-local') return { checked: false, disabled: true };
    if (action === 'take-remote' || action === 'merged') return { checked: true, disabled: false };
    if (it.origin === 'conflict') return { checked: false, disabled: true };
    return { checked: it.origin !== 'local', disabled: false };
  },

  /**
   * HTML de una fila de la confirmación del pull (casilla, estado, ruta, badge, `+x −y` y nota).
   * @param {object} it Item del diff.
   * @param {boolean} checked Casilla marcada.
   * @returns {string}
   */
  _pullRowHtml_(it, checked) {
    const esc = DomUtils.escapeHtml;
    const { disabled } = this._pullRowDefault_(it);
    const reason = this._pullExclusion_(it);
    const res = it.origin === 'conflict' ? this._resolutionFor_(it) : null;
    const reasonLabel = {
      unavailable: DomUtils.t('edGhExcludedUnavailable', 'not available'),
      unsafe:      DomUtils.t('edGhExcludedUnsafe', 'unsafe path'),
      uncertain:   DomUtils.t('edGhExcludedUncertain', 'incomplete comparison'),
    };
    let note = '';
    let noteCls = '';
    const resAny = this._resolutionFor_(it);
    if (reason) note = reasonLabel[reason];
    else if (resAny?.action === 'keep-local') note = DomUtils.t('edGhPullKeepLocalNote', 'Keep GAS: not touched');
    else if ((it.origin === 'local' || (it.origin === 'unknown' && it.status === 'mod')) && checked) {
      // Sin base no se sabe qué lado cambió: puede pisar trabajo de GAS.
      note = it.origin === 'local'
        ? DomUtils.t('edGhPullOverwriteWarn', 'Will overwrite your changes in GAS')
        : DomUtils.t('edGhPullUnknownWarn', 'May overwrite your changes in GAS');
      noteCls = 'warn';
    } else if (it.origin === 'conflict') {
      note = res ? this._resolutionLabel_(res) : DomUtils.t('edGhPullNeedsResolve', 'Resolve it first');
      if (!res) noteCls = 'warn';
    } else if (resAny) note = this._resolutionLabel_(resAny);
    const hasViewer = typeof window !== 'undefined' && !!window.gasDiffViewer;
    const resolveBtn = it.origin === 'conflict' && hasViewer && !reason
      ? `<button class="gt-btn gt-btn--tonal gt-btn--sm qc__gh-pullResolve" type="button" data-resolve="${esc(it.path)}">${esc(res
        ? DomUtils.t('edGhChangeResolution', 'Change') : DomUtils.t('edGhResolve', 'Resolve'))}</button>`
      : '';
    return `
      <div class="qc__gh-pullItem ${disabled ? 'qc__gh-pullItem--off' : ''}">
        <input type="checkbox" class="qc__gh-pullCheck" data-path="${esc(it.path)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}
               aria-label="${esc(DomUtils.t('edGhPullFileLabel', 'Pull $1', it.path))}">
        ${this._statusMarkHtml_(it)}
        <span class="qc__gh-pullPath" title="${esc(it.path)}">${esc(it.path)}</span>
        ${this._renderDiffOriginBadge_(it)}
        ${this._deltaHtml_(it)}
        ${note ? `<span class="qc__gh-pullReason ${noteCls}">${esc(note)}</span>` : ''}
        ${resolveBtn}
      </div>`;
  },

  // ── Resoluciones (visor) ──────────────────────────────────────────

  /**
   * Guarda (o borra con `null`) la decisión de un archivo. Debe venir con la instantánea que
   * el usuario vio (`local`/`remote`); si no coincide con el diff vigente se rechaza.
   * "Quedarme con GAS" no vale si el archivo solo existe en GitHub (el push no borra) y
   * "Traer de GitHub" no vale si solo existe en GAS (el pull no borra).
   * @param {string} path
   * @param {{action:'keep-local'|'take-remote'|'merged', content?:string, local?:string, remote?:string}|null} res
   * @returns {boolean} `true` si quedó guardada (o borrada).
   */
  _setResolution_(path, res) {
    if (!this._resolutions) this._resolutions = new Map();
    const item = this._diffItems.find((i) => i.path === path);
    if (!res) { this._resolutions.delete(path); return true; }
    if (!item || !['keep-local', 'take-remote', 'merged'].includes(res.action)) return false;
    if ((res.action === 'keep-local' && item.status === 'del') || (res.action === 'take-remote' && item.status === 'add')
      || (res.action === 'merged' && item.origin !== 'conflict')) return false;
    const local = typeof res.local === 'string' ? res.local : item.local;
    const remote = typeof res.remote === 'string' ? res.remote : item.remote;
    if (local !== item.local || remote !== item.remote) {
      this._toast_?.(DomUtils.t('edGhResolutionStale', 'The comparison changed while you were deciding. Open the viewer again.'), 'warn', 6000);
      return false;
    }
    const entry = { action: res.action, local, remote };
    if (res.action === 'merged') entry.content = String(res.content ?? '');
    this._resolutions.set(path, entry);
    return true;
  },

  /**
   * Decisión vigente de un archivo (solo si GAS y GitHub no cambiaron desde que se tomó).
   * @param {{path:string, local:string, remote:string}} item
   * @returns {{action:string, content?:string}|null}
   */
  _resolutionFor_(item) {
    const r = this._resolutions?.get(item?.path);
    return r && r.local === item.local && r.remote === item.remote ? r : null;
  },

  /** Descarta las decisiones que ya no corresponden al diff actual. */
  _pruneResolutions_() {
    if (!this._resolutions?.size) return;
    const byPath = new Map(this._diffItems.map((i) => [i.path, i]));
    for (const path of [...this._resolutions.keys()]) {
      const it = byPath.get(path);
      if (!it || it.status === 'eq' || !this._resolutionFor_(it)) this._resolutions.delete(path);
    }
  },

  // ── Render compacto ───────────────────────────────────────────────

  /**
   * Pinta la pestaña Diff: una tarjeta plegable por archivo con cambios.
   * @param {HTMLElement} wrap
   * @private
   */
  _renderDiffTab_(wrap) {
    if (!this._project?.repo || !this._project?.branch) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          ${DomUtils.escapeHtml(DomUtils.t('edGhSelectRepoBranchDiff', 'Select a repository and branch to see the diff.'))}
        </div>
      `);
      return;
    }
    if (this._loadingDiff) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-hint qc__gh-hintCenter">
          <span class="qc__gh-spinner"></span> ${DomUtils.escapeHtml(DomUtils.t('edGhLoadingDiff', 'Loading diff…'))}
        </div>
      `);
      return;
    }
    const items = this._diffItems.filter((i) => i.status !== 'eq');
    if (!items.length) {
      DomUtils.setHTML(wrap, `
        <div class="qc__gh-changesEmpty">
          ${this._ico_('success', 'qc__gh-icoOk qc__gh-icoXl')}
          <div class="qc__gh-emptyText">${DomUtils.escapeHtml(DomUtils.t('edGhNoDifferences', 'No differences'))}</div>
        </div>
      `);
      return;
    }

    if (!this._expandedDiffPaths) this._expandedDiffPaths = new Set([items[0].path]);

    DomUtils.setHTML(wrap, `
      ${this._baseNoticeHtml_()}
      <div class="qc__gh-diffWrap">${items.map((it, i) => this._renderDiffCard_(it, i)).join('')}</div>
    `);

    wrap.querySelectorAll('.qc__gh-diffCard').forEach((card) => {
      const path = card.dataset.path;
      const item = items.find((i) => i.path === path);
      const toggle = card.querySelector('.qc__gh-diffCardToggle');
      const body = card.querySelector('.qc__gh-diffCardBody');
      toggle.addEventListener('click', () => {
        if (this._expandedDiffPaths.has(path)) this._expandedDiffPaths.delete(path);
        else this._expandedDiffPaths.add(path);
        const isOpen = this._expandedDiffPaths.has(path);
        card.classList.toggle('qc__gh-diffCardOpen', isOpen);
        toggle.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) this._renderDiffInto_(body, item);
        else DomUtils.setHTML(body, '');
      });
      card.querySelector('.qc__gh-diffViewerBtn')?.addEventListener('click', () => this._openDiffViewer_(path));
      card.querySelector('.qc__gh-diffResolveBtn')?.addEventListener('click', () => this._openDiffViewer_(path));
      if (this._expandedDiffPaths.has(path)) requestAnimationFrame(() => this._renderDiffInto_(body, item));
    });
  },

  /**
   * Avisos de la comparación: sin base común, base perdida o árbol incompleto.
   * @returns {string}
   * @private
   */
  _baseNoticeHtml_() {
    const notes = [];
    if (this._diffItems.some((i) => i.origin === 'unknown' && !i.unavailable && !i.uncertain)) {
      notes.push(this._diffBaseMissing
        ? DomUtils.t('edGhBaseMissing', 'The last synced commit is no longer on GitHub. The origin of each change is unknown until the next push or pull.')
        : DomUtils.t('edGhBaseUnknown', 'No previous sync recorded. The origin of each change is unknown until the next push or pull.'));
    }
    if (this._treeIncomplete) {
      notes.push(DomUtils.t('edGhTreeIncomplete', 'The repository is too large to compare completely. Files missing from the comparison are not treated as deleted, and pull will not create or remove them.'));
    }
    return notes.map((text) => `<div class="qc__gh-baseNotice" role="note">${this._ico_('info')}<span>${DomUtils.escapeHtml(text)}</span></div>`).join('');
  },

  /**
   * Estado y `+x −y` vistos desde el lado que trae el cambio: lo que viene de GitHub se
   * cuenta como lo que aportará el pull.
   * @param {{status:string, origin:string, plus:number, minus:number}} item
   * @returns {{cls:string, char:string, plus:number, minus:number, pull:boolean}}
   * @private
   */
  _displayDelta_(item) {
    const pull = item.origin === 'remote';
    const plus = Number(item.plus) || 0;
    const minus = Number(item.minus) || 0;
    let cls = item.status;
    if (pull && item.status === 'del') cls = 'add';
    else if (pull && item.status === 'add') cls = 'del';
    const char = { add: '+', del: '−', mod: '~' }[cls] || '•';
    return pull ? { cls, char, plus: minus, minus: plus, pull } : { cls, char, plus, minus, pull };
  },

  /**
   * Marca de estado (`+`, `−`, `~`) oculta al lector de pantalla (el badge ya lo dice).
   * @param {{status:string, origin:string}} item
   * @returns {string}
   * @private
   */
  _statusMarkHtml_(item) {
    const d = this._displayDelta_(item);
    return `<span class="qc__gh-changeStatus ${DomUtils.escapeHtml(d.cls)}" aria-hidden="true">${d.char}</span>`;
  },

  /**
   * Ruta partida en carpeta (recortable) y nombre (siempre visible).
   * @param {string} path
   * @returns {string}
   * @private
   */
  _pathHtml_(path) {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const file = slash >= 0 ? path.slice(slash + 1) : path;
    return `<span class="qc__gh-changePathDir">${DomUtils.escapeHtml(dir)}</span><span class="qc__gh-changePathFile">${DomUtils.escapeHtml(file)}</span>`;
  },

  /**
   * HTML de la tarjeta plegable de un archivo (badge de origen, `+x −y` y botón del visor).
   * @param {{path:string,status:string,origin:string,plus:number,minus:number}} item
   * @param {number} [index=0] Posición, para el id del cuerpo (`aria-controls`).
   * @returns {string}
   * @private
   */
  _renderDiffCard_(item, index = 0) {
    const isOpen = !!this._expandedDiffPaths?.has(item.path);
    const bodyId = `ghDiffBody${index}`;
    const viewerLabel = DomUtils.escapeHtml(DomUtils.t('edGhOpenInViewer', 'Open in viewer'));
    const hasViewer = typeof window !== 'undefined' && !!window.gasDiffViewer;
    const viewer = hasViewer
      ? `<button class="gt-icon-btn qc__gh-iconBtn qc__gh-diffViewerBtn" type="button" title="${viewerLabel}" aria-label="${viewerLabel}">${this._ico_('openInNew')}</button>`
      : '';
    const res = this._resolutionFor_(item);
    const resolve = hasViewer && item.origin === 'conflict'
      ? `<button class="gt-btn gt-btn--tonal gt-btn--sm qc__gh-diffResolveBtn" type="button">${DomUtils.escapeHtml(res
        ? this._resolutionLabel_(res) : DomUtils.t('edGhResolve', 'Resolve'))}</button>`
      : '';
    return `
      <div class="qc__gh-diffCard ${isOpen ? 'qc__gh-diffCardOpen' : ''}" data-path="${DomUtils.escapeHtml(item.path)}">
        <div class="qc__gh-diffCardHead">
          <button class="qc__gh-diffCardToggle" type="button" aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="${bodyId}">
            ${this._ico_('chevronRight', 'qc__gh-diffCardChevron')}
            ${this._statusMarkHtml_(item)}
            <span class="qc__gh-diffCardPath" title="${DomUtils.escapeHtml(item.path)}">${this._pathHtml_(item.path)}</span>
            ${this._renderDiffOriginBadge_(item)}
            ${this._deltaHtml_(item)}
          </button>
          ${resolve}
          ${viewer}
        </div>
        <div class="qc__gh-diffCardBody" id="${bodyId}"></div>
      </div>
    `;
  },

  /**
   * `+x −y` del archivo (con `~` si el diff es aproximado) y texto para lectores de pantalla.
   * @param {{status:string,origin:string,plus:number,minus:number,approx?:boolean,unavailable?:string}} item
   * @returns {string}
   * @private
   */
  _deltaHtml_(item) {
    if (item.unavailable) return '';
    const d = this._displayDelta_(item);
    const approx = item.approx ? '~' : '';
    const text = d.pull
      ? DomUtils.t('edGhDeltaPullTitle', 'Pull brings $1 added and $2 removed lines', d.plus, d.minus)
      : DomUtils.t('edGhDeltaTitle', '$1 added, $2 removed', d.plus, d.minus);
    return `<span class="qc__gh-changeDelta" title="${DomUtils.escapeHtml(text)}">`
      + `<span aria-hidden="true"><span class="add">${approx}+${d.plus}</span> <span class="del">${approx}−${d.minus}</span></span>`
      + `<span class="gt-sr-only">${DomUtils.escapeHtml(text)}</span></span>`;
  },

  /**
   * Badge de origen por archivo (GAS, GitHub, conflicto, desconocido o no disponible).
   * @param {{status:string, origin:string, unavailable?:string, uncertain?:boolean}} item
   * @returns {string}
   */
  _renderDiffOriginBadge_(item) {
    const { status, origin } = item;
    let cls = 'unknown';
    let icon = 'help';
    let label;
    let title;
    if (item.unavailable) {
      cls = 'unavailable'; icon = 'warn';
      label = DomUtils.t('edGhOriginUnavailable', 'Not available');
      title = item.unavailable === 'tooLarge'
        ? DomUtils.t('edGhUnavailableTooLarge', 'Larger than 1 MB on GitHub: it is not compared, pushed or pulled.')
        : DomUtils.t('edGhUnavailableFailed', 'Could not be downloaded from GitHub: it is not pushed or pulled. Refresh to retry.');
    } else if (origin === 'local') {
      cls = 'local'; icon = 'cloudUpload';
      label = status === 'add' ? DomUtils.t('edGhOriginNewInGas', 'New in GAS')
        : status === 'del' ? DomUtils.t('edGhOriginDeletedInGas', 'Deleted in GAS')
          : DomUtils.t('edGhOriginChangedInGas', 'Changed in GAS');
      title = DomUtils.t('edGhOriginLocalTitle', 'Changed only in GAS since the last sync. Push sends it to GitHub.');
    } else if (origin === 'remote') {
      cls = 'remote'; icon = 'cloudDownload';
      label = status === 'del' ? DomUtils.t('edGhOriginNewOnGithub', 'New on GitHub')
        : status === 'add' ? DomUtils.t('edGhOriginDeletedOnGithub', 'Deleted on GitHub')
          : DomUtils.t('edGhOriginChangedOnGithub', 'Changed on GitHub');
      title = DomUtils.t('edGhOriginRemoteTitle', 'Changed only on GitHub since the last sync. Pull brings it into GAS.');
    } else if (origin === 'conflict') {
      cls = 'conflict'; icon = 'warn';
      label = DomUtils.t('edGhOriginConflict', 'Conflict');
      title = DomUtils.t('edGhOriginConflictTitle', 'Changed in GAS and on GitHub since the last sync.');
    } else if (status === 'add') {
      label = DomUtils.t('edGhOriginGasOnly', 'GAS only');
      title = item.uncertain
        ? DomUtils.t('edGhOriginUncertainTitle', 'Not found in the partial comparison of the repository: it may exist on GitHub.')
        : DomUtils.t('edGhOriginAddTitle', 'Only exists in GAS. Push creates it on GitHub.');
    } else if (status === 'del') {
      label = DomUtils.t('edGhOriginGithubOnly', 'GitHub only');
      title = DomUtils.t('edGhOriginDelTitle', 'Only exists on GitHub. Pull brings it into GAS.');
    } else {
      label = DomUtils.t('edGhOriginUnknown', 'Unknown origin');
      title = DomUtils.t('edGhOriginUnknownTitle', 'No previous sync recorded: it is not known which side changed.');
    }
    const aria = DomUtils.escapeHtml(`${label}. ${title}`);
    return `<span class="qc__gh-diffOrigin ${cls}" title="${DomUtils.escapeHtml(title)}" role="img" aria-label="${aria}">`
      + `${this._ico_(icon)}<span class="qc__gh-originLabel" aria-hidden="true">${DomUtils.escapeHtml(label)}</span></span>`;
  },

  /**
   * Pinta el diff compacto de un archivo (GitHub a la izquierda, GAS a la derecha).
   * @param {HTMLElement} mount
   * @param {{path:string,status:string,local:string,remote:string}} item
   * @private
   */
  _renderDiffInto_(mount, item) {
    if (!mount || !item) return;
    DomUtils.setHTML(mount, this._diffBodyHtml_(item));
    mount.querySelectorAll('[data-fold]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.fold);
        this._expandFold_(item.path, idx);
        this._renderDiffInto_(mount, item);
        // Foco: el siguiente plegado (o el mismo si quedan líneas); si no, la tabla.
        const next = [...mount.querySelectorAll('[data-fold]')].find((b) => Number(b.dataset.fold) >= idx);
        (next || mount.querySelector('.qc__gh-diffScroll'))?.focus({ preventScroll: true });
      });
    });
    mount.querySelector('.qc__gh-diffViewerLink')?.addEventListener('click', () => this._openDiffViewer_(item.path));
  },

  /**
   * Despliega `GH_DIFF_FOLD_STEP` líneas más del tramo plegado `idx`.
   * @param {string} path
   * @param {number} idx
   * @private
   */
  _expandFold_(path, idx) {
    if (!this._diffFoldsOpen) this._diffFoldsOpen = new Map();
    let open = this._diffFoldsOpen.get(path);
    // `Set` = tramos desplegados enteros; se pasa a `Map` tramo → líneas visibles.
    if (typeof open?.get !== 'function') open = new Map(open ? [...open].map((i) => [i, Infinity]) : []);
    open.set(idx, (open.get(idx) || 0) + GH_DIFF_FOLD_STEP);
    this._diffFoldsOpen.set(path, open);
  },

  /**
   * Líneas ya desplegadas de un tramo (`Set` = desplegado entero).
   * @param {string} path
   * @param {number} idx
   * @returns {number}
   * @private
   */
  _foldShown_(path, idx) {
    const open = this._diffFoldsOpen?.get(path);
    if (typeof open?.get === 'function') return open.get(idx) || 0;
    if (typeof open?.has === 'function') return open.has(idx) ? Infinity : 0;
    return 0;
  },

  /**
   * Ops del archivo (cacheadas en el item, no enumerables).
   * @param {{local:string, remote:string, ops?:Array}} item
   * @returns {Array}
   * @private
   */
  _diffOpsFor_(item) {
    if (!item.ops) {
      Object.defineProperty(item, 'ops', {
        value: GasLineDiff.diffLines(item.remote || '', item.local || ''), writable: true, configurable: true,
      });
    }
    return item.ops;
  },

  /**
   * HTML del diff unificado: cabecera de columnas, `@@` por bloque, números de línea en dos
   * columnas, contexto plegado por tramos y resaltado intra-línea. Todo el texto va escapado.
   * @param {{path:string,local:string,remote:string,unavailable?:string}} item
   * @returns {string}
   * @private
   */
  _diffBodyHtml_(item) {
    const esc = DomUtils.escapeHtml;
    if (item.unavailable) {
      return `<div class="qc__gh-diffTooLarge" role="note">${this._ico_('warn')}<span>${esc(item.unavailable === 'tooLarge'
        ? DomUtils.t('edGhUnavailableTooLarge', 'Larger than 1 MB on GitHub: it is not compared, pushed or pulled.')
        : DomUtils.t('edGhUnavailableFailed', 'Could not be downloaded from GitHub: it is not pushed or pulled. Refresh to retry.'))}</span></div>`;
    }
    const ops = this._diffOpsFor_(item);
    if (ops.overBudget) return this._diffTooLargeHtml_();
    const hunks = GasLineDiff.hunks(ops, GH_DIFF_CONTEXT);
    if (!hunks.length) {
      return `<div class="qc__gh-diffEmpty">${esc(DomUtils.t('edGhNoDiffInFile', 'No differences in this file.'))}</div>`;
    }

    const remoteLines = item.remote ? String(item.remote).split('\n') : [];
    const totalA = remoteLines.length;
    const srGithub = esc(DomUtils.t('edGhSrLineGithub', 'Only in GitHub: '));
    const srGas = esc(DomUtils.t('edGhSrLineGas', 'Only in GAS: '));
    const groups = [];
    let hunkRows = 0;

    const lineRow = (cls, aNum, bNum, sign, html, sr = '') => `<tr class="qc__gh-dRow ${cls}"><td class="qc__gh-dNum">${aNum ?? ''}</td>`
      + `<td class="qc__gh-dNum qc__gh-dNum2">${bNum ?? ''}</td>`
      + `<td class="qc__gh-dCode"><span class="qc__gh-dSign" aria-hidden="true">${sign}</span>${sr ? `<span class="gt-sr-only">${sr}</span>` : ''}${html}</td></tr>`;
    const eqRow = (a, b) => lineRow('qc__gh-dEq', a, b, ' ', esc(remoteLines[a - 1] ?? ''));

    // Tramo de líneas iguales: se despliega por pasos (el primero hacia arriba).
    const gap = (idx, aFrom, aTo, bFrom) => {
      const n = aTo - aFrom + 1;
      if (n <= 0) return;
      const shown = Math.min(n, this._foldShown_(item.path, idx));
      const hidden = n - shown;
      const rows = [];
      const before = idx === 0;
      const visible = [];
      if (shown) {
        const start = before ? aFrom + hidden : aFrom;
        for (let k = 0; k < shown; k++) visible.push(eqRow(start + k, bFrom + (start - aFrom) + k));
      }
      if (hidden) {
        const step = Math.min(hidden, GH_DIFF_FOLD_STEP);
        const label = hidden <= GH_DIFF_FOLD_STEP
          ? (hidden === 1 ? DomUtils.t('edGhShowLinesOne', 'Show $1 line', hidden) : DomUtils.t('edGhShowLinesMany', 'Show $1 lines', hidden))
          : DomUtils.t('edGhShowNextLines', 'Show $1 of $2 hidden lines', step, hidden);
        const fold = `<tr class="qc__gh-dFold"><td colspan="3"><button class="gt-btn gt-btn--text gt-btn--sm qc__gh-dFoldBtn" type="button" data-fold="${idx}">`
          + `${this._ico_('unfoldMore')}${esc(label)}</button></td></tr>`;
        if (before) rows.push(fold, ...visible); else rows.push(...visible, fold);
      } else {
        rows.push(...visible);
      }
      groups.push(`<tbody class="qc__gh-dGap">${rows.join('')}</tbody>`);
    };

    let prevA = 0;
    let prevB = 0;
    hunks.forEach((h, hi) => {
      gap(hi, prevA + 1, h.aStart - 1, prevB + 1);
      const aCount = h.ops.filter((o) => o.type !== 'add').length;
      const bCount = h.ops.filter((o) => o.type !== 'del').length;
      const head = `@@ -${aCount ? h.aStart : h.aStart - 1},${aCount} +${bCount ? h.bStart : h.bStart - 1},${bCount} @@`;
      const rows = [`<tr class="qc__gh-dHunk"><th colspan="3" scope="rowgroup">${esc(head)}</th></tr>`];

      for (let i = 0; i < h.ops.length;) {
        const op = h.ops[i];
        if (op.type === 'equal') { rows.push(lineRow('qc__gh-dEq', op.aLine, op.bLine, ' ', esc(op.text))); i++; continue; }
        // Bloque de cambios: borrados seguidos de altas (orden de GasLineDiff).
        const dels = [];
        const adds = [];
        while (i < h.ops.length && h.ops[i].type === 'del') dels.push(h.ops[i++]);
        while (i < h.ops.length && h.ops[i].type === 'add') adds.push(h.ops[i++]);
        const pairs = Math.min(dels.length, adds.length);
        const intra = [];
        for (let k = 0; k < pairs; k++) intra.push(this._intraLineHtml_(dels[k].text, adds[k].text));
        dels.forEach((d, k) => rows.push(lineRow('qc__gh-dDel', d.aLine, null, '−', intra[k] ? intra[k].oldHtml : esc(d.text), srGithub)));
        adds.forEach((a, k) => rows.push(lineRow('qc__gh-dAdd', null, a.bLine, '+', intra[k] ? intra[k].newHtml : esc(a.text), srGas)));
      }
      hunkRows += rows.length - 1;
      groups.push(`<tbody class="qc__gh-dHunkGroup">${rows.join('')}</tbody>`);
      prevA = h.aStart - 1 + aCount;
      prevB = h.bStart - 1 + bCount;
    });
    gap(hunks.length, prevA + 1, totalA, prevB + 1);

    // El tope solo cuenta los bloques: desplegar contexto nunca oculta el diff.
    if (hunkRows > GH_DIFF_MAX_ROWS) return this._diffTooLargeHtml_();

    const caption = DomUtils.t('edGhDiffTableLabel', 'Differences in $1', item.path);
    return `
      <div class="qc__gh-diffScroll" tabindex="0">
        <table class="qc__gh-diffTable" aria-label="${esc(caption)}">
          <thead><tr>
            <th class="qc__gh-dNum" scope="col">${esc(DomUtils.t('edGhDiffColGithub', 'GitHub'))}</th>
            <th class="qc__gh-dNum qc__gh-dNum2" scope="col">${esc(DomUtils.t('edGhDiffColGas', 'GAS'))}</th>
            <th class="qc__gh-dLegend" scope="col">${esc(DomUtils.t('edGhDiffLegend', '− GitHub · + GAS'))}</th>
          </tr></thead>
          ${groups.join('')}
        </table>
      </div>`;
  },

  /**
   * Aviso de diff demasiado grande para el panel (con enlace al visor si existe).
   * @returns {string}
   * @private
   */
  _diffTooLargeHtml_() {
    const link = typeof window !== 'undefined' && window.gasDiffViewer
      ? `<button class="gt-btn gt-btn--text gt-btn--sm qc__gh-diffViewerLink" type="button">${this._ico_('openInNew')}${DomUtils.escapeHtml(DomUtils.t('edGhOpenInViewer', 'Open in viewer'))}</button>`
      : '';
    return `<div class="qc__gh-diffTooLarge" role="note">${this._ico_('warn')}`
      + `<span>${DomUtils.escapeHtml(DomUtils.t('edGhDiffTooLarge', 'This diff is too large to show here. Open it in the viewer.'))}</span>${link}</div>`;
  },

  /**
   * Resalta lo que cambia dentro de un par línea borrada / añadida (`diffWordsWithSpace`).
   * @param {string} oldText Línea de GitHub.
   * @param {string} newText Línea de GAS.
   * @returns {{oldHtml:string, newHtml:string}|null} `null` si no aporta (sin jsdiff, líneas largas o sin nada en común).
   * @private
   */
  _intraLineHtml_(oldText, newText) {
    const diffWords = typeof window !== 'undefined' ? window.Diff?.diffWordsWithSpace : null;
    if (typeof diffWords !== 'function') return null;
    if (oldText.length > GH_DIFF_MAX_INTRALINE || newText.length > GH_DIFF_MAX_INTRALINE) return null;
    let parts;
    try { parts = diffWords(oldText, newText); } catch (_) { return null; }
    if (!parts.some((p) => !p.added && !p.removed && p.value.trim())) return null;
    const esc = DomUtils.escapeHtml;
    let oldHtml = '';
    let newHtml = '';
    for (const p of parts) {
      if (p.added) newHtml += `<span class="qc__gh-dWordAdd">${esc(p.value)}</span>`;
      else if (p.removed) oldHtml += `<span class="qc__gh-dWordDel">${esc(p.value)}</span>`;
      else { oldHtml += esc(p.value); newHtml += esc(p.value); }
    }
    return { oldHtml, newHtml };
  },

  /**
   * Abre el visor amplio (`window.gasDiffViewer`) en el archivo indicado. Cada decisión se
   * liga a la instantánea que el visor mostró; si el diff cambia, el visor se cierra.
   * @param {string} path
   * @param {{onClose?:Function}} [opts] `onClose`: tras cerrar (p. ej. repintar la confirmación del pull).
   * @returns {boolean} `true` si se abrió.
   */
  _openDiffViewer_(path, opts = {}) {
    const viewer = typeof window !== 'undefined' ? window.gasDiffViewer : null;
    if (!viewer?.open) return false;
    const items = this._diffItems.filter((i) => i.status !== 'eq');
    const seen = new Map(items.map((i) => [i.path, { local: i.local, remote: i.remote }]));
    const resolutions = new Map();
    for (const it of items) {
      const r = this._resolutionFor_(it);
      if (r) resolutions.set(it.path, r.action === 'merged' ? { action: r.action, content: r.content } : { action: r.action });
    }
    try {
      const opened = viewer.open({
        items,
        activePath: path,
        resolutions,
        onResolve: (p, res) => this._setResolution_(p, res ? { ...seen.get(p), ...res } : null),
        onClose: () => {
          this._viewerOwned = false;
          try { opts.onClose?.(); } finally {
            if (this._activeTab === 'diff') this._renderTabBody_?.();
            this._refreshFooterButtons_?.();
          }
        },
      });
      this._viewerOwned = !!opened;
      return opened;
    } catch (err) {
      console.warn('[gas-github-panel] diff viewer failed:', err);
      return false;
    }
  },

  /** Cierra el visor si lo abrió este panel (diff invalidado, cierre del panel…). */
  _closeDiffViewer_() {
    if (!this._viewerOwned) return;
    this._viewerOwned = false;
    try { if (window.gasDiffViewer?.isOpen?.()) window.gasDiffViewer.close(); } catch (_) { /* ya cerrado */ }
  },

  /**
   * Texto de una decisión del visor.
   * @param {{action:string}} res
   * @returns {string}
   */
  _resolutionLabel_(res) {
    if (res?.action === 'keep-local') return DomUtils.t('edDvKeepLocal', 'Keep GAS');
    if (res?.action === 'take-remote') return DomUtils.t('edDvTakeRemote', 'Take GitHub');
    if (res?.action === 'merged') return DomUtils.t('edDvMerged', 'Edited result');
    return '';
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { GasGithubPanelDiffMixin };
