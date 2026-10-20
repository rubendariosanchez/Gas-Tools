import { tr } from '../js/utils/I18n.js';
import { OPTION_BASE_CSS } from './OptionStyles.js';

/**
 * Selector de color estandarizado. Atributos: value, disabled, compact (ficha vertical), title/description o data-i18n-*.
 * @fires color-change - detail: { value }.
 */
export class OptionColor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() { return ['value', 'title', 'description', 'disabled']; }

  attributeChangedCallback(name_, old_, new_) {
    // Re-render si cambian los textos (p. ej. tras aplicar traducciones)
    if ((name_ === 'title' || name_ === 'description') && old_ !== new_ && this.shadowRoot?.childElementCount) {
      this.render_();
      return;
    }
    const input_ = this.shadowRoot?.querySelector('input');
    if (!input_) return;
    if (name_ === 'value') input_.value = new_;
    if (name_ === 'disabled') input_.disabled = this.hasAttribute('disabled');
  }

  connectedCallback() {
    this.render_();
  }

  /**
   * Renderiza el contenido del componente.
   * @private
   */
  render_() {
    const title_ = tr(this.dataset.i18nTitle, this.getAttribute('title') || 'Color');
    const desc_ = tr(this.dataset.i18nDescription, this.getAttribute('description') || '');
    const value_ = this.getAttribute('value') || '#5f6368';
    const isDisabled_ = this.hasAttribute('disabled');

    this.shadowRoot.innerHTML = `
      <style>
        ${OPTION_BASE_CSS}
        /* Compacto: ficha centrada (muestra circular + etiqueta) */
        :host([compact]) { padding: var(--gt-space-2, 8px) 0; border-bottom: none; }
        :host([compact]) .qc__row { flex-direction: column-reverse; align-items: center; gap: 6px; min-height: 0; }
        :host([compact]) .qc__info { text-align: center; }
        :host([compact]) .qc__title {
          justify-content: center;
          font: var(--gt-type-label-s, 500 11px/16px Arial, sans-serif);
          color: var(--gt-on-surface-variant, #444746);
        }
        :host([compact]) .qc__desc { display: none; }
        .qc__color-wrapper {
          position: relative; flex-shrink: 0;
          width: 32px; height: 32px;
          border-radius: 50%;
          overflow: hidden;
          box-shadow: 0 0 0 2px var(--gt-surface, #ffffff), 0 0 0 3px var(--gt-outline-variant, #c4c7c5);
          transition: transform var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease),
                      box-shadow var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
        }
        :host(:not([disabled])) .qc__color-wrapper:hover {
          transform: scale(1.06);
          box-shadow: 0 0 0 2px var(--gt-surface, #ffffff), 0 0 0 3px var(--gt-outline, #747775), var(--gt-elevation-1, 0 1px 3px rgba(0, 0, 0, .2));
        }
        :host([disabled]) .qc__color-wrapper { opacity: .38; }
        .qc__color-wrapper:focus-within {
          box-shadow: 0 0 0 2px var(--gt-surface, #ffffff), 0 0 0 4px var(--gt-primary, #0b57d0);
        }
        input[type="color"] {
          position: absolute; top: -8px; left: -8px;
          width: 48px; height: 48px;
          border: none; padding: 0; background: none;
          cursor: pointer;
        }
        input[type="color"]:disabled { cursor: default; }
      </style>
      <div class="qc__row">
        <div class="qc__info">
          <label class="qc__title" for="qc-ctl">${title_}</label>
          ${desc_ ? `<div class="qc__desc" id="qc-desc">${desc_}</div>` : ''}
        </div>
        <div class="qc__color-wrapper">
          <input type="color" id="qc-ctl" value="${value_}" ${desc_ ? 'aria-describedby="qc-desc"' : ''} ${isDisabled_ ? 'disabled' : ''}>
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
