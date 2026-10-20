import {
  EditorView,
  EditorState,
  javascript,
  html,
  HighlightStyle,    
  syntaxHighlighting, 
  tags as t 
} from '../vendor/codemirror/codemirror.js';
import { tr } from '../js/utils/I18n.js';
import { icon } from '../js/utils/Icons.js';
import { escapeHtml } from '../js/utils/Html.js';

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
    // Hoja base de GasUi (clase .gt-icon de los SVG).
    globalThis.GasUi?.adopt(this.shadowRoot);
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
    const title_ = escapeHtml(this.getAttribute('title') || 'Snippet');
    const lang_ = escapeHtml(this.getAttribute('lang') || 'javascript');
    const prefix_ = escapeHtml(this.getAttribute('prefix') || '');
    const isProtected_ = this.hasAttribute('protected');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; margin-top: var(--gt-space-3, 12px); }
        .qc__card {
          background: var(--gt-surface, #ffffff);
          border-radius: var(--gt-shape-l, 16px);
          box-shadow: 0 1px 2px rgba(0, 0, 0, .05), 0 1px 3px 1px rgba(0, 0, 0, .03);
          transition: box-shadow var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
          padding: var(--gt-space-3, 12px);
          color: var(--gt-on-surface, #1f1f1f);
          font-family: var(--gt-font-plain, Arial, sans-serif);
        }
        .qc__card:hover { box-shadow: var(--gt-elevation-1, 0 1px 3px rgba(0, 0, 0, .2)); }
        .qc__header { display: flex; align-items: center; gap: 10px; margin-bottom: var(--gt-space-3, 12px); }
        .qc__icon {
          display: flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; flex-shrink: 0;
          border-radius: var(--gt-shape-m, 12px);
          background: var(--gt-secondary-container, #c2e7ff);
          color: var(--gt-on-secondary-container, #001d35);
          font: 700 12px/1 var(--gt-font-mono, monospace);
        }
        .qc__name { font: var(--gt-type-title-s, 500 14px/20px Arial, sans-serif); }
        .qc__meta { font: var(--gt-type-body-s, 400 12px/16px Arial, sans-serif); color: var(--gt-on-surface-variant, #444746); }
        .qc__prefix {
          display: inline-block; padding: 0 6px; border-radius: var(--gt-shape-xs, 4px);
          background: var(--gt-primary-container, #d3e3fd); color: var(--gt-on-primary-container, #041e49);
          font: 500 11px/16px var(--gt-font-mono, monospace);
        }
        .qc__actions { margin-left: auto; display: flex; gap: 2px; }
        .qc__action-btn {
          display: flex; padding: 6px; border: none; cursor: pointer;
          border-radius: var(--gt-shape-full, 9999px);
          background: transparent; color: var(--gt-on-surface-variant, #444746);
        }
        .qc__action-btn:hover { background: var(--gt-state-hover, rgba(31, 31, 31, .08)); color: var(--gt-on-surface, #1f1f1f); }
        .qc__action-btn:focus-visible { outline: 2px solid var(--gt-primary, #0b57d0); }

        /* Ventana de código: superficie de código (oscura en ambos modos, como el resaltado) */
        .qc__window {
          background: var(--gt-code-surface, #1e1e1e);
          color: var(--gt-code-on-surface, #d4d4d4);
          border-radius: var(--gt-shape-s, 8px);
          overflow: hidden;
          border: 1px solid var(--gt-code-outline, #3c3c3c);
        }
        .qc__win-head { background: var(--gt-code-surface-high, #252526); padding: 6px 12px; display: flex; gap: 5px; align-items: center; }
        .qc__dot { width: 8px; height: 8px; border-radius: 50%; }
        .qc__dot--red { background: var(--gt-error, #b3261e); }
        .qc__dot--yellow { background: var(--gt-warning, #7c5800); }
        .qc__dot--green { background: var(--gt-success, #146c2e); }

        /* Contenedor del Preview */
        #preview-container { 
          max-height: 120px; 
          overflow: hidden; 
          font-size: 11px;
          cursor: default;
        }
        
        /* Ajustes de CodeMirror para el card */
        .cm-editor { background: transparent !important; }
        .cm-scroller { font-family: var(--gt-font-mono, monospace) !important; overflow: hidden !important; }
        .cm-content { padding: 8px !important; }
      </style>

      <div class="qc__card">
        <div class="qc__header">
          <div class="qc__icon" aria-hidden="true">&lt;/&gt;</div>
          <div>
            <div class="qc__name">${title_}</div>
            <div class="qc__meta">
              <span class="qc__prefix">${prefix_}</span> · ${lang_}
            </div>
          </div>
          <div class="qc__actions">            
            ${!isProtected_ ? `
              <button type="button" class="qc__action-btn edit" title="${tr('btnEdit', 'Edit')}" aria-label="${tr('btnEdit', 'Edit')}">${icon('pencil', 18)}</button>
              <button type="button" class="qc__action-btn delete" title="${tr('btnDelete', 'Delete')}" aria-label="${tr('btnDelete', 'Delete')}">${icon('trash', 18)}</button>
            ` : ''}
          </div>
        </div>
        <div class="qc__window">
          <div class="qc__win-head" aria-hidden="true">
            <div class="qc__dot qc__dot--red"></div>
            <div class="qc__dot qc__dot--yellow"></div>
            <div class="qc__dot qc__dot--green"></div>
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