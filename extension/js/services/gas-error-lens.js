"use strict";

/**
 * @fileoverview Error Lens para Monaco en el editor de Google Apps Script.
 * Solo lintea archivos JavaScript / TypeScript / GAS. Inspirado en
 * https://github.com/usernamehw/vscode-error-lens.
 *
 * Tres responsabilidades:
 *  - Linter: reglas regex sobre cada línea + parser nativo `new Function`.
 *  - Decoraciones: subrayado ondulado y barra en la canaleta por severidad.
 *  - Overlay: mensaje al final de la línea como Monaco content widget.
 */
class GasErrorLens {

  // ── Configuración ──────────────────────────────────────────────────────

  /** Lenguajes soportados. */
  static LANGUAGES = new Set(['javascript', 'typescript', 'google apps script']);

  /** Source publicado en los markers. */
  static MARKER_SOURCE = 'gas-tools';

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

  /** Palabras reservadas que no pueden ser identificadores. */
  static RESERVED_WORDS = new Set([
    'class','const','let','var','function','return','if','else','for','while',
    'do','switch','case','break','continue','default','try','catch','finally',
    'throw','new','delete','typeof','instanceof','in','of','extends','super',
    'this','async','await','yield','import','export','from','as','static',
    'get','set','null','true','false','undefined','void','enum','implements',
    'interface','package','private','protected','public',
  ]);

  // ── Constructor ────────────────────────────────────────────────────────

  constructor() {
    this._enabled = false;

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

    // Trusted Types bloquea `new Function`. Si el host lo aplica,
    // desactivamos el parser nativo de entrada (regex sigue activo).
    this._syntaxParserAvailable =
      (typeof window !== 'undefined' && window.trustedTypes) ? false : null;
  }

  // ── Ciclo de vida ──────────────────────────────────────────────────────

  /** Activa linter, decoraciones y overlay. Idempotente. */
  enable() {
    if (this._enabled) return;
    if (!window.monaco?.editor) {
      setTimeout(() => this.enable(), 500);
      return;
    }
    this._enabled = true;
    this._injectStyles_();

    this._markersDisposable = monaco.editor.onDidChangeMarkers((uris) => {
      uris.forEach((uri) => this._refreshDecorationsForUri_(uri));
      this._refreshAllOverlays_();
    });
    this._disposeModelDisposable = monaco.editor.onWillDisposeModel((m) => {
      this._decorationIds.delete(String(m.uri));
    });

    monaco.editor.getModels().forEach((m) => this._attachLinter_(m));
    this._createDisposable = monaco.editor.onDidCreateModel((m) => this._attachLinter_(m));
    this._removeDisposable = monaco.editor.onWillDisposeModel((m) => this._detachLinter_(m));

    this._editorCreateDisposable = monaco.editor.onDidCreateEditor((ed) => this._attachEditor_(ed));
    if (window.jsWireMonacoEditor) this._attachEditor_(window.jsWireMonacoEditor);

    monaco.editor.getModels().forEach((m) => this._refreshDecorationsForUri_(m.uri));
    this._refreshAllOverlays_();
  }

  /** Desactiva todo y limpia el DOM. */
  disable() {
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

    this._modelHooks.forEach((hook, uriStr) => {
      clearTimeout(hook.timer);
      hook.dispose?.();
      const m = monaco.editor.getModels().find((x) => String(x.uri) === uriStr);
      if (m) monaco.editor.setModelMarkers(m, GasErrorLens.MARKER_SOURCE, []);
    });
    this._modelHooks.clear();

    this._decorationIds.forEach((ids, uriStr) => {
      const m = monaco.editor.getModels().find((x) => String(x.uri) === uriStr);
      if (m && ids.length) m.deltaDecorations(ids, []);
    });
    this._decorationIds.clear();

    this._editors.forEach((ed) => this._detachEditor_(ed));
    this._editors.clear();

    document.getElementById(GasErrorLens.STYLE_ID)?.remove();
  }

  // ── Linter: enganche por modelo ────────────────────────────────────────

