/**
 * Componente Web para la creación y edición de temas visuales.
 * Recrea una interfaz de edición estilo Monaco Editor / VS Code.
 * @fires save-theme - Despachado cuando el usuario guarda los cambios.
 */
export class ThemeModal extends HTMLElement {

  /**
   * Lista maestra de propiedades de color compatibles con Monaco Editor.
   * @type {Array<{id: string, label: string, default: string}>}
   */
  static MONACO_COLORS = [
    { id: "activityBar.background", label: "activityBar.bg", default: "#090b10" },
    { id: "activityBar.border", label: "activityBar.border", default: "#00000060" },
    { id: "activityBar.foreground", label: "activityBar.fg", default: "#8f93a2" },
    { id: "activityBarBadge.background", label: "activityBadge.bg", default: "#80cbc4" },
    { id: "activityBarBadge.foreground", label: "activityBadge.fg", default: "#000000" },
    { id: "badge.background", label: "badge.bg", default: "#00000030" },
    { id: "badge.foreground", label: "badge.fg", default: "#464b5d" },
    { id: "breadcrumb.activeSelectionForeground", label: "breadcrumb.active", default: "#80cbc4" },
    { id: "breadcrumb.background", label: "breadcrumb.bg", default: "#0f111a" },
    { id: "breadcrumb.focusForeground", label: "breadcrumb.focus", default: "#8f93a2" },
    { id: "breadcrumb.foreground", label: "breadcrumb.fg", default: "#4b526d" },
    { id: "breadcrumbPicker.background", label: "breadcrumbPicker.bg", default: "#090b10" },
    { id: "button.background", label: "button.bg", default: "#717cb450" },
    { id: "debugToolBar.background", label: "debugToolBar.bg", default: "#0f111a" },
    { id: "diffEditor.insertedTextBackground", label: "diff.inserted", default: "#c3e88d15" },
    { id: "diffEditor.removedTextBackground", label: "diff.removed", default: "#ff537020" },
    { id: "dropdown.background", label: "dropdown.bg", default: "#0f111a" },
    { id: "dropdown.border", label: "dropdown.border", default: "#ffffff10" },
    { id: "editor.background", label: "editor.bg", default: "#0f111a" },
    { id: "editor.findMatchBackground", label: "findMatch.bg", default: "#000000" },
    { id: "editor.findMatchBorder", label: "findMatch.border", default: "#80cbc4" },
    { id: "editor.findMatchHighlightBackground", label: "findHighlight.bg", default: "#00000050" },
    { id: "editor.findMatchHighlightBorder", label: "findHighlight.border", default: "#ffffff50" },
    { id: "editor.foreground", label: "editor.fg", default: "#8f93a2" },
    { id: "editor.lineHighlightBackground", label: "lineHighlight.bg", default: "#00000050" },
    { id: "editor.selectionBackground", label: "selection.bg", default: "#717cb450" },
    { id: "editor.selectionHighlightBackground", label: "selectionHighlight.bg", default: "#ffcc0020" },
    { id: "editorBracketMatch.background", label: "bracketMatch.bg", default: "#0f111a" },
    { id: "editorBracketMatch.border", label: "bracketMatch.border", default: "#ffcc0050" },
    { id: "editorCursor.foreground", label: "cursor.fg", default: "#ffcc00" },
    { id: "editorError.foreground", label: "error.fg", default: "#ff537070" },
    { id: "editorGroup.border", label: "group.border", default: "#00000030" },
    { id: "editorGroupHeader.tabsBackground", label: "tabs.bg", default: "#0f111a" },
    { id: "editorGutter.addedBackground", label: "gutter.added", default: "#c3e88d60" },
    { id: "editorGutter.deletedBackground", label: "gutter.deleted", default: "#ff537060" },
    { id: "editorGutter.modifiedBackground", label: "gutter.modified", default: "#82aaff60" },
    { id: "editorHoverWidget.background", label: "hoverWidget.bg", default: "#0f111a" },
    { id: "editorHoverWidget.border", label: "hoverWidget.border", default: "#ffffff10" },
    { id: "editorIndentGuide.activeBackground", label: "indentActive.bg", default: "#3b3f51" },
    { id: "editorIndentGuide.background", label: "indent.bg", default: "#3b3f5170" },
    { id: "editorInfo.foreground", label: "info.fg", default: "#82aaff70" },
    { id: "editorLineNumber.activeForeground", label: "lineNumActive.fg", default: "#4b526d" },
    { id: "editorLineNumber.foreground", label: "lineNumbers.fg", default: "#3b3f5180" },
    { id: "editorLink.activeForeground", label: "linkActive.fg", default: "#8f93a2" },
    { id: "editorMarkerNavigation.background", label: "markerNav.bg", default: "#8f93a205" },
    { id: "editorOverviewRuler.border", label: "ruler.border", default: "#0f111a" },
    { id: "editorOverviewRuler.errorForeground", label: "ruler.error", default: "#ff537040" },
    { id: "editorOverviewRuler.findMatchForeground", label: "ruler.find", default: "#80cbc4" },
    { id: "editorOverviewRuler.infoForeground", label: "ruler.info", default: "#82aaff40" },
    { id: "editorOverviewRuler.warningForeground", label: "ruler.warning", default: "#ffcb6b40" },
    { id: "editorRuler.foreground", label: "editorRuler.fg", default: "#3b3f51" },
    { id: "editorSuggestWidget.background", label: "suggest.bg", default: "#0f111a" },
    { id: "editorSuggestWidget.border", label: "suggest.border", default: "#ffffff10" },
    { id: "editorSuggestWidget.foreground", label: "suggest.fg", default: "#8f93a2" },
    { id: "editorSuggestWidget.highlightForeground", label: "suggest.highlight", default: "#80cbc4" },
    { id: "editorSuggestWidget.selectedBackground", label: "suggest.selected", default: "#00000050" },
    { id: "editorWarning.foreground", label: "warning.fg", default: "#ffcb6b70" },
    { id: "editorWhitespace.foreground", label: "whitespace.fg", default: "#8f93a240" },
    { id: "editorWidget.background", label: "widget.bg", default: "#090b10" },
    { id: "editorWidget.border", label: "widget.border", default: "#ff0000" },
    { id: "editorWidget.resizeBorder", label: "widget.resize", default: "#80cbc4" },
    { id: "extensionButton.prominentBackground", label: "extBtn.bg", default: "#c3e88d90" },
    { id: "extensionButton.prominentHoverBackground", label: "extBtn.hover", default: "#c3e88d" },
    { id: "focusBorder", label: "focusBorder", default: "#ffffff00" },
    { id: "gitDecoration.conflictingResourceForeground", label: "git.conflict", default: "#ffcb6b90" },
    { id: "gitDecoration.deletedResourceForeground", label: "git.deleted", default: "#ff537090" },
    { id: "gitDecoration.ignoredResourceForeground", label: "git.ignored", default: "#4b526d90" },
    { id: "gitDecoration.modifiedResourceForeground", label: "git.modified", default: "#82aaff90" },
    { id: "gitDecoration.untrackedResourceForeground", label: "git.untracked", default: "#c3e88d90" },
    { id: "input.background", label: "input.bg", default: "#1a1c25" },
    { id: "input.border", label: "input.border", default: "#ffffff10" },
    { id: "input.foreground", label: "input.fg", default: "#eeffff" },
    { id: "input.placeholderForeground", label: "input.placeholder", default: "#8f93a260" },
    { id: "inputOption.activeBackground", label: "inputOpt.activeBg", default: "#8f93a230" },
    { id: "inputOption.activeBorder", label: "inputOpt.activeBorder", default: "#8f93a230" },
    { id: "inputValidation.errorBorder", label: "input.error", default: "#ff537050" },
    { id: "inputValidation.infoBorder", label: "input.info", default: "#82aaff50" },
    { id: "inputValidation.warningBorder", label: "input.warning", default: "#ffcb6b50" },
    { id: "list.activeSelectionBackground", label: "list.activeBg", default: "#090b10" },
    { id: "list.activeSelectionForeground", label: "list.activeFg", default: "#80cbc4" },
    { id: "list.focusBackground", label: "list.focusBg", default: "#8f93a220" },
    { id: "list.focusForeground", label: "list.focusFg", default: "#8f93a2" },
    { id: "list.highlightForeground", label: "list.highlight", default: "#80cbc4" },
    { id: "list.hoverBackground", label: "list.hoverBg", default: "#090b10" },
    { id: "list.hoverForeground", label: "list.hoverFg", default: "#ffffff" },
    { id: "list.inactiveSelectionBackground", label: "list.inactiveBg", default: "#00000030" },
    { id: "list.inactiveSelectionForeground", label: "list.inactiveFg", default: "#80cbc4" },
    { id: "listFilterWidget.background", label: "listFilter.bg", default: "#00000030" },
    { id: "listFilterWidget.noMatchesOutline", label: "listFilter.noMatch", default: "#00000030" },
    { id: "listFilterWidget.outline", label: "listFilter.outline", default: "#00000030" },
    { id: "menu.background", label: "menu.bg", default: "#0f111a" },
    { id: "menu.foreground", label: "menu.fg", default: "#8f93a2" },
    { id: "menu.selectionBackground", label: "menu.selBg", default: "#00000050" },
    { id: "menu.selectionBorder", label: "menu.selBorder", default: "#00000030" },
    { id: "menu.selectionForeground", label: "menu.selFg", default: "#80cbc4" },
    { id: "menu.separatorBackground", label: "menu.separator", default: "#8f93a2" },
    { id: "menubar.selectionBackground", label: "menubar.selBg", default: "#00000030" },
    { id: "menubar.selectionBorder", label: "menubar.selBorder", default: "#00000030" },
    { id: "menubar.selectionForeground", label: "menubar.selFg", default: "#80cbc4" },
    { id: "notificationLink.foreground", label: "notif.link", default: "#80cbc4" },
    { id: "notifications.background", label: "notif.bg", default: "#0f111a" },
    { id: "notifications.foreground", label: "notif.fg", default: "#8f93a2" },
    { id: "panel.background", label: "panel.bg", default: "#090b10" },
    { id: "panel.border", label: "panel.border", default: "#00000060" },
    { id: "panelTitle.activeBorder", label: "panel.activeBorder", default: "#80cbc4" },
    { id: "panelTitle.activeForeground", label: "panel.activeFg", default: "#ffffff" },
    { id: "panelTitle.inactiveForeground", label: "panel.inactiveFg", default: "#8f93a2" },
    { id: "peekView.border", label: "peek.border", default: "#00000030" },
    { id: "peekViewEditor.background", label: "peekEditor.bg", default: "#8f93a205" },
    { id: "peekViewEditor.matchHighlightBackground", label: "peekMatch.bg", default: "#717cb450" },
    { id: "peekViewEditorGutter.background", label: "peekGutter.bg", default: "#8f93a205" },
    { id: "peekViewResult.background", label: "peekResult.bg", default: "#8f93a205" },
    { id: "peekViewResult.matchHighlightBackground", label: "peekResMatch.bg", default: "#717cb450" },
    { id: "peekViewResult.selectionBackground", label: "peekSel.bg", default: "#4b526d70" },
    { id: "peekViewTitle.background", label: "peekTitle.bg", default: "#8f93a205" },
    { id: "peekViewTitleDescription.foreground", label: "peekDesc.fg", default: "#8f93a260" },
    { id: "pickerGroup.foreground", label: "picker.fg", default: "#80cbc4" },
    { id: "progressBar.background", label: "progress.bg", default: "#80cbc4" },
    { id: "scrollbar.shadow", label: "scrollbar.shadow", default: "#0f111a00" },
    { id: "scrollbarSlider.activeBackground", label: "scrollActive.bg", default: "#80cbc4" },
    { id: "scrollbarSlider.background", label: "scroll.bg", default: "#8f93a220" },
    { id: "scrollbarSlider.hoverBackground", label: "scrollHover.bg", default: "#8f93a210" },
    { id: "selection.background", label: "selection.bg", default: "#80cbc4" },
    { id: "settings.checkboxBackground", label: "set.checkBg", default: "#090b10" },
    { id: "settings.checkboxForeground", label: "set.checkFg", default: "#8f93a2" },
    { id: "settings.dropdownBackground", label: "set.dropBg", default: "#090b10" },
    { id: "settings.dropdownForeground", label: "set.dropFg", default: "#8f93a2" },
    { id: "settings.headerForeground", label: "set.header", default: "#80cbc4" },
    { id: "settings.modifiedItemIndicator", label: "set.modified", default: "#80cbc4" },
    { id: "settings.numberInputBackground", label: "set.numBg", default: "#090b10" },
    { id: "settings.numberInputForeground", label: "set.numFg", default: "#8f93a2" },
    { id: "settings.textInputBackground", label: "set.textBg", default: "#090b10" },
    { id: "settings.textInputForeground", label: "set.textFg", default: "#8f93a2" },
    { id: "sideBar.background", label: "sideBar.bg", default: "#090b10" },
    { id: "sideBar.border", label: "sideBar.border", default: "#00000060" },
    { id: "sideBar.foreground", label: "sideBar.fg", default: "#4b526d" },
    { id: "sideBarSectionHeader.background", label: "sideBarSec.bg", default: "#090b10" },
    { id: "sideBarSectionHeader.border", label: "sideBarSec.border", default: "#00000060" },
    { id: "sideBarTitle.foreground", label: "sideBarTitle.fg", default: "#8f93a2" },
    { id: "statusBar.background", label: "statusBar.bg", default: "#090b10" },
    { id: "statusBar.border", label: "statusBar.border", default: "#00000060" },
    { id: "statusBar.debuggingBackground", label: "status.debugBg", default: "#c792ea" },
    { id: "statusBar.debuggingForeground", label: "status.debugFg", default: "#ffffff" },
    { id: "statusBar.foreground", label: "statusBar.fg", default: "#4b526d" },
    { id: "statusBar.noFolderBackground", label: "status.noFolder", default: "#0f111a" },
    { id: "statusBarItem.hoverBackground", label: "statusItem.hover", default: "#464b5d20" },
    { id: "statusBarItem.remoteBackground", label: "status.remoteBg", default: "#80cbc4" },
    { id: "statusBarItem.remoteForeground", label: "status.remoteFg", default: "#000000" },
    { id: "tab.activeBorder", label: "tab.activeBorder", default: "#80cbc4" },
    { id: "tab.activeForeground", label: "tab.activeFg", default: "#ffffff" },
    { id: "tab.activeModifiedBorder", label: "tab.activeMod", default: "#4b526d" },
    { id: "tab.border", label: "tab.border", default: "#0f111a" },
    { id: "tab.inactiveBackground", label: "tab.inactiveBg", default: "#0f111a" },
    { id: "tab.inactiveForeground", label: "tab.inactiveFg", default: "#4b526d" },
    { id: "tab.unfocusedActiveBorder", label: "tab.unfActiveBorder", default: "#464b5d" },
    { id: "tab.unfocusedActiveForeground", label: "tab.unfActiveFg", default: "#8f93a2" },
    { id: "terminal.ansiBlack", label: "term.black", default: "#000000" },
    { id: "terminal.ansiBlue", label: "term.blue", default: "#82aaff" },
    { id: "terminal.ansiBrightBlack", label: "term.brBlack", default: "#464b5d" },
    { id: "terminal.ansiBrightBlue", label: "term.brBlue", default: "#82aaff" },
    { id: "terminal.ansiBrightCyan", label: "term.brCyan", default: "#89ddff" },
    { id: "terminal.ansiBrightGreen", label: "term.brGreen", default: "#c3e88d" },
    { id: "terminal.ansiBrightMagenta", label: "term.brMagenta", default: "#c792ea" },
    { id: "terminal.ansiBrightRed", label: "term.brRed", default: "#ff5370" },
    { id: "terminal.ansiBrightWhite", label: "term.brWhite", default: "#ffffff" },
    { id: "terminal.ansiBrightYellow", label: "term.brYellow", default: "#ffcb6b" },
    { id: "terminal.ansiCyan", label: "term.cyan", default: "#89ddff" },
    { id: "terminal.ansiGreen", label: "term.green", default: "#c3e88d" },
    { id: "terminal.ansiMagenta", label: "term.magenta", default: "#c792ea" },
    { id: "terminal.ansiRed", label: "term.red", default: "#ff5370" },
    { id: "terminal.ansiWhite", label: "term.white", default: "#ffffff" },
    { id: "terminal.ansiYellow", label: "term.yellow", default: "#ffcb6b" },
    { id: "terminalCursor.background", label: "termCursor.bg", default: "#000000" },
    { id: "terminalCursor.foreground", label: "termCursor.fg", default: "#ffcb6b" },
    { id: "textLink.activeForeground", label: "link.active", default: "#8f93a2" },
    { id: "textLink.foreground", label: "link.fg", default: "#80cbc4" },
    { id: "titleBar.activeBackground", label: "titleBar.bg", default: "#090b10" },
    { id: "titleBar.activeForeground", label: "titleBar.fg", default: "#8f93a2" },
    { id: "titleBar.border", label: "titleBar.border", default: "#00000060" },
    { id: "titleBar.inactiveBackground", label: "titleBar.inBg", default: "#090b10" },
    { id: "titleBar.inactiveForeground", label: "titleBar.inFg", default: "#4b526d" },
    { id: "tree.indentGuidesStroke", label: "tree.indent", default: "#3b3f51" },
    { id: "widget.shadow", label: "widget.shadow", default: "#00000030" }
  ];

