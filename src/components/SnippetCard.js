import {
  EditorView,
  EditorState,
  javascript,
  html,
  HighlightStyle,    
  syntaxHighlighting, 
  tags as t 
} from '../vendor/codemirror/codemirror.js';

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

export class SnippetCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._editor = null;
  }

  connectedCallback() {
    this.render_();
    this.initPreview_(); // Inicia el mini-editor tras el render
  }

  /**
   * Renderiza la estructura. Nota que reemplazamos el <pre> por un div contenedor.
   */
  render_() {
    const title_ = this.getAttribute('title') || 'Snippet';
    const lang_ = this.getAttribute('lang') || 'javascript';
    const prefix_ = this.getAttribute('prefix') || '';
    const isProtected_ = this.hasAttribute('protected');

    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0" />
      <style>
        :host { display: block; margin-bottom: 16px; }
        .qc__card { background: #1e1e1e; border-radius: 12px; padding: 14px; border: 1px solid #333; }
        .qc__header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .qc__icon { background: rgba(59, 130, 246, 0.1); width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 8px; color: #3b82f6; font-size: 14px; font-weight: bold; }
        .qc__actions { margin-left: auto; display: flex; gap: 4px; }
        .qc__action-btn { background: transparent; border: none; color: #6b7280; cursor: pointer; padding: 4px; border-radius: 4px; display: flex; }
        .qc__action-btn:hover { background: #2d2d2d; color: #fff; }
        
        .qc__window { background: #1e1e1e; border-radius: 8px; overflow: hidden; border: 1px solid #2a2a2a; }
        .qc__win-head { background: #252526; padding: 6px 12px; display: flex; gap: 5px; align-items: center; }
        .qc__dot { width: 8px; height: 8px; border-radius: 50%; }

        /* Contenedor del Preview */
        #preview-container { 
          max-height: 120px; 
          overflow: hidden; 
          font-size: 11px;
          cursor: default;
        }
        
        /* Ajustes de CodeMirror para el card */
        .cm-editor { background: transparent !important; }
        .cm-scroller { font-family: 'Fira Code', monospace !important; overflow: hidden !important; }
        .cm-content { padding: 8px !important; }
      </style>

      <div class="qc__card">
        <div class="qc__header">
          <div class="qc__icon">&lt;/&gt;</div>
          <div>
            <div style="font-size: 13px; font-weight: 600; color: #fff;">${title_}</div>
            <div style="font-size: 10px; color: #6b7280;">
              <span style="color: #f59e0b;">${prefix_}</span> - ${lang_}
            </div>
          </div>
          <div class="qc__actions">            
            ${!isProtected_ ? `
              <button class="qc__action-btn edit"><span class="material-symbols-outlined" style="font-size: 18px;">edit</span></button>
              <button class="qc__action-btn delete"><span class="material-symbols-outlined" style="font-size: 18px;">delete</span></button>
            ` : ''}
          </div>
        </div>
        <div class="qc__window">
          <div class="qc__win-head">
            <div class="qc__dot" style="background:#ff5f56"></div>
            <div class="qc__dot" style="background:#ffbd2e"></div>
            <div class="qc__dot" style="background:#27c93f"></div>
          </div>
          <div id="preview-container"></div>
        </div>
      </div>
    `;

    if (!isProtected_) {
      this.shadowRoot.querySelector('.edit').onclick = () => this.dispatchEvent(new CustomEvent('edit-snippet'));
      this.shadowRoot.querySelector('.delete').onclick = () => this.dispatchEvent(new CustomEvent('delete-snippet'));
    }
  }

  /**
   * Inicializa una versión ligera de CodeMirror.
   * @private
   */
  initPreview_() {
    const container = this.shadowRoot.getElementById('preview-container');
    const code_ = this.getAttribute('code') || '';
    const lang_ = this.getAttribute('lang') || 'javascript';

    // Seleccionamos el lenguaje
    const langSupport = lang_ === 'html' ? html() : javascript();

    this._editor = new EditorView({
      state: EditorState.create({
        doc: code_,
        extensions: [
          langSupport,
          syntaxHighlighting(G_MONACO_STYLES), // Resaltado de colores
          EditorState.readOnly.of(true),           // Bloquea edición
          EditorView.editable.of(false),           // Desactiva foco y teclado
          EditorView.theme({
            "&": { height: "auto" },
            ".cm-content": { whiteSpace: "pre-wrap", wordBreak: "break-all" }
          })
        ]
      }),
      parent: container
    });
  }
}

// Definimos el custom element para usarlo en el DOM
customElements.define('snippet-card', SnippetCard);