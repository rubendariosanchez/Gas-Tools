/**
 * Componente Web que representa una tarjeta de tema visual.
 * Muestra el nombre, tipo, paleta de colores y una pequeña previsualización de código.
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
   * Lanza el renderizado inicial y los eventos.
   */
  connectedCallback() {
    this.render_();
    this.initEvents_();
  }

  /**
   * Define qué atributos queremos observar para reaccionar a sus cambios.
   * @returns {string[]} Lista de atributos.
   */
  static get observedAttributes() {
    return ['selected'];
  }

  /**
   * Ciclo de vida: Se ejecuta cuando un atributo observado cambia.
   * @param {string} name - Nombre del atributo.
   * @param {string} oldValue - Valor anterior.
   * @param {string} newValue - Nuevo valor.
   */
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render_();
      this.initEvents_();
    }
  }

  /**
   * Renderiza el contenido del Shadow DOM con estilos encapsulados.
   * Maneja la lógica visual del check verde y la previsualización.
   * @private
   */
  render_() {
    const name_ = this.getAttribute('name') || 'Theme';
    const type_ = this.getAttribute('type') || 'vs-dark';
    const colors_ = (this.getAttribute('colors') || '').split(',');
    const selected_ = this.hasAttribute('selected');

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
          overflow: hidden; /* Importante para que el check no sobresalga */
        }

        .qc__card:hover {
          background: #252526;
          border-color: #444;
          transform: translateY(-2px);
        }

        /* Estado seleccionado: Borde verde y fondo sutil */
        .qc__card.selected {
          border: 2px solid #4ade80; /* Verde brillante (Tailwind green-400) */
          padding: 13px; /* Compensación por el borde de 2px */
          background: rgba(74, 222, 128, 0.05);
        }

        /* Esquina del Check (Triángulo Verde) */
        .qc__check-mark {
          position: absolute;
          bottom: 0;
          right: 0;
          width: 0;
          height: 0;
          border-style: solid;
          border-width: 0 0 32px 32px; /* Un poco más grande para mejor visibilidad */
          border-color: transparent transparent #4ade80 transparent;
          display: none;
          z-index: 2;
        }

        .qc__check-icon {
          position: absolute;
          bottom: -30px; 
          right: 2px;
          font-size: 16px;
          font-weight: bold;
          color: #064e3b; /* Verde oscuro para contraste sobre el fondo verde */
          pointer-events: none;
        }

        .qc__card.selected .qc__check-mark {
          display: block;
        }

        .qc__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }

        .qc__title {
          font-size: 13px;
          font-weight: 600;
          color: #e5e7eb;
        }

        .qc__badge {
          font-size: 9px;
          padding: 2px 6px;
          border-radius: 4px;
          background: #2d2d2d;
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
          font-family: 'Fira Code', 'Consolas', monospace;
          font-size: 10px;
          line-height: 1.5;
          padding-top: 8px;
          border-top: 1px solid #333;
        }

        /* Colores dinámicos basados en la paleta del tema */
        .kw { color: ${colors_[1] || '#c586c0'}; } 
        .cm { color: #6a9955; opacity: 0.8; }
        .st { color: ${colors_[3] || '#ce9178'}; }
      </style>

      <div class="qc__card ${selected_ ? 'selected' : ''}">
        <div class="qc__header">
          <span class="qc__title">${name_}</span>
          <span class="qc__badge">${type_}</span>
        </div>

        <div class="qc__palette">
          ${colors_.map(c => `<div class="qc__dot" style="background:${c}"></div>`).join('')}
        </div>

        <div class="qc__preview">
          <div><span class="kw">function</span></div>
          <div><span class="cm">// active theme</span></div>
          <div><span class="st">"selected"</span></div>
        </div>

        <div class="qc__check-mark">
          <span class="material-symbols-outlined qc__check-icon">check</span>
        </div>
      </div>
    `;
  }

  /**
   * Inicializa los escuchadores de eventos.
   * Al hacer click, emite un evento personalizado para que el padre gestione la lógica.
   * @private
   */
  initEvents_() {
    const card = this.shadowRoot.querySelector('.qc__card');
    if (!card) return;

    // Al hacer click en la tarjeta, emitimos un evento personalizado con el valor del tema
    card.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('select-theme', {
        detail: { 
          value: this.getAttribute('value'),
          name: this.getAttribute('name')
        },
        bubbles: true,
        composed: true
      }));
    });
  }
}

// Registro del elemento personalizado
customElements.define('theme-card', ThemeCard);