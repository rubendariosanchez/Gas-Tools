/**
 * Componente de interruptor estandarizado para la extensión.
 */
export class OptionToggle extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() { return ['checked']; }

  // Esta función se dispara cada vez que cambias el atributo desde app.js
  attributeChangedCallback(name_, old_, new_) {
    if (name_ === 'checked' && this.shadowRoot) {
      const input_ = this.shadowRoot.querySelector('input');
      if (input_) {
        // hasAttribute es la forma más fiable de verificar booleanos en HTML
        input_.checked = this.hasAttribute('checked');
      }
    }
  }

  connectedCallback() {
    this.render_();
  }

  /**
   * Renderiza el contenido del componente.
   * @private
   */
  render_() {
    const title_ = this.getAttribute('title') || 'Opción';
    const desc_ = this.getAttribute('description') || '';
    const isChecked_ = this.hasAttribute('checked');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 14px 0; border-bottom: 1px solid #222; }
        .qc__row { display: flex; justify-content: space-between; align-items: center; }
        .qc__info { flex: 1; padding-right: 16px; }
        .qc__title { color: #fff; font-size: 14px; font-weight: 500; font-family: sans-serif; }
        .qc__desc { color: #9ca3af; font-size: 11px; margin-top: 3px; line-height: 1.4; }
        
        .qc__switch {
          position: relative; display: inline-block; width: 36px; height: 20px;
        }
        .qc__switch input { opacity: 0; width: 0; height: 0; }
        .qc__slider {
          position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
          background-color: #3f3f3f; transition: .3s; border-radius: 20px;
        }
        .qc__slider:before {
          position: absolute; content: ""; height: 14px; width: 14px;
          left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%;
        }
        input:checked + .qc__slider { background-color: #3b82f6; }
        input:checked + .qc__slider:before { transform: translateX(16px); }
      </style>
      <div class="qc__row">
        <div class="qc__info">
          <div class="qc__title">${title_}</div>
          ${desc_ ? `<div class="qc__desc">${desc_}</div>` : ''}
        </div>
        <label class="qc__switch">
          <input type="checkbox" ${isChecked_ ? 'checked' : ''}>
          <span class="qc__slider"></span>
        </label>
      </div>
    `;

    this.shadowRoot.querySelector('input').addEventListener('change', (e_) => {
      if (e_.target.checked) {
        this.setAttribute('checked', '');
      } else {
        this.removeAttribute('checked');
      }

      this.dispatchEvent(new CustomEvent('toggle', {
        detail: { checked: e_.target.checked },
        bubbles: true,
        composed: true
      }));
    });
  }
}
customElements.define('option-toggle', OptionToggle);