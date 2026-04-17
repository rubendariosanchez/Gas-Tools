// Componente personalizado para mostrar un snippet de código con su información relevante.
export class SnippetCard extends HTMLElement {

  /**
   * Constructor del componente, donde se adjunta el shadow DOM para encapsular estilos y estructura.
   */
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  /**
   * Cuando el elemento se conecta al DOM, renderiza su contenido basado en los atributos proporcionados.
   */
  connectedCallback() {
    this.render_();
  }

  /**
   * Renderiza el contenido del snippet card basado en los atributos proporcionados.
   */
  render_() {
    const title_ = this.getAttribute('title') || 'Snippet';
    const lang_ = this.getAttribute('lang') || 'JS';
    const prefix_ = this.getAttribute('prefix') || '';
    const code_ = this.getAttribute('code') || '';
    const isProtected_ = this.hasAttribute('protected');

    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0" />
      <style>
        :host { display: block; margin-bottom: 16px; }
        .qc__card {
          background: #1e1e1e; border-radius: 12px; padding: 14px;
          border: 1px solid #333; transition: border-color 0.2s;
        }
        .qc__card:hover { border-color: #444; }
        .qc__header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .qc__icon { 
          background: rgba(59, 130, 246, 0.1); width: 32px; height: 32px; 
          display: flex; align-items: center; justify-content: center;
          border-radius: 8px; color: #3b82f6; font-size: 14px; font-weight: bold; 
        }
        .qc__actions { margin-left: auto; display: flex; gap: 4px; }
        .qc__action-btn {
          background: transparent; border: none; color: #6b7280;
          cursor: pointer; padding: 4px; border-radius: 4px; display: flex;
        }
        .qc__action-btn:hover { background: #2d2d2d; color: #fff; }
        .qc__action-btn.delete:hover { color: #ef4444; }

        .qc__window { background: #0d0d0d; border-radius: 8px; overflow: hidden; border: 1px solid #2a2a2a; }
        .qc__win-head { background: #252526; padding: 6px 12px; display: flex; gap: 5px; align-items: center; }
        .qc__dot { width: 8px; height: 8px; border-radius: 50%; }
        
        pre { 
          margin: 0; padding: 12px; font-size: 11px; color: #d1d5db; 
          max-height: 120px; overflow: auto; font-family: 'Fira Code', monospace; 
        }
        .prefix-tag { color: #f59e0b; font-weight: 500; }
      </style>

      <div class="qc__card">
        <div class="qc__header">
          <div class="qc__icon">&lt;/&gt;</div>
          <div>
            <div style="font-size: 13px; font-weight: 600; color: #fff;">${title_}</div>
            <div style="font-size: 10px; color: #6b7280;">
              <span class="prefix-tag">${prefix_}</span> - ${lang_}
            </div>
          </div>
          <div class="qc__actions">            
            ${!isProtected_ ? `
              <button class="qc__action-btn edit" title="Edit">
                <span class="material-symbols-outlined" style="font-size: 18px;">edit</span>
              </button>
              <button class="qc__action-btn delete" title="Delete">
                <span class="material-symbols-outlined" style="font-size: 18px;">delete</span>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="qc__window">
          <div class="qc__win-head">
            <div class="qc__dot" style="background:#ff5f56"></div>
            <div class="qc__dot" style="background:#ffbd2e"></div>
            <div class="qc__dot" style="background:#27c93f"></div>
            <span style="margin-left: auto; font-size: 9px; color: #4b5563;">${lang_}</span>
          </div>
          <pre><code>${code_.replace(/</g, '&lt;')}</code></pre>
        </div>
      </div>
    `;

    // Eventos de botones
    if (!isProtected_) {
      this.shadowRoot.querySelector('.edit').onclick = () => this.dispatchEvent(new CustomEvent('edit-snippet'));
      this.shadowRoot.querySelector('.delete').onclick = () => this.dispatchEvent(new CustomEvent('delete-snippet'));
    }
  }
}

// Creamos el respectivo componente personalizado
customElements.define('snippet-card', SnippetCard);