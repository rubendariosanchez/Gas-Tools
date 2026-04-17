/**
 * Componente Web para la creación y edición de temas visuales.
 * Recrea una interfaz de edición estilo Monaco Editor / VS Code.
 * * @fires save-theme - Despachado cuando el usuario guarda los cambios.
 */
export class ThemeModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    /** @type {string|null} ID del tema en edición (null si es nuevo) */
    this._editingId = null;
  }

  connectedCallback() {
    this.render_();
    this.initEvents_();
  }

  /**
   * Renderiza la estructura HTML y CSS del modal.
   * @private
   */
  render_() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0" />
      <style>
        * { box-sizing: border-box; font-family: 'Inter', sans-serif; }
        :host {
          position: fixed;
          inset: 0;
          display: none;
          z-index: 1000;
          align-items: center;
          justify-content: center;
        }
        :host(.qc__active) { display: flex; }

        .qc__overlay {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.8);
          backdrop-filter: blur(4px);
        }

        .qc__modal {
          position: relative;
          background: #1e1e1e;
          width: 95%;
          max-width: 550px;
          border-radius: 12px;
          border: 1px solid #333;
          box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
          color: #e1e1e1;
          display: flex;
          flex-direction: column;
          max-height: 90vh;
          overflow: hidden; /* Evita que el contenido desborde el radio del borde */
        }

        .qc__header { padding: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
        .qc__title { font-size: 18px; font-weight: 600; }
        .qc__subtitle { font-size: 12px; color: #888; margin-top: 4px; }
        .qc__close { background: none; border: none; color: #888; cursor: pointer; padding: 0; }

        .qc__body { padding: 0 20px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
        .qc__section-label {
          font-size: 11px; font-weight: 700; color: #555;
          text-transform: uppercase; margin-bottom: 10px;
          display: flex; justify-content: space-between; align-items: center;
        }

        .qc__form-row { display: flex; gap: 12px; width: 100%; }
        .qc__field { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; } /* min-width evita desbordamiento en flex */
        .qc__field label { font-size: 11px; color: #777; font-weight: 600; }
        
        input[type="text"], select {
          background: #252526; border: 1px solid #333; border-radius: 6px;
          color: #fff; padding: 8px 12px; font-size: 13px; outline: none;
          width: 100%; /* Asegura que ocupen el ancho de su celda flex */
        }

        input[type="text"]:focus { border-color: #007ACC; }

        .qc__colors-grid {
          background: #252526; border-radius: 8px; padding: 15px;
          display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px;
        }
        .qc__color-item { 
          display: flex; align-items: center; gap: 8px; 
          font-size: 10px; color: #aaa; background: #1e1e1e;
          padding: 6px; border-radius: 4px; border: 1px solid #333;
        }
        input[type="color"] {
          appearance: none; width: 22px; height: 22px; border: none;
          border-radius: 3px; cursor: pointer; background: none; padding: 0; flex-shrink: 0;
        }

        .qc__rules-container { display: flex; flex-direction: column; gap: 8px; }
        .qc__rule-row { display: flex; gap: 8px; align-items: center; background: #252526; padding: 6px; border-radius: 6px; }
        .qc__rule-row input[type="text"] { flex: 1; border: none; background: transparent; padding: 4px; }

        .qc__footer {
          padding: 16px 20px; border-top: 1px solid #333;
          display: flex; gap: 12px;
        }
        .qc__btn {
          padding: 10px 20px; border-radius: 6px; border: none;
          font-size: 13px; font-weight: 600; cursor: pointer; flex: 1;
        }
        .qc__btn--primary { background: #007ACC; color: white; }
        .qc__btn--secondary { background: #333; color: white; }
        .qc__btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .qc__body::-webkit-scrollbar { width: 6px; }
        .qc__body::-webkit-scrollbar-thumb { background: #444; border-radius: 10px; }
      </style>

      <div class="qc__overlay"></div>
      <div class="qc__modal">
        <div class="qc__header">
          <div>
            <div class="qc__title">Edit Theme</div>
            <div class="qc__subtitle">Customize UI and Syntax colors (Monaco Format).</div>
          </div>
          <button class="qc__close"><span class="material-symbols-outlined">close</span></button>
        </div>

        <div class="qc__body">
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
            <div class="qc__section-label">Editor & UI Colors</div>
            <div class="qc__colors-grid">
              <div class="qc__color-item"><input type="color" id="col-foreground"> <span>editor.fg</span></div>
              <div class="qc__color-item"><input type="color" id="col-background"> <span>editor.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-selection"> <span>selection.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-lineHighlight"> <span>lineHighlight.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-cursor"> <span>cursor.fg</span></div>
              <div class="qc__color-item"><input type="color" id="col-whitespace"> <span>whitespace.fg</span></div>
              <div class="qc__color-item"><input type="color" id="col-indent"> <span>indentGuide.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-indentActive"> <span>indentActive.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-lineNumbers"> <span>lineNumbers.fg</span></div>
              <div class="qc__color-item"><input type="color" id="col-tabActive"> <span>tabActive.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-tabInactive"> <span>tabInactive.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-activityBar"> <span>activityBar.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-sideBar"> <span>sideBar.bg</span></div>
              <div class="qc__color-item"><input type="color" id="col-statusBar"> <span>statusBar.bg</span></div>
            </div>
          </section>

          <section>
            <div class="qc__section-label">
              Syntax Token Rules
              <span style="color: #007ACC; cursor: pointer; font-size: 10px;" id="add-rule">+ ADD RULE</span>
            </div>
            <div class="qc__rules-container" id="rules-list"></div>
          </section>
        </div>

        <div class="qc__footer">
          <button class="qc__btn qc__btn--secondary" id="cancel">Cancel</button>
          <button class="qc__btn qc__btn--primary" id="save">Save Theme</button>
        </div>
      </div>
    `;
  }

  /**
   * @private
   */
  initEvents_() {
    const get = (id) => this.shadowRoot.getElementById(id);
    get('cancel').onclick = () => this.close_();
    this.shadowRoot.querySelector('.qc__close').onclick = () => this.close_();
    this.shadowRoot.querySelector('.qc__overlay').onclick = () => this.close_();
    get('save').onclick = () => this.handleSave_();
    get('add-rule').onclick = () => this.addRuleRow_();
  }

  /**
   * @private
   */
  addRuleRow_(token = '', color = '#ffffff', fontStyle = 'normal') {
    const container = this.shadowRoot.getElementById('rules-list');
    const row = document.createElement('div');
    row.className = 'qc__rule-row';
    const validColor = color.startsWith('#') ? color : `#${color}`;

    row.innerHTML = `
      <input type="color" value="${validColor}" class="rule-color">
      <input type="text" value="${token}" placeholder="token.name" class="rule-token" required>
      <select class="rule-font" style="width: auto; padding: 4px; font-size: 11px;">
        <option value="normal" ${fontStyle === 'normal' ? 'selected' : ''}>Normal</option>
        <option value="bold" ${fontStyle === 'bold' ? 'selected' : ''}>Bold</option>
        <option value="italic" ${fontStyle === 'italic' ? 'selected' : ''}>Italic</option>
      </select>
      <span class="material-symbols-outlined delete-rule" style="color: #ef4444; font-size: 18px; cursor: pointer; margin-left: 4px;">delete</span>
    `;
    
    row.querySelector('.delete-rule').onclick = () => row.remove();
    container.appendChild(row);
  }

  /**
   * @public
   */
  open_(theme = null) {
    this.classList.add('qc__active');
    this._editingId = theme?.value || null;
    
    const get = (id) => this.shadowRoot.getElementById(id);
    get('theme-name').value = theme?.text || '';
    get('rules-list').innerHTML = '';

    const colors = theme?.colors || {};

    get('col-foreground').value = colors['editor.foreground'] || "#D4D4D4";
    get('col-background').value = colors['editor.background'] || "#1E1E1E";
    get('col-selection').value = colors['editor.selectionBackground'] || "#264F78";
    get('col-lineHighlight').value = colors['editor.lineHighlightBackground'] || "#2A2D2E";
    get('col-cursor').value = colors['editorCursor.foreground'] || "#AEAFAD";
    get('col-whitespace').value = colors['editorWhitespace.foreground'] || "#3B3B3B";
    get('col-indent').value = colors['editorIndentGuide.background'] || "#404040";
    get('col-indentActive').value = colors['editorIndentGuide.activeBackground'] || "#707070";
    get('col-lineNumbers').value = colors['editorLineNumber.foreground'] || "#858585";
    get('col-tabActive').value = colors['tab.activeBackground'] || "#1E1E1E";
    get('col-tabInactive').value = colors['tab.inactiveBackground'] || "#2D2D30";
    get('col-activityBar').value = colors['activityBar.background'] || "#333333";
    get('col-sideBar').value = colors['sideBar.background'] || "#252526";
    get('col-statusBar').value = colors['statusBar.background'] || "#007ACC";
    
    get('base-theme').value = theme?.base || "vs-dark";

    if (theme?.rules) {
      theme.rules.forEach(r => this.addRuleRow_(r.token, r.foreground, r.fontStyle));
    } else {
      const defaultRules = [
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
      defaultRules.forEach(r => this.addRuleRow_(r.t, r.c, r.s || 'normal'));
    }
  }

  close_() { this.classList.remove('qc__active'); }

  /**
   * @private
   */
  getFormData_() {
    const get = (id) => this.shadowRoot.getElementById(id);
    const rules = [];
    
    this.shadowRoot.querySelectorAll('.qc__rule-row').forEach(row => {
      const token = row.querySelector('.rule-token').value.trim();
      if (token) {
        rules.push({
          token: token,
          foreground: row.querySelector('.rule-color').value,
          fontStyle: row.querySelector('.rule-font').value
        });
      }
    });

    return {
      text: get('theme-name').value.trim(),
      value: this._editingId || `theme-${Date.now()}`,
      base: get('base-theme').value,
      inherit: true,
      colors: {
        'editor.foreground': get('col-foreground').value,
        'editor.background': get('col-background').value,
        'editor.selectionBackground': get('col-selection').value,
        'editor.lineHighlightBackground': get('col-lineHighlight').value,
        'editorCursor.foreground': get('col-cursor').value,
        'editorWhitespace.foreground': get('col-whitespace').value,
        'editorIndentGuide.background': get('col-indent').value,
        'editorIndentGuide.activeBackground': get('col-indentActive').value,
        'editorLineNumber.foreground': get('col-lineNumbers').value,
        'tab.activeBackground': get('col-tabActive').value,
        'tab.inactiveBackground': get('col-tabInactive').value,
        'activityBar.background': get('col-activityBar').value,
        'sideBar.background': get('col-sideBar').value,
        'statusBar.background': get('col-statusBar').value
      },
      rules: rules
    };
  }

  /**
   * Valida los datos y despacha el evento.
   * @private
   */
  handleSave_() {
    const data = this.getFormData_();
    
    // Validación de campos obligatorios
    if (!data.text) {
      alert("Please enter a Theme Name.");
      this.shadowRoot.getElementById('theme-name').focus();
      return;
    }

    if (data.rules.length === 0) {
      alert("At least one Syntax Token Rule is required.");
      return;
    }

    this.dispatchEvent(new CustomEvent('save-theme', { 
      detail: data, 
      bubbles: true, 
      composed: true 
    }));
    
    this.close_();
  }
}

customElements.define('theme-modal', ThemeModal);