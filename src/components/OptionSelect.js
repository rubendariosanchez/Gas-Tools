import { tr } from '../js/utils/I18n.js';
import { OPTION_BASE_CSS } from './OptionStyles.js';

/**
 * Selector estandarizado. Atributos: value, options ("valor:etiqueta,..."), disabled, title/description o data-i18n-*.
 * @fires select - detail: { value }.
 */
export class OptionSelect extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() { return ['value', 'options', 'title', 'description', 'disabled']; }

  attributeChangedCallback(name_, old_, new_) {
    // Solo re-renderizamos si ya hubo un primer render (connectedCallback)
    if (this.shadowRoot?.childElementCount && old_ !== new_) {
      this.render_();
    }
  }

  connectedCallback() {
    this.render_();
  }

  get value() {
    return this.getAttribute('value') || this._defaultValue;
  }

  /**
   * Renderiza el contenido del componente.
   * @private
   */
  render_() {
    const title_ = tr(this.dataset.i18nTitle, this.getAttribute('title') || 'Option');
    const desc_ = tr(this.dataset.i18nDescription, this.getAttribute('description') || '');
    const currentValue = this.getAttribute('value') || '';
    const isDisabled_ = this.hasAttribute('disabled');
    this._defaultValue = currentValue;

    const optionsStr = this.getAttribute('options') || 'on,off';
    const options = optionsStr.split(',').map(opt => {
      const [val, label] = opt.split(':');
      return { value: val, label: label || val };
    });

    this.shadowRoot.innerHTML = `
      <style>
        ${OPTION_BASE_CSS}
        /* Select relleno (Material 3 filled) con chevron propio */
        .qc__select {
          flex-shrink: 0;
          width: 144px;
          height: 34px;
          padding: 0 30px 0 var(--gt-space-3, 12px);
          appearance: none;
          -webkit-appearance: none;
          background-color: var(--gt-surface-container, #f0f4f9);
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238e918f' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          color: var(--gt-on-surface, #1f1f1f);
          border: 1px solid transparent;
          border-radius: var(--gt-shape-s, 8px);
          font: 500 12px/16px var(--gt-font-plain, Arial, sans-serif);
          text-overflow: ellipsis;
          cursor: pointer;
          transition: background-color var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease),
                      border-color var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
        }
        .qc__select:hover:not(:disabled) { background-color: var(--gt-surface-container-high, #e9eef6); }
        .qc__select:focus-visible {
          outline: none;
          border-color: var(--gt-primary, #0b57d0);
          box-shadow: inset 0 0 0 1px var(--gt-primary, #0b57d0);
        }
        .qc__select:disabled { opacity: .38; cursor: default; }
        .qc__select option { background: var(--gt-surface, #ffffff); color: var(--gt-on-surface, #1f1f1f); }
      </style>
      <div class="qc__row">
        <div class="qc__info">
          <label class="qc__title" for="qc-ctl">${title_}</label>
          ${desc_ ? `<div class="qc__desc" id="qc-desc">${desc_}</div>` : ''}
        </div>
        <select class="qc__select" id="qc-ctl" ${desc_ ? 'aria-describedby="qc-desc"' : ''} ${isDisabled_ ? 'disabled' : ''}>
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
