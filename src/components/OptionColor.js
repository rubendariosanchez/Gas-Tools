/**
 * Componente de selector de color estandarizado para la extensión.
 */
export class OptionColor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() { return ['value']; }

  attributeChangedCallback(name_, old_, new_) {
    if (name_ === 'value' && this.shadowRoot) {
      const input_ = this.shadowRoot.querySelector('input');
      if (input_) {
        input_.value = new_;
      }
    }
  }

  connectedCallback() {
    this.render_();
  }

  render_() {
    const title_ = this.getAttribute('title') || 'Color';
    const desc_ = this.getAttribute('description') || '';
    const value_ = this.getAttribute('value') || '#5f6368';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 14px 0; border-bottom: 1px solid #222; }
        .qc__row { display: flex; justify-content: space-between; align-items: center; }
        .qc__info { flex: 1; padding-right: 16px; }
        .qc__title { color: #fff; font-size: 14px; font-weight: 500; font-family: sans-serif; }
        .qc__desc { color: #9ca3af; font-size: 11px; margin-top: 3px; line-height: 1.4; }
        
        .qc__color-wrapper {
          position: relative;
          width: 36px;
          height: 20px;
          border-radius: 4px;
          overflow: hidden;
          border: 1px solid #3f3f3f;
          background: #111;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        input[type="color"] {
          position: absolute;
          top: -5px;
          left: -5px;
          width: 50px;
          height: 50px;
          cursor: pointer;
          border: none;
          background: none;
          padding: 0;
        }
      </style>
      <div class="qc__row">
        <div class="qc__info">
          <div class="qc__title">${title_}</div>
          ${desc_ ? `<div class="qc__desc">${desc_}</div>` : ''}
        </div>
        <div class="qc__color-wrapper">
          <input type="color" value="${value_}">
        </div>
      </div>
    `;

    this.shadowRoot.querySelector('input').addEventListener('change', (e_) => {
      const newVal = e_.target.value;
      this.setAttribute('value', newVal);

      this.dispatchEvent(new CustomEvent('color-change', {
        detail: { value: newVal },
        bubbles: true,
        composed: true
      }));
    });
  }
}
customElements.define('option-color', OptionColor);
