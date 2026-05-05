/**
 * Componente web para una opción de tipo rango (slider).
 * Renderiza un input range con etiqueta, descripción y valor actual visible.
 *
 * @element option-range
 * @attr {number} value   - Valor actual del slider
 * @attr {number} min     - Valor mínimo permitido
 * @attr {number} max     - Valor máximo permitido
 * @attr {number} step    - Incremento por paso
 * @attr {string} title   - Etiqueta visible del control
 * @attr {string} description - Texto descriptivo debajo del título
 *
 * @fires range - Emitido al soltar el slider; detail: { value: number }
 */
export class OptionRange extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['value', 'min', 'max', 'step'];
  }

  /** Vuelve a renderizar cuando cambia cualquier atributo observado */
  attributeChangedCallback(name_, old_, new_) {
    if (this.shadowRoot) this.render_();
  }

  /** Renderizado inicial al insertar el elemento en el DOM */
  connectedCallback() {
    this.render_();
  }

  /** Valor actual parseado como número flotante */
  get value() {
    return parseFloat(this.getAttribute('value')) || 0;
  }

  render_() {
    const title_ = this.getAttribute('title') || 'Option';
    const desc_ = this.getAttribute('description') || '';
    const min = parseFloat(this.getAttribute('min')) || 0;
    const max = parseFloat(this.getAttribute('max')) || 100;
    const step = parseFloat(this.getAttribute('step')) || 1;
    const value = parseFloat(this.getAttribute('value')) || min;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 14px 0; border-bottom: 1px solid #222; }

        .qc__row  { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; }
        .qc__info { flex: 1; min-width: 120px; padding-right: 16px; }

        .qc__title { color: #fff; font-size: 14px; font-weight: 500; font-family: sans-serif; }
        .qc__desc  { color: #9ca3af; font-size: 11px; margin-top: 3px; line-height: 1.4; }

        .qc__range-container { display: flex; align-items: center; flex: 1; }

        /* Track del slider */
        .qc__range-input {
          -webkit-appearance: none;
          appearance: none;
          width: 100px;
          height: 4px;
          background: #3f3f3f;
          border-radius: 2px;
          outline: none;
          cursor: pointer;
          margin-right: 10px;
        }

        /* Thumb — Webkit */
        .qc__range-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #3b82f6;
          cursor: pointer;
        }

        /* Thumb — Firefox */
        .qc__range-input::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #3b82f6;
          cursor: pointer;
          border: none;
        }

        /* Etiqueta numérica junto al slider */
        .qc__range-value {
          color: #9ca3af;
          font-size: 12px;
          min-width: 28px;
          text-align: right;
        }
      </style>

      <div class="qc__row">
        <div class="qc__info">
          <div class="qc__title">${title_}</div>
          ${desc_ ? `<div class="qc__desc">${desc_}</div>` : ''}
        </div>
        <div class="qc__range-container">
          <input type="range" class="qc__range-input"
            min="${min}" max="${max}" step="${step}" value="${value}">
          <span class="qc__range-value">${value}</span>
        </div>
      </div>
    `;

    const input = this.shadowRoot.querySelector('input');
    const valueDisplay = this.shadowRoot.querySelector('.qc__range-value');

    // Actualiza la etiqueta numérica en tiempo real mientras se arrastra
    input.addEventListener('input', (e_) => {
      valueDisplay.textContent = e_.target.value;
      this.setAttribute('value', e_.target.value);
    });

    // Emite el evento final solo al soltar el slider para evitar disparos excesivos
    input.addEventListener('change', (e_) => {
      this.dispatchEvent(new CustomEvent('range', {
        detail: { value: parseFloat(e_.target.value) },
        bubbles: true,
        composed: true,
      }));
    });
  }
}

customElements.define('option-range', OptionRange);