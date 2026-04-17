/**
 * Componente Web que representa una tarjeta de tema visual.
 * Muestra el nombre, tipo, paleta de colores y acciones dinámicas (duplicar/editar/borrar).
 * @extends HTMLElement
 */
export class ThemeCard extends HTMLElement {
  /**
   * Crea una instancia de ThemeCard e inicializa el Shadow DOM.
   */
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  /**
   * Ciclo de vida: Se ejecuta cuando el elemento se inserta en el DOM.
   */
  connectedCallback() {
    this.render_();
    this.initEvents_();
  }

  /**
   * Define los atributos observados.
   */
  static get observedAttributes() {
    return ['selected'];
  }

  /**
   * Reacciona a cambios en atributos (como la selección).
   */
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render_();
      this.initEvents_();
    }
  }

  /**
   * Renderiza el contenido del Shadow DOM con lógica de protección de temas.
   * @private
   */
  render_() {
    const name_ = this.getAttribute('name') || 'Theme';
    const type_ = this.getAttribute('type') || 'vs-dark';
    const colors_ = (this.getAttribute('colors') || '').split(',');
    const selected_ = this.hasAttribute('selected');
    const isProtected_ = this.hasAttribute('protected');

    this.shadowRoot.innerHTML = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0');
        
        :host { display: block; }
        
        .qc__card {
          position: relative;
          border-radius: 10px;
          border: 1px solid #333;
          padding: 14px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          background: #1e1e1e;
          user-select: none;
          overflow: hidden;
        }

        .qc__card:hover {
          background: #252526;
          border-color: #444;
          transform: translateY(-2px);
        }

        .qc__card.selected {
          border: 2px solid #4ade80;
          padding: 13px;
          background: rgba(74, 222, 128, 0.05);
        }

        /* Menú de acciones flotante */
        .qc__actions {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          gap: 4px;
          opacity: 0;
          transition: opacity 0.2s ease;
          z-index: 10;
        }

        .qc__card:hover .qc__actions {
          opacity: 1;
        }

        .qc__action-btn {
          background: #333;
          color: #fff;
          border: none;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.2s;
        }

        .qc__action-btn:hover { background: #3b82f6; }
        .qc__action-btn.delete:hover { background: #ef4444; }

        .qc__header {
          display: flex;
          flex-direction: column;
          margin-bottom: 10px;
        }

        .qc__title {
          font-size: 13px;
          font-weight: 600;
          color: #e5e7eb;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 120px;
        }

        .qc__badge {
          font-size: 9px;
          color: #9ca3af;
          text-transform: lowercase;
        }

        .qc__palette {
          display: flex;
          gap: 4px;
          margin-bottom: 12px;
        }

        .qc__dot {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 2px solid #1e1e1e;
        }

        .qc__preview {
          font-family: 'Fira Code', monospace;
          font-size: 10px;
          padding-top: 8px;
          border-top: 1px solid #333;
        }

        .qc__kw { color: ${colors_[1] || '#c586c0'}; }
        .qc__st { color: ${colors_[3] || '#ce9178'}; }

        .qc__check-mark {
          position: absolute;
          bottom: 0;
          right: 0;
          width: 0;
          height: 0;
          border-style: solid;
          border-width: 0 0 24px 24px;
          border-color: transparent transparent #4ade80 transparent;
          display: ${selected_ ? 'block' : 'none'};
        }
      </style>

      <div class="qc__card ${selected_ ? 'selected' : ''}">
        <div class="qc__actions">
          <button class="qc__action-btn duplicate" title="Duplicate Theme">
            <span class="material-symbols-outlined" style="font-size: 16px;">content_copy</span>
          </button>
          ${!isProtected_ ? `
            <button class="qc__action-btn edit" title="Edit Theme">
              <span class="material-symbols-outlined" style="font-size: 16px;">edit</span>
            </button>
            <button class="qc__action-btn delete" title="Delete Theme">
              <span class="material-symbols-outlined" style="font-size: 16px;">delete</span>
            </button>
          ` : ''}
        </div>

        <div class="qc__header">
          <span class="qc__title">${name_}</span>
          <span class="qc__badge">${isProtected_ ? 'system' : 'custom'}</span>
        </div>

        <div class="qc__palette">
          ${colors_.map(c => `<div class="qc__dot" style="background:${c}"></div>`).join('')}
        </div>

        <div class="qc__preview">
          <div><span class="qc__kw">class</span> <span class="qc__st">Theme</span> {}</div>
        </div>

        <div class="qc__check-mark"></div>
      </div>
    `;
  }

  /**
   * Inicializa los eventos de la tarjeta y sus botones de acción.
   * @private
   */
  initEvents_() {
    const card = this.shadowRoot.querySelector('.qc__card');
    
    // Evento de selección (evita dispararse si se pulsa un botón de acción)
    card.onclick = (e) => {
      if (e.target.closest('.qc__action-btn')) return;
      this.dispatchEvent(new CustomEvent('select-theme', {
        detail: { value: this.getAttribute('value'), name: this.getAttribute('name') },
        bubbles: true, composed: true
      }));
    };

    // Eventos de botones (Duplicate, Edit, Delete)
    this.shadowRoot.querySelectorAll('.qc__action-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const type = btn.classList.contains('duplicate') ? 'duplicate' : btn.classList.contains('edit') ? 'edit' : 'delete';
        
        this.dispatchEvent(new CustomEvent(`${type}-theme`, {
          detail: { value: this.getAttribute('value') },
          bubbles: true, composed: true
        }));
      };
    });
  }
}

customElements.define('theme-card', ThemeCard);