  /**
   * IDs de colores que se muestran por defecto al abrir el modal.
   * Cubre las propiedades más relevantes para customizar un tema.
   * @type {string[]}
   */
  static DEFAULT_COLOR_IDS = [
    "editor.background",
    "editor.foreground",
    "editorCursor.foreground",
    "editor.selectionBackground",
    "editor.lineHighlightBackground",
    "editorLineNumber.foreground",
    "editorLineNumber.activeForeground",
    "statusBar.background",
    "statusBar.foreground",
    "sideBar.background",
    "sideBar.foreground",
    "activityBar.background",
    "tab.inactiveBackground",
    "tab.activeForeground",
    "tab.activeBorder",
    "editorGroupHeader.tabsBackground",
  ];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    /** @type {string|null} ID del tema en edición (null si es nuevo) */
    this._editingId = null;
    /**
     * Set de IDs de colores actualmente visibles en el grid.
     * @type {Set<string>}
     */
    this._activeColorIds = new Set(ThemeModal.DEFAULT_COLOR_IDS);
    /**
     * Valores de color actuales (incluyendo los no visibles).
     * @type {Object.<string, string>}
     */
    this._colorValues = {};
  }

  connectedCallback() {
    this.render_();
    this.initEvents_();
  }

  /** @private */
  render_() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0" />
      <style>
        * { box-sizing: border-box; font-family: 'Inter', sans-serif; }
        :host {
          position: fixed; inset: 0; display: none; z-index: 1000;
          align-items: center; justify-content: center;
        }
        :host(.qc__active) { display: flex; }
        .qc__overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.8); backdrop-filter: blur(4px); }
        .qc__modal {
          position: relative; background: #1e1e1e; width: 95%; max-width: 550px;
          border-radius: 12px; border: 1px solid #333; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
          color: #e1e1e1; display: flex; flex-direction: column; max-height: 90vh; overflow: hidden;
        }
        .qc__header { padding: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
        .qc__title { font-size: 18px; font-weight: 600; }
        .qc__close { background: none; border: none; color: #888; cursor: pointer; padding: 0; }
        .qc__body { padding: 0 20px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }

        .qc__search-container { position: sticky; top: 0; background: #1e1e1e; z-index: 10; padding-bottom: 10px; }
        .qc__search-input { margin-top: 8px; }
        .qc__section-label {
          font-size: 11px; font-weight: 700; color: #555;
          text-transform: uppercase; margin-bottom: 10px;
          display: flex; justify-content: space-between; align-items: center;
        }
        .qc__form-row { display: flex; gap: 12px; width: 100%; align-items: flex-end; }
        .qc__field { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .qc__field label { font-size: 11px; color: #777; font-weight: 600; }

        input[type="text"], select {
          background: #252526; border: 1px solid #333; border-radius: 6px;
          color: #fff; padding: 8px 12px; font-size: 13px; outline: none; width: 100%;
        }
        .qc__colors-grid {
          background: #252526; border-radius: 8px; padding: 15px;
          display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px;
          max-height: 280px; overflow-y: auto; border: 1px solid #333;
        }

        /* Color item ahora con botón de eliminar */
        .qc__color-item {
          display: flex; align-items: center; gap: 6px;
          font-size: 10px; color: #aaa; background: #1e1e1e;
          padding: 5px 6px; border-radius: 4px; border: 1px solid #333;
          position: relative;
        }
        .qc__color-item:hover .qc__color-remove { opacity: 1; }
        .qc__color-remove {
          background: none; border: none; color: #ef4444;
          cursor: pointer; padding: 0; line-height: 1;
          font-size: 14px; opacity: 0; transition: opacity 0.15s;
          margin-left: auto; flex-shrink: 0; display: flex; align-items: center;
        }
        .qc__color-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

        input[type="color"] {
          appearance: none; width: 22px; height: 22px; border: none;
          border-radius: 3px; cursor: pointer; background: none; padding: 0; flex-shrink: 0;
        }

        /* Panel de añadir colores */
        .qc__add-color-panel {
          position: absolute;
          top: calc(100% + 10px);   /* ← anclado al botón, no al fondo del modal */
          right: 0;                 /* ← alineado a la derecha del botón */
          width: 322px;
          background: #252526;
          border: 1px solid #444;
          border-radius: 8px;
          padding: 12px;
          display: none;
          flex-direction: column;
          gap: 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06), 0 0 20px rgba(255,255,255,0.04);
          z-index: 200;             /* ← más alto para pasar sobre el grid */
        }
        .qc__add-color-panel::before {
          content: '';
          position: absolute;
          top: -6px;
          right: 12px;
          width: 10px;
          height: 10px;
          background: #252526;
          border-left: 1px solid #444;
          border-top: 1px solid #444;
          transform: rotate(45deg);
        }
        .qc__add-color-panel.qc__open { display: flex; }
        .qc__add-color-search {
          background: #1e1e1e; border: 1px solid #444; border-radius: 4px;
          color: #fff; padding: 6px 10px; font-size: 12px; outline: none; width: 100%;
        }
        .qc__add-color-list {
          max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
        }
        .qc__add-color-option {
          display: flex; align-items: center; gap: 8px; padding: 5px 8px;
          border-radius: 4px; cursor: pointer; font-size: 11px; color: #bbb;
          border: none; background: none; text-align: left; width: 100%;
        }
        .qc__add-color-option:hover { background: #2d2d2d; color: #fff; }
        .qc__add-color-swatch { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; border: 1px solid #555; }
        .qc__add-color-option.qc__already-added { opacity: 0.35; cursor: default; pointer-events: none; }

        /* Botones de acción de la sección de colores */
        .qc__color-actions { display: flex; gap: 8px; align-items: center; }
        .qc__btn-add-color {
          font-size: 10px; font-weight: 700; color: #007ACC;
          background: none; border: none; cursor: pointer; padding: 0;
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .qc__btn-reset-colors {
          font-size: 10px; color: #555; background: none;
          border: none; cursor: pointer; padding: 0;
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .qc__btn-reset-colors:hover { color: #888; }

        .qc__rule-row { display: flex; gap: 8px; align-items: center; background: #252526; padding: 6px; border-radius: 6px; }
        .qc__rule-row input[type="text"] { flex: 1; border: none; background: transparent; padding: 4px; color: white; }
        .qc__rule-select {
          width: auto; padding: 4px 8px; font-size: 11px;
          background: #1a1a1a; color: #bbb; border: 1px solid #444; border-radius: 4px;
        }
        .qc__inherit-container {
          display: flex; align-items: center; justify-content: center; gap: 10px;
          padding: 10px; background: #252526; border-radius: 8px; border: 1px dashed #444;
        }
        .qc__checkbox-field { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; font-size: 11px; color: #888; font-weight: 700; text-transform: uppercase; }
        .qc__footer { padding: 16px 20px; border-top: 1px solid #333; display: flex; gap: 12px; }
        .qc__btn { padding: 10px 20px; border-radius: 6px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; flex: 1; }
        .qc__btn--primary { background: #007ACC; color: white; }
        .qc__btn--secondary { background: #333; color: white; }
      </style>
      <div class="qc__overlay"></div>
      <div class="qc__modal">
        <div class="qc__header">
          <div><div class="qc__title">Edit Theme</div></div>
          <button class="qc__close"><span class="material-symbols-outlined">close</span></button>
        </div>
        <div class="qc__body" id="modal-body">
          <div class="qc__form-row">
            <div class="qc__field">
              <label>THEME NAME *</label>
              <input type="text" id="theme-name" placeholder="My Custom Theme" required>
            </div>
            <div class="qc__field">
              <label>BASE THEME</label>
              <select id="base-theme">
                <option value="vs-dark">vs-dark (Dark)</option>
                <option value="vs">vs (Light)</option>
                <option value="hc-black">hc-black (High Contrast)</option>
              </select>
            </div>
          </div>

          <section>
            <div class="qc__search-container">
              <div class="qc__section-label">
                <span>Editor &amp; UI Colors</span>
                <div class="qc__color-actions">
                  <button class="qc__btn-reset-colors" id="reset-colors" title="Restore default color set">Reset</button>
                  <div style="position: relative;">
                    <button class="qc__btn-add-color" id="toggle-add-color">+ Add Color</button>
                    <!-- Panel para agregar nuevos colores -->
                    <div class="qc__add-color-panel" id="add-color-panel">
                      <input type="text" class="qc__add-color-search" id="add-color-search" placeholder="Search to add (ex: sidebar, tab)...">
                      <div class="qc__add-color-list" id="add-color-list"></div>
                    </div>
                  </div>
                </div>
              </div>
              <input type="text" id="color-search" class="qc__search-input" placeholder="Search color property (ex: activityBar)...">
            </div>

            <div class="qc__colors-grid" id="ui-colors-grid"></div>
          </section>

          <section>
            <div class="qc__section-label">
              Syntax Token Rules
              <span style="color: #007ACC; cursor: pointer; font-size: 10px;" id="add-rule">+ ADD RULE</span>
            </div>
            <div id="rules-list" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;"></div>
            <div class="qc__inherit-container">
              <label class="qc__checkbox-field">
                <input type="checkbox" id="theme-inherit">
                <span>Inherit basic rules from base theme</span>
              </label>
            </div>
          </section>
        </div>
        <div class="qc__footer">
          <button class="qc__btn qc__btn--secondary" id="cancel">Cancel</button>
          <button class="qc__btn qc__btn--primary" id="save">Save Theme</button>
        </div>
      </div>
    `;
  }

  /** @private */
  initEvents_() {
    const get = (id) => this.shadowRoot.getElementById(id);
    get('cancel').onclick = () => this.close_();
    get('save').onclick = () => this.handleSave_();
    get('add-rule').onclick = () => this.addRuleRow_();
    this.shadowRoot.querySelector('.qc__close').onclick = () => this.close_();
    this.shadowRoot.querySelector('.qc__overlay').onclick = () => this.close_();
    get('color-search').oninput = (e) => this.filterColors_(e.target.value);

    // Toggle panel de "Add Color"
    get('toggle-add-color').onclick = () => {
      const panel = get('add-color-panel');
      panel.classList.toggle('qc__open');
      if (panel.classList.contains('qc__open')) {
        this.renderAddColorList_('');
        get('add-color-search').value = '';
        get('add-color-search').focus();
      }
    };

    // Búsqueda dentro del panel de agregar colores
    get('add-color-search').oninput = (e) => this.renderAddColorList_(e.target.value);

    // Reset al set por defecto
    get('reset-colors').onclick = () => {
      // Persiste los valores actuales antes de resetear
      this.syncColorValues_();
      this._activeColorIds = new Set(ThemeModal.DEFAULT_COLOR_IDS);
      this.renderColorGrid_();
      this.renderAddColorList_(this.shadowRoot.getElementById('add-color-search')?.value || '');
    };

    // Por si hace click fuera del panel
    document.addEventListener('click', (e) => {
      const panel = this.shadowRoot.getElementById('add-color-panel');
      const btn = this.shadowRoot.getElementById('toggle-add-color');
      if (panel.classList.contains('qc__open') && 
          !panel.contains(e.composedPath()[0]) && 
          e.composedPath()[0] !== btn) {
        panel.classList.remove('qc__open');
      }
    }, true);
  }

  /**
   * Lee los inputs de color del grid y los guarda en `_colorValues`.
   * Llamar antes de cualquier operación que modifique el grid.
   * @private
   */
  syncColorValues_() {
    this.shadowRoot.querySelectorAll('.qc__color-item').forEach(item => {
      const id = item.dataset.id;
      const input = item.querySelector('input[type="color"]');
      if (id && input) this._colorValues[id] = input.value;
    });
  }

  /**
   * Renderiza el grid de colores basándose en `_activeColorIds`.
   * @private
   */
  renderColorGrid_() {
    const grid = this.shadowRoot.getElementById('ui-colors-grid');
    grid.innerHTML = '';

    // Solo renderiza los colores activos, pero mantiene sus valores en `_colorValues`
    ThemeModal.MONACO_COLORS
      .filter(c => this._activeColorIds.has(c.id))
      .forEach(colorConfig => {
        console.log('colorConfig', colorConfig);
        console.log('Rendering color item:', colorConfig.id);
        console.log('Current value:', this._colorValues[colorConfig.id], 'Default:', colorConfig.default);
        const value = this.cleanColor_(this._colorValues[colorConfig.id] || colorConfig.default);
        const item = document.createElement('div');
        item.className = 'qc__color-item';
        item.dataset.id = colorConfig.id;
        item.innerHTML = `
          <input type="color" value="${value}" data-monaco="${colorConfig.id}">
          <span class="qc__color-label" title="${colorConfig.id}">${colorConfig.label}</span>
          <button class="qc__color-remove" title="Remove" aria-label="Remove ${colorConfig.label}">
            <span class="material-symbols-outlined" style="font-size:14px">close</span>
          </button>
        `;
        item.querySelector('.qc__color-remove').onclick = () => {
          this.syncColorValues_();
          this._activeColorIds.delete(colorConfig.id);
          item.remove();
          // Actualiza la lista del panel si está abierto
          const panel = this.shadowRoot.getElementById('add-color-panel');
          if (panel.classList.contains('qc__open')) {
            this.renderAddColorList_(this.shadowRoot.getElementById('add-color-search').value);
          }
        };
        grid.appendChild(item);
      });

    // Re-aplica el filtro de búsqueda si hay texto
    const searchVal = this.shadowRoot.getElementById('color-search')?.value || '';
    if (searchVal) this.filterColors_(searchVal);
  }

  /**
   * Renderiza la lista de colores disponibles para agregar al grid.
   * Excluye los que ya están activos y filtra por query.
   * @param {string} query
   * @private
   */
  renderAddColorList_(query) {
    const list = this.shadowRoot.getElementById('add-color-list');
    const q = query.toLowerCase();
    list.innerHTML = '';

    const filtered = ThemeModal.MONACO_COLORS.filter(c =>
      c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
      list.innerHTML = `<div style="font-size:11px;color:#555;padding:8px;">No results for "${query}"</div>`;
      return;
    }

    filtered.forEach(colorConfig => {
      const isActive = this._activeColorIds.has(colorConfig.id);
      const btn = document.createElement('button');
      btn.className = `qc__add-color-option${isActive ? ' qc__already-added' : ''}`;
      const swatchColor = this.cleanColor_(this._colorValues[colorConfig.id] || colorConfig.default);
      btn.innerHTML = `
        <span class="qc__add-color-swatch" style="background:${swatchColor}"></span>
        <span>${colorConfig.id}</span>
        ${isActive ? '<span style="margin-left:auto;font-size:10px;color:#555">Added</span>' : ''}
      `;
      if (!isActive) {
        btn.onclick = () => {
          this.syncColorValues_();
          this._activeColorIds.add(colorConfig.id);
          this.renderColorGrid_();
          this.renderAddColorList_(this.shadowRoot.getElementById('add-color-search').value);
        };
      }
      list.appendChild(btn);
    });
  }

  /**
   * Filtra visualmente la cuadrícula de colores UI.
   * @param {string} query
   * @private
   */
  filterColors_(query) {
    const q = query.toLowerCase();
    this.shadowRoot.querySelectorAll('.qc__color-item').forEach(item => {
      const id = item.dataset.id.toLowerCase();
      item.style.display = id.includes(q) ? '' : 'none';
    });
  }

  /**
   * Crea e inserta una nueva fila en "Syntax Token Rules".
   * @param {string} [token='']
   * @param {string} [color='#ffffff']
   * @param {string} [fontStyle='normal']
   * @private
   */
  addRuleRow_(token = '', color = '#ffffff', fontStyle = 'normal') {
    const container = this.shadowRoot.getElementById('rules-list');
    const row = document.createElement('div');
    row.className = 'qc__rule-row';
    const validColor = this.cleanColor_(color);
    row.innerHTML = `
      <input type="color" value="${validColor}" class="rule-color">
      <input type="text" value="${token}" placeholder="token.name" class="rule-token" required>
      <select class="qc__rule-select rule-font">
        <option value="normal" ${fontStyle === 'normal' ? 'selected' : ''}>Normal</option>
        <option value="bold" ${fontStyle === 'bold' ? 'selected' : ''}>Bold</option>
        <option value="italic" ${fontStyle === 'italic' ? 'selected' : ''}>Italic</option>
      </select>
      <span class="material-symbols-outlined delete-rule" style="color: #ef4444; font-size: 18px; cursor: pointer;">delete</span>
    `;
    row.querySelector('.delete-rule').onclick = () => row.remove();
    container.appendChild(row);
  }

  /**
   * Prepara y muestra el modal. Si recibe un tema, carga sus datos.
   * @param {Object|null} theme
   * @public
   */
  open_(theme = null) {
    this.classList.add('qc__active');
    this._editingId = theme?.value || null;

    const get = (id) => this.shadowRoot.getElementById(id);
    const body = get('modal-body');
    if (body) body.scrollTop = 0;

    get('theme-name').value = theme?.text || '';
    get('theme-inherit').checked = theme?.data?.inherit ?? true;
    get('base-theme').value = theme?.data?.base || "vs-dark";
    get('rules-list').innerHTML = '';
    get('color-search').value = '';
    get('add-color-panel').classList.remove('qc__open');

    // Determina qué IDs mostrar: si el tema tiene colores guardados,
    // muestra exactamente esos; si no, el set por defecto.
    const themeColors = theme?.data?.colors || {};
    const savedIds = Object.keys(themeColors);
    console.log("Saved color IDs in theme:", savedIds);
    this._colorValues = {};

    if (savedIds.length > 0) {
      // Modo edición: mostrar solo los colores que fueron guardados
      this._activeColorIds = new Set(savedIds.filter(id =>
        ThemeModal.MONACO_COLORS.some(c => c.id === id)
      ));
      console.log("Active color IDs for editing:", this._activeColorIds);
      // Carga valores guardados
      ThemeModal.MONACO_COLORS.forEach(c => {
        this._colorValues[c.id] = themeColors[c.id] || c.default;
      });
    } else {
      // Modo nuevo: mostrar el set por defecto
      this._activeColorIds = new Set(ThemeModal.DEFAULT_COLOR_IDS);
      ThemeModal.MONACO_COLORS.forEach(c => {
        this._colorValues[c.id] = c.default;
      });
    }

    // Renderiza el grid de colores según el set activo
    this.renderColorGrid_();

    // Carga reglas de sintaxis
    if (theme?.data?.rules?.length > 0) {
      theme.data.rules.forEach(r => this.addRuleRow_(r.token, r.foreground, r.fontStyle));
    } else {
      this.loadDefaultRules_();
    }
  }

  /** @private */
  loadDefaultRules_() {
    const defaults = [
      { t: "comment", c: "#6A9955", s: "italic" },
      { t: "comment.block", c: "#6A9955", s: "italic" },
      { t: "string", c: "#CE9178" },
      { t: "keyword", c: "#569CD6" },
      { t: "keyword.control", c: "#C586C0" },
      { t: "constant", c: "#4EC9B0" },
      { t: "constant.numeric", c: "#B5CEA8" },
      { t: "variable", c: "#9CDCFE" },
      { t: "entity.name.function", c: "#DCDCAA" },
      { t: "entity.name.class", c: "#4EC9B0" },
      { t: "type", c: "#4EC9B0" },
      { t: "punctuation", c: "#D4D4D4" },
      { t: "support", c: "#DCDCAA" }
    ];
    defaults.forEach(r => this.addRuleRow_(r.t, r.c, r.s || 'normal'));
  }

  /**
   * Normaliza un color a formato #RRGGBB para input[type=color].
   * @param {string} color
   * @returns {string}
   * @private
   */
  cleanColor_(color) {
    if (!color || typeof color !== 'string') return '#ffffff';
    const c = color.trim().startsWith('#') ? color.trim() : `#${color.trim()}`;
    // Expande formato corto #RGB → #RRGGBB
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
    }
    // Toma solo los primeros 6 dígitos hex de cualquier formato más largo (#RRGGBBAA, etc.)
    const match = c.match(/^#([0-9a-fA-F]{6})/);
    if (match) return `#${match[1]}`;
    // Último recurso: fuerza 6 dígitos o devuelve blanco
    const digits = c.replace('#', '').replace(/[^0-9a-fA-F]/g, '');
    return digits.length >= 6 ? `#${digits.substring(0, 6)}` : '#ffffff';
  }

  /** @public */
  close_() { this.classList.remove('qc__active'); }

  /**
   * Recolecta todos los datos de la interfaz.
   * Solo incluye en `colors` los que estén activos en el grid.
   * @returns {Object}
   * @private
   */
  getFormData_() {
    const get = (id) => this.shadowRoot.getElementById(id);
    const rules = [];

    this.shadowRoot.querySelectorAll('.qc__rule-row').forEach(row => {
      const token = row.querySelector('.rule-token').value.trim();
      if (token) {
        rules.push({
          token,
          foreground: row.querySelector('.rule-color').value,
          fontStyle: row.querySelector('.rule-font').value
        });
      }
    });

    // Solo exporta los colores activos en el grid
    const monacoColors = {};
    this.shadowRoot.querySelectorAll('.qc__color-item').forEach(item => {
      const id = item.dataset.id;
      const input = item.querySelector('input[type="color"]');
      if (id && input) monacoColors[id] = input.value;
    });

    const bg = monacoColors['editor.background'] || '#0f111a';
    const fg = monacoColors['editor.foreground'] || '#8f93a2';
    const accent = monacoColors['statusBar.background'] || '#090b10';
    const syntax = rules.find(r => r.token.includes('keyword'))?.foreground || "#569CD6";

    return {
      protected: false,
      text: get('theme-name').value.trim(),
      value: this._editingId || `theme-${Date.now()}`,
      colors: [bg, syntax, fg, accent].join(','),
      data: {
        inherit: get('theme-inherit').checked,
        base: get('base-theme').value,
        colors: monacoColors,
        rules,
      }
    };
  }

  /** @private */
  handleSave_() {
    const data = this.getFormData_();
    if (!data.text) {
      alert("Please enter a Theme Name.");
      return;
    }
    this.dispatchEvent(new CustomEvent('save-theme', { detail: data, bubbles: true, composed: true }));
    this.close_();
  }
}

customElements.define('theme-modal', ThemeModal);