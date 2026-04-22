/**
 * SnippetModal - UI con Editor CodeMirror 6 (Tema Monaco corregido)
 */
import {
  EditorView,
  EditorState,
  StateEffect,
  basicSetup,
  javascript,
  html,
  HighlightStyle,    
  syntaxHighlighting, 
  tags as t            
} from '../vendor/codemirror/codemirror.js';

// Importamos estilo base del tema monaco
// import { getMonacoThemeConfig } from '../utils/Variables.js';

// Definición de colores estilo Monaco/VSCode Dark Plus.
const G_MONACO_STYLES = HighlightStyle.define([
  { tag: t.keyword, color: "#569cd6" },
  { tag: t.operator, color: "#d4d4d4" },
  { tag: t.variableName, color: "#9cdcfe" },
  { tag: t.definition(t.variableName), color: "#9cdcfe" },
  { tag: t.function(t.variableName), color: "#dcdcaa" },
  { tag: t.propertyName, color: "#9cdcfe" },
  { tag: t.string, color: "#ce9178" },
  { tag: t.number, color: "#b5cea8" },
  { tag: t.comment, color: "#6a9955", fontStyle: "italic" },
  { tag: t.className, color: "#4ec9b0" },
  { tag: t.typeName, color: "#4ec9b0" },
  { tag: t.angleBracket, color: "#808080" },
  { tag: t.tagName, color: "#569cd6" },
  { tag: t.attributeName, color: "#9cdcfe" }
]);

