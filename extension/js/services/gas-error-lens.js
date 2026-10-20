"use strict";

/**
 * @fileoverview Error Lens para Monaco en el editor de Google Apps Script.
 * Inspirado en https://github.com/usernamehw/vscode-error-lens.
 *
 * Responsabilidades:
 *  - Renderer (siempre activo con la lens): muestra los diagnósticos que
 *    ya tiene Monaco (markers del worker JS/TS de GAS y de cualquier otro
 *    owner) con subrayado, barra en la canaleta y mensaje al final de la
 *    línea como content widget.
 *  - Reglas personalizadas (opt-in, desactivadas por defecto): linter
 *    regex por línea (sin `new Function`: la CSP con Trusted Types de GAS
 *    lo bloquea). Publica markers con owner propio (`MARKER_SOURCE`), que
 *    el renderer muestra como cualquier otro diagnóstico.
 */
class GasErrorLens {

  // ── Configuración ──────────────────────────────────────────────────────

  /** Lenguajes soportados por las reglas personalizadas. */
  static LANGUAGES = new Set(['javascript', 'typescript', 'google apps script']);

  /** Owner/source publicado en los markers de las reglas personalizadas. */
  static MARKER_SOURCE = 'gas-tools';

  /** Debounce de `onDidChangeMarkers` antes de re-renderizar. */
  static MARKERS_DEBOUNCE_MS = 150;

  /** Severidades Monaco. */
  static SEVERITY = { Error: 8, Warning: 4, Info: 2, Hint: 1 };

