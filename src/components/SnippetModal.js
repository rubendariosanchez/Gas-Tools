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
import { tr } from '../js/utils/I18n.js';

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
      <style>
        * { box-sizing: border-box; }
        :host { position: fixed; inset: 0; display: none; z-index: var(--gt-z-modal, 2000); }
        :host(.qc__active) { display: flex; align-items: center; justify-content: center; }

        .qc__overlay { position: absolute; inset: 0; background: var(--gt-scrim, rgba(0, 0, 0, .32)); }

        .qc__modal {
          position: relative; z-index: 1; width: 92%; max-width: 360px; overflow: hidden;
          background: var(--gt-surface-container-high, #e9eef6);
          color: var(--gt-on-surface, #1f1f1f);
          border-radius: var(--gt-shape-xl, 28px);
          box-shadow: var(--gt-elevation-3, 0 4px 8px rgba(0, 0, 0, .3));
          font: var(--gt-type-body-m, 400 14px/20px Arial, sans-serif);
        }

        .qc__header { padding: var(--gt-space-5, 24px) var(--gt-space-5, 24px) var(--gt-space-2, 8px); display: flex; justify-content: space-between; align-items: center; }
        .qc__title { font: var(--gt-type-title-m, 500 16px/24px Arial, sans-serif); }
        .qc__subtitle { font: var(--gt-type-body-s, 400 12px/16px Arial, sans-serif); color: var(--gt-on-surface-variant, #444746); }
        .qc__close {
          width: 32px; height: 32px; border: none; cursor: pointer;
          border-radius: var(--gt-shape-full, 9999px);
          background: transparent; color: var(--gt-on-surface-variant, #444746); font-size: 20px;
        }
        .qc__close:hover { background: var(--gt-state-hover, rgba(31, 31, 31, .08)); }

        .qc__body { padding: var(--gt-space-2, 8px) var(--gt-space-5, 24px); display: flex; flex-direction: column; gap: var(--gt-space-3, 12px); }
        .qc__form-group { display: flex; flex-direction: column; gap: var(--gt-space-1, 4px); }
        .qc__form-row { display: flex; gap: 10px; }
        .qc__form-row > .qc__form-group { flex: 1; }

        label { font: var(--gt-type-label-s, 500 11px/16px Arial, sans-serif); color: var(--gt-on-surface-variant, #444746); }
        input, select {
          width: 100%; padding: 8px 10px; outline: none;
          background: var(--gt-surface, #ffffff); color: var(--gt-on-surface, #1f1f1f);
          border: 1px solid var(--gt-outline, #747775); border-radius: var(--gt-shape-xs, 4px);
          font: var(--gt-type-body-m, 400 14px/20px Arial, sans-serif);
        }
        input:focus-visible, select:focus-visible { outline: 2px solid var(--gt-primary, #0b57d0); outline-offset: -1px; }

        .qc__editor { border: 1px solid var(--gt-code-outline, #3c3c3c); border-radius: var(--gt-shape-s, 8px); overflow: hidden; background: var(--gt-code-surface, #1e1e1e); }
        .qc__editor-header { background: var(--gt-code-surface-high, #252526); padding: 6px 10px; font-size: 11px; color: var(--gt-code-on-surface, #d4d4d4); border-bottom: 1px solid var(--gt-code-outline, #3c3c3c); }
        .qc__file-name { font-family: var(--gt-font-mono, monospace); }

        #editor-anchor { height: 160px; font-size: 12px; }

        .qc__footer { padding: var(--gt-space-4, 16px) var(--gt-space-5, 24px) var(--gt-space-5, 24px); display: flex; justify-content: flex-end; gap: var(--gt-space-2, 8px); }
        .qc__btn {
          height: 36px; padding: 0 var(--gt-space-4, 16px); border: none; cursor: pointer;
          border-radius: var(--gt-shape-full, 9999px);
          font: var(--gt-type-title-s, 500 14px/20px Arial, sans-serif);
        }
        .qc__btn:focus-visible { outline: 2px solid var(--gt-primary, #0b57d0); outline-offset: 2px; }
        .qc__btn--secondary { background: transparent; color: var(--gt-primary, #0b57d0); }
        .qc__btn--secondary:hover { background: var(--gt-state-hover, rgba(31, 31, 31, .08)); }
        .qc__btn--primary { background: var(--gt-primary, #0b57d0); color: var(--gt-on-primary, #ffffff); }
      </style>

      <div class="qc__overlay"></div>
      <div class="qc__modal" role="dialog" aria-modal="true" aria-labelledby="qc-snippet-title">
        <div class="qc__header">
          <div>
            <div class="qc__title" id="qc-snippet-title">${tr('snippetModalTitle', 'Snippet')}</div>
            <div class="qc__subtitle">${tr('snippetModalSubtitle', 'Create or edit snippet')}</div>
          </div>
          <button type="button" class="qc__close" aria-label="${tr('btnCancel', 'Cancel')}">&times;</button>
        </div>

        <div class="qc__body">
          <div class="qc__form-group">
            <label for="name">${tr('labelName', 'Name')}</label>
            <input type="text" id="name" autocomplete="off" placeholder="${tr('placeholderSnippetName', 'My function')}">
          </div>

          <div class="qc__form-row">
            <div class="qc__form-group">
              <label for="prefix">${tr('labelPrefix', 'Prefix')}</label>
              <input type="text" id="prefix" autocomplete="off" placeholder="!myfn">
            </div>
            <div class="qc__form-group">
              <label for="lang">${tr('labelLanguage', 'Language')}</label>
              <select id="lang">
                <option value="javascript">Google Apps Script</option>
                <option value="html">HTML</option>
              </select>
            </div>
          </div>

          <div class="qc__form-group">
            <label>${tr('labelCode', 'Code')}</label>
            <div class="qc__editor">
              <div class="qc__editor-header">
                <span class="qc__file-name">snippet.gs</span>
              </div>
              <div id="editor-anchor"></div>
            </div>
          </div>
        </div>

        <div class="qc__footer">
          <button type="button" class="qc__btn qc__btn--secondary" id="cancel">${tr('btnCancel', 'Cancel')}</button>
          <button type="button" class="qc__btn qc__btn--primary" id="save">${tr('btnSave', 'Save')}</button>
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
      "&": { backgroundColor: "var(--gt-code-surface, #1e1e1e)", color: "var(--gt-code-on-surface, #d4d4d4)", height: "100%" },
      ".cm-scroller": { fontFamily: "var(--gt-font-mono, monospace)" },
      ".cm-content": { caretColor: "#aeafad", padding: "10px 0" },
      
      // ESTILO DE LA BARRA DE NÚMEROS (GUTTERS)
      ".cm-gutters": { 
        backgroundColor: "var(--gt-code-surface, #1e1e1e) !important", 
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
          "&": { backgroundColor: "var(--gt-code-surface, #1e1e1e)" },
          ".cm-gutters": { backgroundColor: "var(--gt-code-surface, #1e1e1e) !important", color: "#858585", border: "none" }
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
        detail: { message: tr('errorAllFieldsRequired', 'All fields are required') }, 
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