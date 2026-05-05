export class OptionSelect extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() { return ['value', 'options']; }

  attributeChangedCallback(name_, old_, new_) {
    if (this.shadowRoot && (name_ === 'value' || name_ === 'options')) {
      this.render_();
    }
  }

  connectedCallback() {
    this.render_();
  }

  get value() {
    return this.getAttribute('value') || this._defaultValue;
  }

  render_() {
    const title_ = this.getAttribute('title') || 'Option';
    const desc_ = this.getAttribute('description') || '';
    const currentValue = this.getAttribute('value') || '';
    this._defaultValue = currentValue;

    const optionsStr = this.getAttribute('options') || 'on,off';
    const options = optionsStr.split(',').map(opt => {
      const [val, label] = opt.split(':');
      return { value: val, label: label || val };
    });

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 14px 0; border-bottom: 1px solid #222; }
        .qc__row { display: flex; justify-content: space-between; align-items: center; }
        .qc__info { flex: 1; padding-right: 16px; }
        .qc__title { color: #fff; font-size: 14px; font-weight: 500; font-family: sans-serif; }
        .qc__desc { color: #9ca3af; font-size: 11px; margin-top: 3px; line-height: 1.4; }
        
        .qc__select {
          background: #3f3f3f;
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          cursor: pointer;
          min-width: 100px;
        }
        .qc__select:focus { outline: 2px solid #3b82f6; }
        .qc__select option { background: #252526; color: #fff; }
      </style>
      <div class="qc__row">
        <div class="qc__info">
          <div class="qc__title">${title_}</div>
          ${desc_ ? `<div class="qc__desc">${desc_}</div>` : ''}
        </div>
        <select class="qc__select">
          ${options.map(opt => 
            `<option value="${opt.value}" ${opt.value === currentValue ? 'selected' : ''}>${opt.label}</option>`
          ).join('')}
        </select>
      </div>
    `;

    this.shadowRoot.querySelector('select').addEventListener('change', (e_) => {
      this.setAttribute('value', e_.target.value);
      this.dispatchEvent(new CustomEvent('select', {
        detail: { value: e_.target.value },
        bubbles: true,
        composed: true
      }));
    });
  }
}
customElements.define('option-select', OptionSelect);