  /** Severidad numérica → clase CSS. */
  static SEVERITY_CLASS = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };

  /** Orden para escoger el mensaje dominante por línea. */
  static SEVERITY_RANK = { 8: 0, 4: 1, 2: 2, 1: 3 };

  /** Debounce entre cambios para evitar lintear cada keystroke. */
  static DEBOUNCE_MS = 300;

  /** Id del `<style>` inyectado. */
  static STYLE_ID = 'qc__gas-error-lens-styles';

  /** Longitud máxima del overlay antes de truncar. */
  static MAX_MESSAGE_LENGTH = 160;

  /** Severidad mínima a renderizar. */
  static MIN_SEVERITY = 1;

  /** Debounce del overlay ante cambios de contenido / layout. */
  static OVERLAY_DEBOUNCE_MS = 200;

  /**
   * Palabras reservadas que no pueden ser identificadores en un script
   * (modo no estricto, como los `.gs`). Se excluyen las contextuales
   * válidas como nombre (`get`, `set`, `of`, `from`, `as`, `async`,
   * `await`, `static`, `yield`, `undefined`) y las reservadas solo en
   * modo estricto (`implements`, `interface`, `package`, `private`,
   * `protected`, `public`).
   */
  static RESERVED_WORDS = new Set([
    'class','const','let','var','function','return','if','else','for','while',
    'do','switch','case','break','continue','default','try','catch','finally',
    'throw','new','delete','typeof','instanceof','in','extends','super',
    'this','import','export','null','true','false','void','enum',
    'debugger','with',
  ]);

  /** Operadores de asignación / actualización para la regla de const. */
  static ASSIGN_OPS_SOURCE =
    String.raw`(?:=|\+=|-=|\*=|\/=|%=|\*\*=|<<=|>>=|>>>=|&=|\|=|\^=|&&=|\|\|=|\?\?=|\+\+|--)`;

  /**
   * Inicio de línea que continúa la expresión de la línea anterior
   * (`.`, `?.`, operadores binarios, `,`, `)`, `]`, ternario). `++`/`--`
   * no cuentan: ASI los asocia a la línea siguiente.
   */
  static CONTINUATION_START_RE =
    /^(?:\?\.|\.|,|\)|\]|\?|:|&&|\|\||\?\?|[+-](?![+-])|[*/%&|^<>=]|instanceof\b|in\b)/;

  // ── Constructor ────────────────────────────────────────────────────────

  /**
   * Crea la instancia en estado deshabilitado. `enable()` debe llamarse
   * explícitamente cuando Monaco esté disponible.
   *
   * No registra listeners ni decoraciones aquí: el constructor es seguro
   * para ejecutarse antes de que `window.monaco` exista.
   */
  constructor() {
    this._enabled = false;
    /** Intención de estar activo (cubre el reintento mientras carga Monaco). */
    this._wantEnabled = false;
    this._enableRetryTimer = 0;
    /** Reglas regex personalizadas (opt-in). */
    this._customRulesEnabled = false;

    /** URIs pendientes de re-render tras `onDidChangeMarkers`. */
    this._pendingMarkerUris = new Set();
    this._markersTimer = 0;

    /** @type {Map<string, {timer:number, dispose:Function}>} */
    this._modelHooks = new Map();
    this._createDisposable = null;
    this._removeDisposable = null;

    this._markersDisposable = null;
    this._disposeModelDisposable = null;
    this._editorCreateDisposable = null;

    /** Decoraciones por URI. @type {Map<string,string[]>} */
    this._decorationIds = new Map();
    /** Estado de overlays por editor. @type {WeakMap<object,object>} */
    this._editorOverlays = new WeakMap();
    /** Editores trackeados. @type {Set<object>} */
    this._editors = new Set();

    /** Regex combinada de reasignación de const, cacheada por set de nombres. */
    this._constRegexCache = { key: '', re: null };
  }

  // ── Ciclo de vida ──────────────────────────────────────────────────────

  /**
   * Activa el renderer de diagnósticos (y las reglas personalizadas si
   * están habilitadas). Si Monaco aún no está cargado, reintenta en
   * 500 ms. Es idempotente: no duplica listeners ni decoraciones.
   */
  enable() {
    this._wantEnabled = true;
    if (this._enabled) return;
    if (!window.monaco?.editor) {
      clearTimeout(this._enableRetryTimer);
      this._enableRetryTimer = setTimeout(() => {
        if (this._wantEnabled) this.enable();
      }, 500);
      return;
    }
    this._enabled = true;
    this._injectStyles_();

    this._markersDisposable = monaco.editor.onDidChangeMarkers((uris) => this._onMarkersChanged_(uris));
    this._disposeModelDisposable = monaco.editor.onWillDisposeModel((m) => {
      this._decorationIds.delete(String(m.uri));
      this._detachLinter_(m);
    });
    this._createDisposable = monaco.editor.onDidCreateModel((m) => {
      if (this._customRulesEnabled) this._attachLinter_(m);
    });

    this._editorCreateDisposable = monaco.editor.onDidCreateEditor((ed) => this._attachEditor_(ed));
    if (window.jsWireMonacoEditor) this._attachEditor_(window.jsWireMonacoEditor);

    if (this._customRulesEnabled) this._startCustomRules_();
    this._refreshActiveModels_();
    this._debug_('enabled', { customRules: this._customRulesEnabled });
  }

  /**
   * Desactiva la lens: libera decoraciones, widgets, listeners y los
   * markers publicados por las reglas personalizadas. Es idempotente.
   */
  disable() {
    this._wantEnabled = false;
    clearTimeout(this._enableRetryTimer);
    if (!this._enabled) return;
    this._enabled = false;

    [
      this._markersDisposable,
      this._disposeModelDisposable,
      this._createDisposable,
      this._removeDisposable,
      this._editorCreateDisposable,
    ].forEach((d) => d?.dispose?.());
    this._markersDisposable = null;
    this._disposeModelDisposable = null;
    this._createDisposable = null;
    this._removeDisposable = null;
    this._editorCreateDisposable = null;

    clearTimeout(this._markersTimer);
    this._pendingMarkerUris.clear();

    this._stopCustomRules_();

    this._decorationIds.forEach((ids, uriStr) => {
      const m = monaco.editor.getModels().find((x) => String(x.uri) === uriStr);
      if (m && ids.length) m.deltaDecorations(ids, []);
    });
    this._decorationIds.clear();

    this._editors.forEach((ed) => this._detachEditor_(ed));
    this._editors.clear();

    document.getElementById(GasErrorLens.STYLE_ID)?.remove();
    this._debug_('disabled');
  }

  /**
   * Activa o desactiva las reglas regex personalizadas. Seguro de llamar
   * antes o después de `enable()`: si la lens no está activa solo guarda
   * la preferencia. Al desactivar limpia los markers del owner propio.
   * @param {boolean} enabled
   */
  setCustomRulesEnabled(enabled) {
    const next = enabled === true;
    if (next === this._customRulesEnabled) return;
    this._customRulesEnabled = next;
    this._debug_('custom rules', next ? 'on' : 'off');
    if (!this._enabled || !window.monaco?.editor) return;
    if (next) this._startCustomRules_();
    else      this._stopCustomRules_();
  }

  /** @returns {boolean} Si las reglas personalizadas están activas. */
  isCustomRulesEnabled() {
    return this._customRulesEnabled;
  }

  /**
   * Lintea texto plano con las reglas personalizadas y devuelve los
   * markers (no publica nada en Monaco). Útil para tests.
   * @param {string} text
   * @returns {Array<object>}
   */
  lintText(text) {
    const markers = [];
    this._lintLines_(String(text ?? '').split(/\r?\n/), markers);
    return markers;
  }

  // ── Selección de markers (pura) ────────────────────────────────────────

  /**
   * Elimina markers repetidos (mismo rango y mensaje), típico cuando
   * varios owners reportan el mismo diagnóstico.
   * @param {Array<object>} markers
   * @returns {Array<object>}
   */
  static dedupeMarkers(markers) {
    const seen = new Set();
    const out = [];
    for (const m of markers || []) {
      if (!m) continue;
      const key = [
        m.startLineNumber, m.startColumn, m.endLineNumber, m.endColumn,
        GasErrorLens.cleanMessage(m.message),
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }

  /**
   * Escoge un marker por línea para el mensaje inline: el de mayor
   * severidad (empate → el primero). Filtra por severidad mínima.
   * Devuelve el resultado ordenado por línea.
   * @param {Array<object>} markers
   * @param {number} [minSeverity]
   * @returns {Array<object>}
   */
  static selectInlineMarkers(markers, minSeverity = GasErrorLens.MIN_SEVERITY) {
    const byLine = new Map();
    for (const m of markers || []) {
      if (!m || (m.severity ?? 0) < minSeverity) continue;
      const cur = byLine.get(m.startLineNumber);
      if (!cur || (m.severity ?? 0) > (cur.severity ?? 0)) byLine.set(m.startLineNumber, m);
    }
    return Array.from(byLine.values()).sort((a, b) => a.startLineNumber - b.startLineNumber);
  }

  /** Colapsa whitespace y recorta puntos finales. */
  static cleanMessage(message) {
    return String(message || '').replace(/\s+/g, ' ').replace(/\.+\s*$/, '').trim();
  }

  // ── Renderer: reacción a cambios de markers ────────────────────────────

  /**
   * Acumula las URIs cambiadas y re-renderiza con debounce, solo para
   * los modelos activos en algún editor trackeado.
   * @param {Array<object>} uris
   * @private
   */
  _onMarkersChanged_(uris) {
    const active = this._activeModelUris_();
    (uris || []).forEach((uri) => {
      const uriStr = String(uri);
      if (active.has(uriStr)) this._pendingMarkerUris.add(uriStr);
    });
    if (!this._pendingMarkerUris.size) return;
    clearTimeout(this._markersTimer);
    this._markersTimer = setTimeout(() => {
      this._markersTimer = 0;
      if (!this._enabled) return;
      const pending = Array.from(this._pendingMarkerUris);
      this._pendingMarkerUris.clear();
      pending.forEach((uriStr) => this._refreshDecorationsForUri_(uriStr));
      this._refreshAllOverlays_();
    }, GasErrorLens.MARKERS_DEBOUNCE_MS);
  }

  /** URIs (string) de los modelos activos en editores trackeados. @private */
  _activeModelUris_() {
    const set = new Set();
    this._editors.forEach((ed) => {
      const model = ed.getModel?.();
      if (model) set.add(String(model.uri));
    });
    return set;
  }

  /** Refresca decoraciones y overlays de los modelos activos. @private */
  _refreshActiveModels_() {
    this._activeModelUris_().forEach((uriStr) => this._refreshDecorationsForUri_(uriStr));
    this._refreshAllOverlays_();
  }

  // ── Reglas personalizadas: arranque / parada ───────────────────────────

  /** Engancha el linter a todos los modelos existentes. @private */
  _startCustomRules_() {
    monaco.editor.getModels().forEach((m) => this._attachLinter_(m));
  }

  /** Desengancha el linter y limpia los markers propios. @private */
  _stopCustomRules_() {
    if (!window.monaco?.editor) {
      this._modelHooks.clear();
      return;
    }
    this._modelHooks.forEach((hook, uriStr) => {
      clearTimeout(hook.timer);
      hook.dispose?.();
      const m = monaco.editor.getModels().find((x) => String(x.uri) === uriStr);
      if (m) monaco.editor.setModelMarkers(m, GasErrorLens.MARKER_SOURCE, []);
    });
    this._modelHooks.clear();
  }

  /** Log de estado vía `DomUtils.debug` si existe. @private */
  _debug_(...args) {
    if (typeof DomUtils !== 'undefined' && typeof DomUtils.debug === 'function') {
      DomUtils.debug('ErrorLens', ...args);
    }
  }

  // ── Linter: enganche por modelo ────────────────────────────────────────

  /**
   * Engancha el linter a un modelo JS soportado.
   * @param {object} model
   * @private
   */
  _attachLinter_(model) {
    if (!this._enabled || !this._customRulesEnabled) return;
    // Modelos temporales de la vista previa de cambios: nunca se lintean.
    if (model?.uri?.scheme === 'gas-preview' || model?.uri?.scheme === 'gas-ghdiff') return;
    const lang = model.getLanguageId?.();
    if (!GasErrorLens.LANGUAGES.has(lang)) return;
    const uriStr = String(model.uri);
    if (this._modelHooks.has(uriStr)) return;

    const hook = { timer: 0, dispose: null };
    const schedule = () => {
      clearTimeout(hook.timer);
      hook.timer = setTimeout(() => this._lintModel_(model), GasErrorLens.DEBOUNCE_MS);
    };
    const sub = model.onDidChangeContent(schedule);
    hook.dispose = () => sub.dispose();
    this._modelHooks.set(uriStr, hook);
    this._lintModel_(model);
  }

  /**
   * Desengancha un modelo y limpia sus markers publicados.
   * @param {object} model
   * @private
   */
  _detachLinter_(model) {
    const uriStr = String(model.uri);
    const hook = this._modelHooks.get(uriStr);
    if (!hook) return;
    clearTimeout(hook.timer);
    hook.dispose?.();
    this._modelHooks.delete(uriStr);
    monaco.editor.setModelMarkers(model, GasErrorLens.MARKER_SOURCE, []);
  }

  /**
   * Lintea un modelo y publica markers.
   * @param {object} model
   * @private
   */
  _lintModel_(model) {
    if (!this._enabled || !this._customRulesEnabled) return;
    if (model.isDisposed?.()) return;
    if (!GasErrorLens.LANGUAGES.has(model.getLanguageId?.())) return;
    /** @type {Array<object>} */
    const markers = [];
    this._lintJs_(model, markers);
    monaco.editor.setModelMarkers(model, GasErrorLens.MARKER_SOURCE, markers);
  }

  /**
   * Helper único para crear markers a partir de coordenadas simples.
   * @param {Array}  out
   * @param {object} info `{line, col, length, message, severity, code?}`
   * @private
   */
  _addMarker_(out, info) {
    const length = Math.max(1, info.length || 1);
    out.push({
      startLineNumber: info.line,
      startColumn:     info.col,
      endLineNumber:   info.line,
      endColumn:       info.col + length,
      message:         info.message,
      severity:        info.severity,
      source:          GasErrorLens.MARKER_SOURCE,
      code:            info.code,
    });
  }

  // ── Linter JS ──────────────────────────────────────────────────────────

  /**
   * Lint completo en dos pasadas: primero se "limpian" todas las líneas
   * (sin strings, comentarios ni regex) y luego se aplican las reglas.
   * @param {object} model
   * @param {Array}  markers
   * @private
   */
  _lintJs_(model, markers) {
    const lineCount = model.getLineCount();
    const rawLines = new Array(lineCount);
    for (let i = 0; i < lineCount; i++) rawLines[i] = model.getLineContent(i + 1);
    this._lintLines_(rawLines, markers);
  }

  /**
   * Núcleo del linter sobre un array de líneas (sin dependencia de Monaco).
   * @param {string[]} rawLines Texto original por línea (índice 0 = línea 1).
   * @param {Array}    markers
   * @private
   */
  _lintLines_(rawLines, markers) {
    const lineCount = rawLines.length;
    /** @type {string[]} Texto sin strings/comentarios/regex por línea. */
    const bareLines = new Array(lineCount);
    let stripState = { inBlockComment: false, inTemplate: false };
    for (let i = 0; i < lineCount; i++) {
      const result = this._stripCodeFromLine_(rawLines[i], stripState);
      stripState = { inBlockComment: result.inBlockComment, inTemplate: result.inTemplate };
      bareLines[i] = result.bare;
    }

    const constRe = this._getConstReassignRegex_(this._collectConstNames_(bareLines.join('\n')));
    const counts = { '{': 0, '(': 0, '[': 0 };
    /** @type {Array<{ch:string, line:number, col:number}>} */
    const stack = [];
    let scanState  = { inBlockComment: false, inTemplate: false };

    for (let line = 1; line <= lineCount; line++) {
      const text = rawLines[line - 1];
      const result = { bare: bareLines[line - 1] };

      // Contexto al INICIO de la línea. Si el tope del stack es:
      //  - `{` de bloque (función, if, while, ...) → SÍ se marca falta de `;`.
      //  - `{` de objeto literal, `[` o `(` → NO se marca.
      const top = stack[stack.length - 1];
      const insideExpression =
        top && (
          (top.ch === '{' && top.isBlock === false) ||
          top.ch === '[' ||
          top.ch === '('
        );

      scanState = this._scanBracketsAndStrings_(text, line, markers, counts, stack, scanState);

      this._checkVariableWithoutName_(result.bare, line, markers);
      this._checkFunctionWithoutName_(result.bare, line, markers);
      this._checkAssignInCondition_(result.bare, line, markers);
      this._checkLooseEquality_(result.bare, line, markers);
      this._checkReservedAsIdentifier_(result.bare, line, markers);
      this._checkEmptyBlock_(result.bare, line, markers);
      this._checkConstReassignment_(result.bare, line, markers, constRe);
      this._checkDuplicateParams_(result.bare, line, markers);
      this._checkEmptyCatch_(result.bare, line, markers);
      this._checkUnreachableCode_(result.bare, line, markers);
      this._checkTypeofVsUndefined_(result.bare, line, markers);
      this._checkNaNComparison_(result.bare, line, markers);
      this._checkMissingSemicolon_(result.bare, line, markers, {
        insideExpression,
        nextBare: this._nextNonEmptyLine_(bareLines, line),
      });
    }

    while (stack.length) {
      const open = stack.pop();
      const closing = open.ch === '{' ? '}' : open.ch === '(' ? ')' : ']';
      this._addMarker_(markers, {
        line: open.line, col: open.col, length: 1,
        message: `Missing closing '${closing}' for '${open.ch}'`,
        severity: GasErrorLens.SEVERITY.Error,
        code: 'unclosed-bracket',
      });
    }
  }

  /**
   * Devuelve la siguiente línea "limpia" no vacía (sin espacios iniciales)
   * tras `line`, o `''` si no hay más.
   * @param {string[]} bareLines
   * @param {number} line Línea actual (1-based).
   * @returns {string}
   * @private
   */
  _nextNonEmptyLine_(bareLines, line) {
    for (let i = line; i < bareLines.length; i++) {
      const t = bareLines[i].trim();
      if (t) return t;
    }
    return '';
  }

  /**
   * Recoge nombres declarados con `const` (incluye destructuring básico).
   * Recibe el texto ya limpio de comentarios, strings, plantillas y
   * regex literals para no capturar `const` dentro de ellos.
   * @param {string} bareText
   * @returns {Set<string>}
   * @private
   */
  _collectConstNames_(bareText) {
    const names = new Set();
    const reSimple = /\bconst\s+([A-Za-z_$][\w$]*)/g;
    const reDestr  = /\bconst\s*\{([^}]*)\}/g;
    let m;
    while ((m = reSimple.exec(bareText)) !== null) names.add(m[1]);
    while ((m = reDestr.exec(bareText)) !== null) {
      m[1].split(',').forEach((part) => {
        const name = part.split(':').pop().trim().replace(/=.*$/, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      });
    }
    return names;
  }

  /**
   * Construye (o reutiliza del caché) una única regex combinada para
   * detectar reasignaciones de cualquiera de los nombres `const`.
   * @param {Set<string>} constNames
   * @returns {RegExp|null}
   * @private
   */
  _getConstReassignRegex_(constNames) {
    if (!constNames.size) return null;
    // Más largos primero para que la alternancia no corte prefijos.
    const sorted = Array.from(constNames).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    const key = sorted.join(',');
    if (this._constRegexCache.key === key && this._constRegexCache.re) {
      return this._constRegexCache.re;
    }
    const alternation = sorted.map((n) => this._escapeRegex_(n)).join('|');
    const re = new RegExp(
      String.raw`(^|[^.\w$?])(${alternation})\s*${GasErrorLens.ASSIGN_OPS_SOURCE}`,
      'g'
    );
    this._constRegexCache = { key, re };
    return re;
  }

  // ── Stripping y scanner estructural ────────────────────────────────────

  /**
   * Reemplaza strings, plantillas, regex literals y comentarios por
   * espacios para aplicar reglas regex sin falsos positivos. Preserva
   * columnas y propaga estado entre líneas (block comment + template).
   *
   * @param {string} text
   * @param {{inBlockComment:boolean, inTemplate:boolean}|boolean} state
   * @returns {{bare:string, inBlockComment:boolean, inTemplate:boolean}}
   * @private
   */
  _stripCodeFromLine_(text, state) {
    let inBlockComment = false;
    let inTemplate = false;
    if (typeof state === 'boolean') inBlockComment = state;
    else if (state) {
      inBlockComment = !!state.inBlockComment;
      inTemplate     = !!state.inTemplate;
    }

    let bare = '';
    let i = 0;
    let inString = inTemplate ? '`' : null;
    let inLineComment = false;
    let lastCh = '';

    // `/` inicia regex solo si el contexto previo lo permite.
    const isRegexAfter = (prev) =>
      !prev || !/[)\]\w$"'`]/.test(prev);

    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];

      if (inLineComment)  { bare += ' '; i++; continue; }
      if (inBlockComment) {
        if (ch === '*' && next === '/') { bare += '  '; inBlockComment = false; i += 2; continue; }
        bare += ' '; i++; continue;
      }
      if (inString) {
        if (ch === '\\') { bare += '  '; i += 2; continue; }
        if (ch === inString) { bare += ' '; inString = null; i++; continue; }
        bare += ' '; i++; continue;
      }

      if (ch === '/' && next === '/') { inLineComment = true; bare += '  '; i += 2; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; bare += '  '; i += 2; continue; }

      if (ch === '/' && isRegexAfter(lastCh)) {
        const closeIdx = this._findRegexEnd_(text, i + 1);
        if (closeIdx !== -1) {
          bare += ' '.repeat(closeIdx - i + 1);
          i = closeIdx + 1;
          while (i < text.length && /[a-zA-Z]/.test(text[i])) { bare += ' '; i++; }
          lastCh = ' ';
          continue;
        }
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        bare += ' ';
        i++;
        continue;
      }

      bare += ch;
      if (ch !== ' ' && ch !== '\t') lastCh = ch;
      i++;
    }

    return { bare, inBlockComment, inTemplate: inString === '`' };
  }

  /**
   * Encuentra el `/` de cierre de un regex literal, respetando escapes y
   * `[...]` character classes.
   * @param {string} text
   * @param {number} from
   * @returns {number} Offset del `/` final o `-1`.
   * @private
   */
  _findRegexEnd_(text, from) {
    let inClass = false;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '[')  { inClass = true; continue; }
      if (ch === ']')  { inClass = false; continue; }
      if (ch === '/' && !inClass) return i;
      if (ch === '\n') return -1;
    }
    return -1;
  }

  /**
   * Conteo global de brackets y detección de strings sin cerrar. Soporta
   * regex literals y propaga estado entre líneas.
   *
   * @param {string} text
   * @param {number} line
   * @param {Array}  out
   * @param {object} counts Contadores `{}`, `()`, `[]`.
   * @param {Array}  stack Pila de aperturas pendientes.
   * @param {{inBlockComment:boolean, inTemplate:boolean}|boolean} state
   * @returns {{inBlockComment:boolean, inTemplate:boolean}}
   * @private
   */
  _scanBracketsAndStrings_(text, line, out, counts, stack, state) {
    let inBlockComment = false;
    let inTemplate = false;
    if (typeof state === 'boolean') inBlockComment = state;
    else if (state) {
      inBlockComment = !!state.inBlockComment;
      inTemplate     = !!state.inTemplate;
    }

    let i = 0;
    let inString = inTemplate ? '`' : null;
    let inLineComment = false;
    let lastCh = '';
    let lastSignificant = ''; // último char no-blanco antes del bracket actual

    const isRegexAfter = (prev) =>
      !prev || !/[)\]\w$"'`]/.test(prev);

    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];

      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
        i++; continue;
      }
      if (inString) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inString) { inString = null; i++; continue; }
        i++; continue;
      }

      if (ch === '/' && next === '/') { inLineComment = true; break; }
      if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }

      if (ch === '/' && isRegexAfter(lastCh)) {
        const closeIdx = this._findRegexEnd_(text, i + 1);
        if (closeIdx !== -1) {
          i = closeIdx + 1;
          while (i < text.length && /[a-zA-Z]/.test(text[i])) i++;
          lastCh = ' ';
          lastSignificant = ')';
          continue;
        }
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        lastSignificant = ch;
        i++;
        continue;
      }

      if (ch === '{' || ch === '(' || ch === '[') {
        counts[ch]++;
        // Marcamos si el `{` es bloque de código (no objeto literal).
        // Heurística: tras `)`, `=>`, `else`, `do`, `try`, `finally`,
        // `{`, `}`, `;` o inicio de línea → es bloque. Tras `=`, `(`,
        // `,`, `:`, `[`, `return` → es objeto literal/expresión.
        let isBlock = false;
        if (ch === '{') {
          isBlock = this._looksLikeBlockOpener_(text, i, lastSignificant);
        }
        stack.push({ ch, line, col: i + 1, isBlock });
      } else if (ch === '}' || ch === ')' || ch === ']') {
        const open = ch === '}' ? '{' : ch === ')' ? '(' : '[';
        if (counts[open] > 0) { counts[open]--; stack.pop(); }
        else this._addMarker_(out, {
          line, col: i + 1, length: 1,
          message: `Unmatched closing '${ch}'`,
          severity: GasErrorLens.SEVERITY.Error,
          code: 'unmatched-close',
        });
      }
      if (ch !== ' ' && ch !== '\t') {
        lastCh = ch;
        lastSignificant = ch;
      }
      i++;
    }

    if (inString && inString !== '`') {
      this._addMarker_(out, {
        line, col: Math.max(1, text.length), length: 1,
        message: `Unterminated string literal (${inString})`,
        severity: GasErrorLens.SEVERITY.Error,
        code: 'unterminated-string',
      });
      inString = null;
    }

    return { inBlockComment, inTemplate: inString === '`' };
  }

  /**
   * Heurística: decide si un `{` en `pos` abre un bloque de código (cuerpo
   * de función, if, for, etc.) o un objeto literal.
   * @param {string} text
   * @param {number} pos Offset del `{`.
   * @param {string} lastSignificant Último char no-blanco antes.
   * @returns {boolean} `true` si parece bloque de código.
   * @private
   */
  _looksLikeBlockOpener_(text, pos, lastSignificant) {
    const before = text.slice(0, pos);
    const trimmed = before.replace(/\s+$/, '');
    // Inicio de archivo o tras `;` `}` `{` → bloque.
    if (!lastSignificant) return true;
    if (';}{'.includes(lastSignificant)) return true;
    // Tras `)` casi siempre es bloque (function, if, for, while, =>).
    if (lastSignificant === ')') return true;
    // Tras `=>` arrow → bloque.
    if (/=>\s*$/.test(trimmed)) return true;
    // Tras keywords que abren bloque sin `()`.
    if (/\b(do|else|try|finally)\s*$/.test(trimmed)) return true;
    // Tras keyword `class` con/sin nombre.
    if (/\bclass\b[^{]*$/.test(trimmed)) return true;
    // Cualquier otro caso (después de `=`, `,`, `(`, `[`, `:`, `return`,
    // operadores) → expresión / objeto literal.
    return false;
  }

  // ── Reglas JS individuales ─────────────────────────────────────────────

  /** `const|let|var` sin nombre. Ignora destructuring `{...}` o `[...]`. @private */
  _checkVariableWithoutName_(bare, line, out) {
    const re = /\b(const|let|var)\b(\s*)(?=[^A-Za-z_$\s]|$)/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      // Lo que sigue al keyword.
      const rest = bare.slice(m.index + m[0].length);
      // Permitir destructuring: `const {...}` o `const [...]`.
      if (/^[{[]/.test(rest)) continue;
      if (/^[A-Za-z_$]/.test(rest)) continue;
      this._addMarker_(out, {
        line, col: m.index + 1, length: m[1].length,
        message: `Missing variable name after '${m[1]}'`,
        severity: GasErrorLens.SEVERITY.Error,
        code: 'missing-variable-name',
      });
    }
  }

  /** Declaración `function` sin nombre. @private */
  _checkFunctionWithoutName_(bare, line, out) {
    const re = /(^|\s)(?:export\s+)?(?:async\s+)?function\s*\(/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const before = bare.slice(0, m.index).trim();
      const isDeclaration = before === '' || /^(export|async)$/.test(before);
      if (!isDeclaration) continue;
      const col = m.index + (m[1] ? m[1].length : 0) + 1;
      this._addMarker_(out, {
        line, col, length: 'function'.length,
        message: 'Function declaration requires a name',
        severity: GasErrorLens.SEVERITY.Error,
        code: 'missing-function-name',
      });
    }
  }

  /** `if (x = y)` o `while (x = y)`: asignación en condición. @private */
  _checkAssignInCondition_(bare, line, out) {
    const re = /\b(if|while)\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      // Consideramos solo `=` simple, NO precedido ni seguido por `=`,
      // `!`, `<`, `>` (excluye `==`, `===`, `!=`, `!==`, `<=`, `>=`).
      if (/(?:^|[^=!<>])=(?![=>])/.test(m[2])) {
        this._addMarker_(out, {
          line, col: m.index + 1, length: m[0].length,
          message: `Assignment in '${m[1]}' condition. Did you mean '==' or '==='?`,
          severity: GasErrorLens.SEVERITY.Warning,
          code: 'assign-in-condition',
        });
      }
    }
  }

  /** `==` / `!=` en lugar de `===` / `!==`. @private */
  _checkLooseEquality_(bare, line, out) {
    // Captura `==` o `!=` que NO sean parte de `===`, `!==`, `>=`, `<=`,
    // ni `=>` (arrow). Mira los caracteres a izquierda y derecha.
    const re = /(^|[^=!<>])([!=]==?)(=?)/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const op = m[2];
      const trailingEq = m[3];
      if (trailingEq) continue; // Ya es `===` o `!==`.
      if (op !== '==' && op !== '!=') continue;
      // Comparar con `undefined`/`null` ya lo cubre `_checkTypeofVsUndefined_`.
      const after = bare.slice(m.index + m[1].length + op.length).trimStart();
      if (/^(undefined|null)\b/.test(after)) continue;
      const before = bare.slice(0, m.index + m[1].length).trimEnd();
      if (/\b(undefined|null)$/.test(before)) continue;
      const col = m.index + m[1].length + 1;
      this._addMarker_(out, {
        line, col, length: op.length,
        message: `Use strict equality '${op === '==' ? '===' : '!=='}' instead of '${op}'`,
        severity: GasErrorLens.SEVERITY.Warning,
        code: 'loose-equality',
      });
    }
  }

  /** Palabra reservada usada como identificador. @private */
  _checkReservedAsIdentifier_(bare, line, out) {
    const re = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const name = m[1];
      if (!GasErrorLens.RESERVED_WORDS.has(name)) continue;
      const col = m.index + m[0].length - name.length + 1;
      this._addMarker_(out, {
        line, col, length: name.length,
        message: `'${name}' is a reserved word and cannot be used as identifier`,
        severity: GasErrorLens.SEVERITY.Error,
        code: 'reserved-as-identifier',
      });
    }
  }

  /** Bloque vacío después de `if|for|while`. @private */
  _checkEmptyBlock_(bare, line, out) {
    const re = /\b(if|for|while)\s*\([^)]*\)\s*\{\s*\}/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      this._addMarker_(out, {
        line, col: m.index + 1, length: m[0].length,
        message: `Empty '${m[1]}' block`,
        severity: GasErrorLens.SEVERITY.Warning,
        code: 'empty-block',
      });
    }
  }

  /**
   * Reasignación de constante a nivel de archivo (sin scope). Excluye
   * accesos a propiedad (`.PI`, `?.PI`), propiedades en objetos
   * literales (`{ PI: 3 }`) y patrones de destructuring (`const { a = 5 }`).
   * @param {RegExp|null} re Regex combinada de `_getConstReassignRegex_`.
   * @private
   */
  _checkConstReassignment_(bare, line, out, re) {
    if (!re) return;
    // Si la línea declara destructuring (`const {...}` o `const [...]`),
    // saltamos toda la línea: los `name = default` son valores por defecto.
    if (/\b(const|let|var)\s*[{[]/.test(bare)) return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const name = m[2];
      // Saltar la propia declaración: `const NAME = ...` o `let NAME = ...`.
      const upTo = bare.slice(0, m.index + (m[1] ? m[1].length : 0));
      if (/\b(const|let|var)\s+$/.test(upTo)) continue;
      // Saltar propiedad (después de `:` o `?`).
      const before = m[1];
      if (before === ':' || before === '?') continue;
      // Saltar `==`, `===` y `=>` (arrow): nuestra regex usa `=` simple
      // como ancla de asignación.
      const after = bare.slice(m.index + m[0].length, m.index + m[0].length + 1);
      if (m[0].endsWith('=') && (after === '=' || after === '>')) continue;
      // Saltar parámetros de arrow function: `(NAME)` o `NAME` justo
      // antes de `=>` no son asignaciones aunque la regex los matchee
      // porque tras el nombre puede venir `=>` con espacios intermedios.
      const restAfter = bare.slice(m.index + m[1].length + name.length).trimStart();
      if (restAfter.startsWith('=>')) continue;
      const col = m.index + (m[1] ? m[1].length : 0) + 1;
      this._addMarker_(out, {
        line, col, length: name.length,
        message: `Cannot reassign constant '${name}'`,
        severity: GasErrorLens.SEVERITY.Error,
        code: 'const-reassignment',
      });
    }
  }

  /** Parámetros duplicados en declaración de función. @private */
  _checkDuplicateParams_(bare, line, out) {
    const re = /\bfunction\b[^(]*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const seen = new Set();
      const params = m[1].split(',').map((p) => p.trim().split('=')[0].trim());
      for (const p of params) {
        if (!p || !/^[A-Za-z_$][\w$]*$/.test(p)) continue;
        if (seen.has(p)) {
          const col = m.index + m[0].indexOf('(') + 1 + m[1].indexOf(p) + 1;
          this._addMarker_(out, {
            line, col, length: p.length,
            message: `Duplicate parameter '${p}'`,
            severity: GasErrorLens.SEVERITY.Error,
            code: 'duplicate-param',
          });
        }
        seen.add(p);
      }
    }
  }

  /** Bloque `catch` vacío. @private */
  _checkEmptyCatch_(bare, line, out) {
    const re = /\bcatch\s*(?:\([^)]*\)\s*)?\{\s*\}/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      this._addMarker_(out, {
        line, col: m.index + 1, length: m[0].length,
        message: 'Empty catch block (consider logging the error)',
        severity: GasErrorLens.SEVERITY.Warning,
        code: 'empty-catch',
      });
    }
  }

  /**
   * Código inalcanzable inmediatamente después de `return`/`throw`/`break`/
   * `continue`. Solo marca cuando la sentencia es independiente en su
   * bloque (inicio de línea, tras `;` o tras `{`), no cuando depende de
   * `if (...)`, `else`, `for (...)` o una etiqueta `case ...:` en la misma
   * línea, y solo si lo que sigue no es cierre de bloque ni otro `case`.
   * @private
   */
  _checkUnreachableCode_(bare, line, out) {
    const re = /\b(return|throw|break|continue)\b[^;]*;/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      // Debe ser sentencia independiente: nada antes, o tras `;` / `{`.
      const before = bare.slice(0, m.index).trimEnd();
      if (before && !/[;{]$/.test(before)) continue;
      // `return function () { a(); b(); }` → el `;` cae dentro de llaves:
      // la sentencia no terminó ahí.
      if (!this._bracketsBalanced_(m[0])) continue;
      const after = bare.slice(m.index + m[0].length).trim();
      // Permitidos: nada, cierre de bloque/expresión, nueva etiqueta.
      if (!after) continue;
      if (/^[)\]}]/.test(after)) continue;
      if (/^(case\b|default\s*:)/.test(after)) continue;
      const col = m.index + m[0].length + 1;
      this._addMarker_(out, {
        line, col, length: Math.min(20, after.length),
        message: `Unreachable code after '${m[1]}'`,
        severity: GasErrorLens.SEVERITY.Warning,
        code: 'unreachable',
      });
    }
  }

  /** `x == undefined` → sugiere `===` / `typeof`. @private */
  _checkTypeofVsUndefined_(bare, line, out) {
    const re = /([\w$]+)\s*(==|!=)\s*undefined\b/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      this._addMarker_(out, {
        line, col: m.index + 1, length: m[0].length,
        message: `Use '${m[1]} ${m[2] === '==' ? '===' : '!=='} undefined' or 'typeof ${m[1]} ${m[2] === '==' ? '===' : '!=='} \\'undefined\\''`,
        severity: GasErrorLens.SEVERITY.Warning,
        code: 'undefined-comparison',
      });
    }
  }

  /**
   * Comparación con `NaN`: siempre es falsa. Sugiere `Number.isNaN(x)`.
   * @private
   */
  _checkNaNComparison_(bare, line, out) {
    const re = /([\w$.]+)\s*(===|!==|==|!=)\s*NaN\b|\bNaN\s*(===|!==|==|!=)\s*([\w$.]+)/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const expr = m[1] || m[4];
      this._addMarker_(out, {
        line, col: m.index + 1, length: m[0].length,
        message: `Comparison with NaN is always false. Use 'Number.isNaN(${expr})'`,
        severity: GasErrorLens.SEVERITY.Warning,
        code: 'nan-comparison',
      });
    }
  }

  /**
   * Punto y coma faltante al final de una sentencia. Heurística
   * conservadora: solo marca cuando la línea claramente es una sentencia
   * ejecutable. Descarta:
   *  - Líneas dentro de objeto literal `{...}`, array `[...]` o
   *    argumentos `(...)` (separadas por coma, no por `;`).
   *  - Líneas vacías o que terminan en terminador / continuador válido.
   *  - Etiquetas `case ... :` / `default:`.
   *  - Cierre de bloque y aperturas de control.
   *  - Decoradores TS (`@thing`).
   *  - Method chaining (termina en `)` o `]`).
   *
   * Excepción: si la línea empieza con declaración (`const|let|var ...`)
   * y los brackets están balanceados (apertura y cierre en la misma
   * línea), se exige `;` aunque termine en `}` o `]`.
   *
   * @param {string} bare
   * @param {number} line
   * @param {Array}  out
   * También descarta la línea si la siguiente línea no vacía continúa la
   * expresión (`.method()`, `?.x`, `+ y`, `&& z`, `, w`, `)` ...).
   *
   * @param {{insideExpression:boolean, nextBare?:string}} ctx Contexto al inicio de la línea.
   * @private
   */
  _checkMissingSemicolon_(bare, line, out, ctx) {
    if (ctx && ctx.insideExpression) return;
    if (ctx?.nextBare && GasErrorLens.CONTINUATION_START_RE.test(ctx.nextBare)) return;

    const trimmed = bare.replace(/\s+$/, '');
    if (!trimmed || !trimmed.trim()) return;

    const stripped = trimmed.trim();
    const lastChar = trimmed.slice(-1);

    // Caso especial: declaración con objeto/array literal en una línea.
    // `const x = {...}` o `let arr = [...]` → exigir `;`.
    const isDeclWithLiteral =
      (lastChar === '}' || lastChar === ']') &&
      /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$]/.test(stripped) &&
      /=/.test(stripped) &&
      this._bracketsBalanced_(bare);
    if (isDeclWithLiteral) {
      this._addMarker_(out, {
        line, col: trimmed.length, length: 1,
        message: 'Missing semicolon at end of statement',
        severity: GasErrorLens.SEVERITY.Hint,
        code: 'missing-semicolon',
      });
      return;
    }

    if (';,{}([:'.includes(lastChar)) return;
    if ('+-*/%=&|^<>?!.~'.includes(lastChar)) return;
    if (/(?:=>|\+\+|--|&&|\|\||\*\*|\?\?|==|!=|<=|>=)$/.test(trimmed)) return;

    if (/^(case\b.*|default)\s*:$/.test(stripped)) return;

    const startsControl = /^\s*(?:export\s+)?(?:async\s+)?(if|else|for|while|do|switch|try|catch|finally|function|class|interface|enum)\b/.test(stripped);
    if (startsControl) {
      if (!/[)}\]]\s*=[^=]/.test(stripped) && !/\b(return|throw|break|continue|var|let|const)\b\s+\S/.test(stripped)) {
        return;
      }
    }

    if (/^[\s})\]]+(\s*(else|catch|finally|while)\b.*)?[{(]?\s*$/.test(stripped)) return;
    if (/^@\w/.test(stripped)) return;
    // Method chaining: termina en `)` o `]`.
    if (/[)\]]$/.test(stripped) && /^[.\[]/.test(stripped)) return;
    if (/[)\]]$/.test(stripped) &&
        !/[=]/.test(stripped) &&
        !/\b(return|throw|break|continue|var|let|const|yield|await|new|delete|typeof|void)\b/.test(stripped)) {
      return;
    }

    this._addMarker_(out, {
      line, col: trimmed.length, length: 1,
      message: 'Missing semicolon at end of statement',
      severity: GasErrorLens.SEVERITY.Hint,
      code: 'missing-semicolon',
    });
  }

  /**
   * Verifica que la línea tenga sus brackets balanceados (`{}`, `[]`, `()`).
   * Útil para distinguir `const x = {...}` (completo) de `const x = {`
   * (apertura multilínea).
   * @param {string} bare
   * @returns {boolean}
   * @private
   */
  _bracketsBalanced_(bare) {
    let curly = 0, square = 0, paren = 0;
    for (let i = 0; i < bare.length; i++) {
      const c = bare[i];
      if (c === '{') curly++;
      else if (c === '}') curly--;
      else if (c === '[') square++;
      else if (c === ']') square--;
      else if (c === '(') paren++;
      else if (c === ')') paren--;
    }
    return curly === 0 && square === 0 && paren === 0;
  }

  /** Escapa caracteres especiales de regex. @private */
  _escapeRegex_(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Renderer: decoraciones inline (subrayado + canaleta) ───────────────

  /** Refresca subrayado y canaleta para los markers de un modelo. @private */
  _refreshDecorationsForUri_(uri) {
    const uriStr = String(uri);
    const model  = monaco.editor.getModels().find((m) => String(m.uri) === uriStr);
    if (!model) {
      this._decorationIds.delete(uriStr);
      return;
    }
    const all      = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
    const filtered = GasErrorLens.dedupeMarkers(this._filterMarkers_(all));
    const decors   = filtered.map((m) => this._buildInlineDecoration_(m));
    const oldIds   = this._decorationIds.get(uriStr) || [];
    const newIds   = model.deltaDecorations(oldIds, decors);
    this._decorationIds.set(uriStr, newIds);
  }

  /** Filtra por severidad mínima. @private */
  _filterMarkers_(markers) {
    return markers.filter((m) => (m.severity ?? 0) >= GasErrorLens.MIN_SEVERITY);
  }

  /** Devuelve un solo marker por línea, el de mayor severidad. @private */
  _dedupePerLine_(markers) {
    return GasErrorLens.selectInlineMarkers(markers, 0);
  }

  /** Decoración con subrayado y acento de canaleta. @private */
  _buildInlineDecoration_(marker) {
    const sev = GasErrorLens.SEVERITY_CLASS[marker.severity] || 'info';
    return {
      range: {
        startLineNumber: marker.startLineNumber,
        startColumn:     marker.startColumn,
        endLineNumber:   marker.endLineNumber,
        endColumn:       marker.endColumn,
      },
      options: {
        inlineClassName:           `qc__gel-inline qc__gel-inline-${sev}`,
        linesDecorationsClassName: `qc__gel-gutter qc__gel-gutter-${sev}`,
        hoverMessage:              this._buildHoverMessage_(marker),
        stickiness:                1,
      },
    };
  }

  /** Tooltip con severidad, código y source. @private */
  _buildHoverMessage_(marker) {
    const sev  = (GasErrorLens.SEVERITY_CLASS[marker.severity] || 'info').toUpperCase();
    const code = marker.code
      ? ` [${typeof marker.code === 'string' ? marker.code : marker.code.value}]`
      : '';
    const src  = marker.source ? ` _(${marker.source})_` : '';
    const text = this._cleanMessage_(marker.message);
    return { value: `**${sev}**${code}${src} — ${text}` };
  }

  // ── Renderer: overlay con content widgets ──────────────────────────────

  /**
   * Engancha un editor y registra los content widgets que mostrarán el
   * mensaje al final de la línea.
   * @param {object} editor
   * @private
   */
  _attachEditor_(editor) {
    if (!editor || this._editorOverlays.has(editor)) return;
    // Editores internos del visor del diff de GitHub (modelos gas-ghdiff:): no son del proyecto.
    if (editor.getContainerDomNode?.()?.closest?.('.qc__dv-editor')) return;
    /** @type {Map<string, object>} */
    const widgets = new Map();
    // Contenido y layout cambian en ráfagas (keystrokes, resize): el
    // overlay se reconcilia con debounce. Los markers nuevos ya disparan
    // `_refreshAllOverlays_` desde `onDidChangeMarkers`.
    const scheduleRender = DomUtils.debounce(
      () => this._renderOverlay_(editor),
      GasErrorLens.OVERLAY_DEBOUNCE_MS
    );
    const subs = [
      editor.onDidChangeModel(() => {
        scheduleRender.cancel();
        // Solo se decoran modelos activos: al cambiar de archivo se refresca el nuevo.
        const model = editor.getModel?.();
        if (model) this._refreshDecorationsForUri_(model.uri);
        this._renderOverlay_(editor);
      }),
      editor.onDidChangeModelContent(scheduleRender),
      editor.onDidLayoutChange(scheduleRender),
      editor.onDidDispose?.(() => {
        this._detachEditor_(editor);
        this._editors.delete(editor);
      }),
    ];
    this._editorOverlays.set(editor, { widgets, subs, scheduleRender });
    this._editors.add(editor);
    this._renderOverlay_(editor);
  }

  /** Libera widgets y listeners de un editor. @private */
  _detachEditor_(editor) {
    const state = this._editorOverlays.get(editor);
    if (!state) return;
    state.scheduleRender?.cancel();
    state.subs.forEach((s) => s?.dispose?.());
    state.widgets.forEach((w) => {
      try { editor.removeContentWidget(w); } catch (_) { /* editor ya liberado */ }
    });
    state.widgets.clear();
    this._editorOverlays.delete(editor);
  }

  /** Refresca todos los overlays. @private */
  _refreshAllOverlays_() {
    this._editors.forEach((ed) => this._renderOverlay_(ed));
  }

  /**
   * Reconcilia content widgets para los markers actuales del modelo.
   * @param {object} editor
   * @private
   */
  _renderOverlay_(editor) {
    const state = this._editorOverlays.get(editor);
    if (!state) return;
    const model = editor.getModel?.();
    if (!model) {
      state.widgets.forEach((w) => editor.removeContentWidget(w));
      state.widgets.clear();
      return;
    }

    const all     = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
    const perLine = GasErrorLens.selectInlineMarkers(all);
    /** @type {Map<string, object>} */
    const desired = new Map();
    for (const m of perLine) desired.set(`qc-gel-${m.startLineNumber}`, m);

    for (const [id, widget] of state.widgets) {
      if (!desired.has(id)) {
        editor.removeContentWidget(widget);
        state.widgets.delete(id);
      }
    }

    for (const [id, marker] of desired) {
      const sev  = GasErrorLens.SEVERITY_CLASS[marker.severity] || 'info';
      const text = this._truncate_(this._cleanMessage_(marker.message));
      const col  = model.getLineMaxColumn(marker.startLineNumber);
      const existing = state.widgets.get(id);
      if (existing) {
        existing._domNode.className   = `qc__gel-msg qc__gel-msg-${sev}`;
        existing._domNode.textContent = text;
        existing._domNode.title       = this._cleanMessage_(marker.message);
        existing._line = marker.startLineNumber;
        existing._col  = col;
        editor.layoutContentWidget(existing);
        continue;
      }

      const dom = document.createElement('div');
      dom.className   = `qc__gel-msg qc__gel-msg-${sev}`;
      dom.textContent = text;
      dom.title       = this._cleanMessage_(marker.message);

      const widget = {
        _id: id, _domNode: dom, _line: marker.startLineNumber, _col: col,
        getId()      { return this._id; },
        getDomNode() { return this._domNode; },
        getPosition() {
          return {
            position:   { lineNumber: this._line, column: this._col },
            preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
          };
        },
      };
      editor.addContentWidget(widget);
      state.widgets.set(id, widget);
    }
  }

  // ── Utilidades de texto ────────────────────────────────────────────────

  /** Colapsa whitespace y recorta puntos finales. @private */
  _cleanMessage_(message) {
    return GasErrorLens.cleanMessage(message);
  }

  /** Trunca el mensaje para preservar el layout. @private */
  _truncate_(message) {
    const max = GasErrorLens.MAX_MESSAGE_LENGTH;
    return message.length <= max ? message : message.slice(0, max - 1) + '…';
  }

  // ── Estilos ────────────────────────────────────────────────────────────

  /** Inyecta el `<style>` con paleta y reglas. Idempotente. @private */
  _injectStyles_() {
    if (document.getElementById(GasErrorLens.STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = GasErrorLens.STYLE_ID;
    style.textContent = `
      /* Colores del tema activo de Monaco (--vscode-*) con fallback. */
      .monaco-editor {
        --qc-gel-error: var(--vscode-editorError-foreground, #e06c75);
        --qc-gel-warning: var(--vscode-editorWarning-foreground, #d19a66);
        --qc-gel-info: var(--vscode-editorInfo-foreground, #61afef);
        --qc-gel-hint: var(--vscode-editorHint-foreground, #98c379);
      }
      .qc__gel-msg {
        font-family: var(--monaco-monospace-font, monospace);
        font-size: 12px;
        font-style: italic;
        line-height: 18px;
        padding: 0 4px;
        margin-left: 16px;
        pointer-events: none;
        white-space: nowrap;
        user-select: none;
      }
      .qc__gel-msg-error    { color: var(--qc-gel-error); }
      .qc__gel-msg-warning  { color: var(--qc-gel-warning); }
      .qc__gel-msg-info     { color: var(--qc-gel-info); }
      .qc__gel-msg-hint     { color: var(--qc-gel-hint); }

      .qc__gel-inline {
        text-decoration-line: underline;
        text-decoration-style: wavy;
        text-decoration-skip-ink: none;
        text-underline-offset: 3px;
      }
      .qc__gel-inline-error    { text-decoration-color: color-mix(in srgb, var(--qc-gel-error) 85%, transparent); }
      .qc__gel-inline-warning  { text-decoration-color: color-mix(in srgb, var(--qc-gel-warning) 85%, transparent); }
      .qc__gel-inline-info     { text-decoration-color: color-mix(in srgb, var(--qc-gel-info) 85%, transparent); }
      .qc__gel-inline-hint     { text-decoration-color: color-mix(in srgb, var(--qc-gel-hint) 85%, transparent); }

      .qc__gel-gutter { width: 3px !important; margin-left: 3px; }
      .qc__gel-gutter-error    { background: var(--qc-gel-error); }
      .qc__gel-gutter-warning  { background: var(--qc-gel-warning); }
      .qc__gel-gutter-info     { background: var(--qc-gel-info); }
      .qc__gel-gutter-hint     { background: var(--qc-gel-hint); }

      /* Modo oscuro: Monaco va invertido; hue-rotate recupera el tono semántico. */
      body.qc__is-dark-mode .qc__gel-msg,
      body.qc__is-dark-mode .qc__gel-gutter { filter: hue-rotate(180deg); }
    `;
    document.head.appendChild(style);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  const errorLens = new GasErrorLens();
  let initialConfigApplied = false;
  // Pausa global propia: los deltas no deben reactivar el servicio en pausa.
  let paused = false;
  const isPaused_ = () => paused || window.__gasGloballyDisabled === true;

  const applyToggle = (enabled) => {
    if (enabled) errorLens.enable();
    else         errorLens.disable();
  };

  document.addEventListener('GAS_TransferData', (e) => {
    if (initialConfigApplied) return;
    initialConfigApplied = true;
    try {
      const data     = JSON.parse(e.detail);
      const settings = data.settings || {};
      if (settings['global-enable'] === false) paused = true;
      errorLens.setCustomRulesEnabled(settings['gas-error-lens-custom-rules'] === true);
      applyToggle(!paused && settings['gas-error-lens'] !== false);
    } catch (_) { /* payload inválido */ }
  });

  document.addEventListener('GAS_SettingsUpdated', (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('global-enable' in options) {
        paused = !options['global-enable'];
        if (paused) { applyToggle(false); return; }
      } else if (isPaused_()) {
        return;
      }
      if ('gas-error-lens-custom-rules' in options) {
        errorLens.setCustomRulesEnabled(options['gas-error-lens-custom-rules'] === true);
      }
      if ('gas-error-lens' in options) applyToggle(!!options['gas-error-lens']);
    } catch (_) { /* payload inválido */ }
  });

  document.addEventListener('GAS_GlobalDisable', () => { paused = true; applyToggle(false); });
  document.addEventListener('GAS_GlobalEnable',  () => { paused = false; });

  window.gasErrorLens = errorLens;
})();