  /**
   * Engancha el linter a un modelo JS soportado.
   * @param {object} model
   * @private
   */
  _attachLinter_(model) {
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
    if (!this._enabled) return;
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
   * Lint completo: una pasada por línea con tokenización ligera y un
   * parse global con `new Function` cuando el runtime lo permite.
   * @param {object} model
   * @param {Array}  markers
   * @private
   */
  _lintJs_(model, markers) {
    const fullText = model.getValue();
    const constNames = this._collectConstNames_(fullText);
    const lineCount = model.getLineCount();
    const counts = { '{': 0, '(': 0, '[': 0 };
    /** @type {Array<{ch:string, line:number, col:number}>} */
    const stack = [];
    let stripState = { inBlockComment: false, inTemplate: false };
    let scanState  = { inBlockComment: false, inTemplate: false };

    for (let line = 1; line <= lineCount; line++) {
      const text = model.getLineContent(line);
      const result = this._stripCodeFromLine_(text, stripState);
      stripState = { inBlockComment: result.inBlockComment, inTemplate: result.inTemplate };

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
      this._checkConstReassignment_(result.bare, line, markers, constNames);
      this._checkDuplicateParams_(result.bare, line, markers);
      this._checkEmptyCatch_(result.bare, line, markers);
      this._checkUnreachableCode_(result.bare, line, markers);
      this._checkTypeofVsUndefined_(result.bare, line, markers);
      this._checkNaNComparison_(result.bare, line, markers);
      this._checkMissingSemicolon_(result.bare, line, markers, { insideExpression });
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

    this._runSyntaxParser_(fullText, model, markers);
  }

  /**
   * Recoge nombres declarados con `const` (incluye destructuring básico).
   * @param {string} text
   * @returns {Set<string>}
   * @private
   */
  _collectConstNames_(text) {
    const names = new Set();
    const reSimple = /\bconst\s+([A-Za-z_$][\w$]*)/g;
    const reDestr  = /\bconst\s*\{([^}]*)\}/g;
    let m;
    while ((m = reSimple.exec(text)) !== null) names.add(m[1]);
    while ((m = reDestr.exec(text)) !== null) {
      m[1].split(',').forEach((part) => {
        const name = part.split(':').pop().trim().replace(/=.*$/, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      });
    }
    return names;
  }

  /**
   * Parser nativo. Si Trusted Types o CSP bloquea `new Function`, se
   * desactiva permanentemente para no spamear la consola.
   * @param {string} text
   * @param {object} model
   * @param {Array}  markers
   * @private
   */
  _runSyntaxParser_(text, model, markers) {
    if (this._syntaxParserAvailable === false) return;
    let err = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function(text);
      this._syntaxParserAvailable = true;
    } catch (e) {
      err = e;
      if (this._isParserBlockedByCsp_(e)) {
        this._syntaxParserAvailable = false;
        return;
      }
      this._syntaxParserAvailable = true;
    }
    if (!err || !(err instanceof SyntaxError)) return;
    const info = this._parseSyntaxError_(err, model);
    if (!info) return;
    const dup = markers.find(
      (m) => m.startLineNumber === info.line && Math.abs(m.startColumn - info.col) <= 1
    );
    if (dup) return;
    this._addMarker_(markers, {
      line: info.line, col: info.col, length: 1,
      message: `Syntax error: ${info.message}`,
      severity: GasErrorLens.SEVERITY.Error,
      code: 'syntax-error',
    });
  }

  /**
   * Extrae línea/col del `SyntaxError`. `new Function` agrega 2 líneas
   * de envoltura, así que las restamos.
   * @param {SyntaxError} err
   * @param {object} model
   * @returns {{line:number, col:number, message:string}|null}
   * @private
   */
  _parseSyntaxError_(err, model) {
    const message = String(err.message || 'Invalid syntax').replace(/\s+/g, ' ').trim();
    const stack = String(err.stack || '');
    const m = stack.match(/<anonymous>:(\d+):(\d+)/) || stack.match(/at .+:(\d+):(\d+)/);
    if (m) {
      const line = Math.max(1, Math.min(model.getLineCount(), parseInt(m[1], 10) - 2));
      const col  = Math.max(1, parseInt(m[2], 10));
      return { line, col, message };
    }
    return { line: 1, col: 1, message };
  }

  /**
   * Detecta si un error proviene de Trusted Types u otra política CSP.
   * @param {*} err
   * @returns {boolean}
   * @private
   */
  _isParserBlockedByCsp_(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    if (/TrustedScript|requires 'TrustedScript'|trusted-types/i.test(msg)) return true;
    if (err.name === 'EvalError' && /CSP|Content Security Policy/i.test(msg)) return true;
    return false;
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
   * @param {Set<string>} constNames
   * @private
   */
  _checkConstReassignment_(bare, line, out, constNames) {
    if (!constNames.size) return;
    // Si la línea declara destructuring (`const {...}` o `const [...]`),
    // saltamos toda la línea: los `name = default` son valores por defecto.
    if (/\b(const|let|var)\s*[{[]/.test(bare)) return;
    for (const name of constNames) {
      const re = new RegExp(
        `(^|[^.\\w$?])(${this._escapeRegex_(name)})\\s*(?:=|\\+=|-=|\\*=|/=|%=|\\*\\*=|<<=|>>=|>>>=|&=|\\|=|\\^=|&&=|\\|\\|=|\\?\\?=|\\+\\+|--)`,
        'g'
      );
      let m;
      while ((m = re.exec(bare)) !== null) {
        // Saltar la propia declaración: `const NAME = ...` o `let NAME = ...`.
        const upTo = bare.slice(0, m.index + (m[1] ? m[1].length : 0));
        if (/\b(const|let|var)\s+$/.test(upTo)) continue;
        // Saltar propiedad (después de `:` o `?`).
        const before = m[1];
        if (before === ':' || before === '?') continue;
        // Saltar `==` y `===`: nuestra regex usa `=` simple.
        const after = bare.slice(m.index + m[0].length, m.index + m[0].length + 1);
        if (m[0].endsWith('=') && after === '=') continue;
        const col = m.index + (m[1] ? m[1].length : 0) + 1;
        this._addMarker_(out, {
          line, col, length: name.length,
          message: `Cannot reassign constant '${name}'`,
          severity: GasErrorLens.SEVERITY.Error,
          code: 'const-reassignment',
        });
      }
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
   * `continue`. Solo marca cuando hay otra sentencia ejecutable después
   * en la misma línea (no comentarios ni cierre de bloque).
   * @private
   */
  _checkUnreachableCode_(bare, line, out) {
    const re = /\b(return|throw|break|continue)\b[^;]*;/g;
    let m;
    while ((m = re.exec(bare)) !== null) {
      const after = bare.slice(m.index + m[0].length).trim();
      // Permitidos: nada, cierre de bloque/expresión, comentarios.
      if (!after) continue;
      if (/^[)\]}]/.test(after)) continue;
      if (after.startsWith('//') || after.startsWith('/*')) continue;
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
   * @param {{insideExpression:boolean}} ctx Contexto al inicio de la línea.
   * @private
   */
  _checkMissingSemicolon_(bare, line, out, ctx) {
    if (ctx && ctx.insideExpression) return;

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
    const filtered = this._filterMarkers_(monaco.editor.getModelMarkers({ resource: uri }) || []);
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
    const byLine = new Map();
    for (const m of markers) {
      const cur = byLine.get(m.startLineNumber);
      if (!cur || GasErrorLens.SEVERITY_RANK[m.severity] < GasErrorLens.SEVERITY_RANK[cur.severity]) {
        byLine.set(m.startLineNumber, m);
      }
    }
    return Array.from(byLine.values());
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
    /** @type {Map<string, object>} */
    const widgets = new Map();
    const subs = [
      editor.onDidChangeModel(() => this._renderOverlay_(editor)),
      editor.onDidChangeModelContent(() => this._renderOverlay_(editor)),
      editor.onDidLayoutChange(() => this._renderOverlay_(editor)),
    ];
    this._editorOverlays.set(editor, { widgets, subs });
    this._editors.add(editor);
    this._renderOverlay_(editor);
  }

  /** Libera widgets y listeners de un editor. @private */
  _detachEditor_(editor) {
    const state = this._editorOverlays.get(editor);
    if (!state) return;
    state.subs.forEach((s) => s?.dispose?.());
    state.widgets.forEach((w) => editor.removeContentWidget(w));
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

    const filtered = this._filterMarkers_(monaco.editor.getModelMarkers({ resource: model.uri }) || []);
    const perLine  = this._dedupePerLine_(filtered);
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
    return String(message || '').replace(/\s+/g, ' ').replace(/\.+\s*$/, '').trim();
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
      .qc__gel-msg {
        font-family: var(--monaco-monospace-font, monospace);
        font-size: 12px;
        font-style: italic;
        line-height: 18px;
        padding: 0 4px;
        margin-left: 16px;
        pointer-events: none;
        white-space: nowrap;
        opacity: 0.9;
        user-select: none;
      }
      .qc__gel-msg-error    { color: #e06c75; }
      .qc__gel-msg-warning  { color: #d19a66; }
      .qc__gel-msg-info     { color: #61afef; }
      .qc__gel-msg-hint     { color: #98c379; }

      .qc__gel-inline {
        text-decoration-line: underline;
        text-decoration-style: wavy;
        text-decoration-skip-ink: none;
        text-underline-offset: 3px;
      }
      .qc__gel-inline-error    { text-decoration-color: rgba(224,108,117,.85); }
      .qc__gel-inline-warning  { text-decoration-color: rgba(209,154,102,.85); }
      .qc__gel-inline-info     { text-decoration-color: rgba(97,175,239,.85); }
      .qc__gel-inline-hint     { text-decoration-color: rgba(152,195,121,.85); }

      .qc__gel-gutter { width: 3px !important; margin-left: 3px; }
      .qc__gel-gutter-error    { background: #e06c75; }
      .qc__gel-gutter-warning  { background: #d19a66; }
      .qc__gel-gutter-info     { background: #61afef; }
      .qc__gel-gutter-hint     { background: #98c379; }
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
      applyToggle(settings['gas-error-lens'] !== false);
    } catch (_) { /* payload inválido */ }
  });

  document.addEventListener('GAS_SettingsUpdated', (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('gas-error-lens' in options) applyToggle(!!options['gas-error-lens']);
      if ('global-enable' in options && !options['global-enable']) applyToggle(false);
    } catch (_) { /* payload inválido */ }
  });

  window.gasErrorLens = errorLens;
})();