export class SnippetModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._editor = null; // Instancia del editor CodeMirror
    this._editingId = null; // ID del snippet en edición
  }

  /**
   * Ciclo de vida: Inicializa el componente al insertarse en el DOM.
   */
  connectedCallback() {
    this.render_();
    this.initEvents_();
    this.createEditor_();
  }

  /**
   * Renderiza el HTML y el CSS base. 
   * Nota: Los estilos específicos de CodeMirror se manejan en createEditor_().
   * @private
   */
  render_() {
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Fira+Code:wght@400&display=swap">
      <style>
        * { box-sizing: border-box; }
        :host { position: fixed; inset: 0; display: none; z-index: 1000; }
        :host(.qc__active) { display: flex; align-items: center; justify-content: center; }

        .qc__overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.7); }
        
        .qc__modal {
          position: relative; background: #252526; width: 92%; max-width: 360px;
          border-radius: 12px; border: 1px solid #333; overflow: hidden;
          box-shadow: 0 20px 40px rgba(0,0,0,0.6); font-family: sans-serif; color: #fff; z-index: 1;
        }

        .qc__header { padding: 16px; background: #1e1e1e; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
        .qc__title { font-size: 14px; font-weight: 600; }
        .qc__subtitle { font-size: 11px; color: #9ca3af; }
        .qc__close { background: transparent; border: none; color: #9ca3af; font-size: 18px; cursor: pointer; }

        .qc__body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
        .qc__form-group { display: flex; flex-direction: column; gap: 6px; }
        .qc__form-row { display: flex; gap: 10px; }
        .qc__form-row > .qc__form-group { flex: 1; }

        label { font-size: 10px; font-weight: 600; text-transform: uppercase; color: #3b82f6; }
        input, select { width: 100%; background: #121212; border: 1px solid #333; border-radius: 6px; color: #fff; padding: 10px; font-size: 13px; outline: none; }
        input:focus, select:focus { border-color: #3b82f6; }

        .qc__editor { border: 1px solid #2a2a2a; border-radius: 8px; overflow: hidden; background: #1e1e1e; }
        .qc__editor-header { background: #252526; padding: 6px 10px; font-size: 11px; color: #9ca3af; border-bottom: 1px solid #2a2a2a; }
        .qc__file-name { font-family: 'Fira Code', monospace; }

        #editor-anchor { height: 160px; font-size: 12px; }
        
        .qc__footer { padding: 12px 16px; background: #1e1e1e; border-top: 1px solid #333; display: flex; gap: 10px; }
        .qc__btn { flex: 1; padding: 10px; border-radius: 6px; border: none; cursor: pointer; font-size: 12px; font-weight: 600; }
        .qc__btn--secondary { background: #2d2d2d; color: #fff; }
        .qc__btn--primary { background: #3b82f6; color: #fff; }
      </style>

      <div class="qc__overlay"></div>
      <div class="qc__modal">
        <div class="qc__header">
          <div>
            <div class="qc__title">Snippet</div>
            <div class="qc__subtitle">Create or edit snippet</div>
          </div>
          <button class="qc__close">&times;</button>
        </div>

        <div class="qc__body">
          <div class="qc__form-group">
            <label>Name</label>
            <input type="text" id="name" autocomplete="off" placeholder="My function">
          </div>

          <div class="qc__form-row">
            <div class="qc__form-group">
              <label>Prefix</label>
              <input type="text" id="prefix" autocomplete="off" placeholder="!myfn">
            </div>
            <div class="qc__form-group">
              <label>Language</label>
              <select id="lang">
                <option value="javascript">Google Apps Script</option>
                <option value="html">HTML</option>
              </select>
            </div>
          </div>

          <div class="qc__form-group">
            <label>Code</label>
            <div class="qc__editor">
              <div class="qc__editor-header">
                <span class="qc__file-name">snippet.gs</span>
              </div>
              <div id="editor-anchor"></div>
            </div>
          </div>
        </div>

        <div class="qc__footer">
          <button class="qc__btn qc__btn--secondary" id="cancel">Cancel</button>
          <button class="qc__btn qc__btn--primary" id="save">Save</button>
        </div>
      </div>
    `;
  }

  /**
   * Crea la instancia de CodeMirror con el tema oscuro inyectado correctamente.
   * @private
   */
  createEditor_() {
    if (this._editor) return;
    const container = this.shadowRoot.getElementById('editor-anchor');
    
    // Definimos el tema oscuro como una extensión de EditorView
    const darkTheme = EditorView.theme({
      "&": { backgroundColor: "#1e1e1e", color: "#d4d4d4", height: "100%" },
      ".cm-scroller": { fontFamily: "'Fira Code', monospace" },
      ".cm-content": { caretColor: "#aeafad", padding: "10px 0" },
      
      // ESTILO DE LA BARRA DE NÚMEROS (GUTTERS)
      ".cm-gutters": { 
        backgroundColor: "#1e1e1e !important", 
        color: "#858585", 
        border: "none",
        minWidth: "35px"
      },
      ".cm-gutterElement": { 
        padding: "0 8px 0 4px"
      },
      
      ".cm-activeLine": { backgroundColor: "#2c2c2c" },
      ".cm-activeLineGutter": { backgroundColor: "#2c2c2c", color: "#cccccc" },
      ".cm-selectionBackground, ::selection": { backgroundColor: "#264f78 !important" }
    }, { dark: true });

    this._editor = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          javascript(),
          syntaxHighlighting(G_MONACO_STYLES),
          darkTheme // Inyectamos el tema aquí
        ]
      }),
      parent: container
    });
  }

  /**
   * Asigna eventos a los botones y cambios de select.
   * @private
   */
  initEvents_() {
    const sh = this.shadowRoot;
    sh.querySelector('.qc__close').onclick = () => this.close_();
    sh.querySelector('#cancel').onclick = () => this.close_();
    sh.querySelector('.qc__overlay').onclick = () => this.close_();
    sh.querySelector('#save').onclick = () => this.handleSave_();

    sh.getElementById('lang').onchange = () => {
      this.updateEditorLanguage_();
      this.updateFileName_();
    };
  }

  /**
   * Cambia el modo del editor (JS/HTML) sin destruir la instancia.
   * @private
   */
  updateEditorLanguage_() {
    if (!this._editor) return;
    const lang = this.shadowRoot.getElementById('lang').value;
    const langExt = lang === 'html' ? html() : javascript();
    
    // Reconfiguramos las extensiones dinámicamente
    this._editor.dispatch({
      effects: StateEffect.reconfigure.of([
        basicSetup, 
        langExt, 
        syntaxHighlighting(G_MONACO_STYLES),
        // Es vital mantener el tema aquí también al reconfigurar
        EditorView.theme({
          "&": { backgroundColor: "#1e1e1e" },
          ".cm-gutters": { backgroundColor: "#1e1e1e !important", color: "#858585", border: "none" }
        }, { dark: true })
      ])
    });
  }

  updateFileName_() {
    const lang = this.shadowRoot.getElementById('lang').value;
    const fileNameEl = this.shadowRoot.querySelector('.qc__file-name');
    fileNameEl.textContent = lang === 'html' ? 'snippet.html' : 'snippet.gs';
  }

  /**
   * Abre el modal y carga datos si es edición.
   */
  open_(snip = null) {
    this.classList.add('qc__active');
    this._editingId = snip?.id || null;
    const sh = this.shadowRoot;

    sh.getElementById('name').value = snip?.title || '';
    sh.getElementById('prefix').value = snip?.prefix || '';
    sh.getElementById('lang').value = snip?.lang || 'javascript';

    this.updateFileName_();
    this.updateEditorLanguage_();

    // Actualiza el texto del editor
    this._editor.dispatch({
      changes: { from: 0, to: this._editor.state.doc.length, insert: snip?.code || '' }
    });

    setTimeout(() => sh.getElementById('name').focus(), 150);
  }

  close_() {
    this.classList.remove('qc__active');
  }

  /**
   * Recupera los datos y emite el evento personalizado 'save-snippet'.
   * @private
   */
  handleSave_() {
    const sh = this.shadowRoot;
    const data = {
      id: this._editingId || Date.now().toString(),
      title: sh.getElementById('name').value.trim(),
      prefix: sh.getElementById('prefix').value.trim(),
      lang: sh.getElementById('lang').value,
      code: this._editor.state.doc.toString().trim()
    };

    if (!data.title || !data.prefix || !data.code) {
      this.dispatchEvent(new CustomEvent('form-error', { 
        detail: { message: 'All fields are required' }, 
        bubbles: true, 
        composed: true 
      }));
      return;
    }

    // Realizamos la petición de guardado a través de un evento personalizado para que el módulo principal (app.js) maneje la lógica de almacenamiento y actualización de la UI.
    this.dispatchEvent(new CustomEvent('save-snippet', { 
      detail: data, 
      bubbles: true, 
      composed: true 
    }));
    this.close_();
  }
}

// Definimos el custom element para usarlo en el DOM
customElements.define('snippet-modal', SnippetModal);