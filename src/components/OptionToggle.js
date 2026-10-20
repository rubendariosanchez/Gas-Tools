import { tr } from '../js/utils/I18n.js';
import { OPTION_BASE_CSS } from './OptionStyles.js';

/**
 * Componente de interruptor estandarizado para la extensión.
 * Atributos: checked, disabled, experimental, compact (solo el switch), title/description o data-i18n-*.
 * @fires toggle - detail: { checked }.
 */
export class OptionToggle extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() { return ['checked', 'title', 'description', 'disabled']; }

  /**
   * Sincroniza el estado interno con los atributos.
   * @param {string} name_ Atributo cambiado.
   * @param {?string} old_ Valor anterior.
   * @param {?string} new_ Valor nuevo.
   */
  attributeChangedCallback(name_, old_, new_) {
    // Re-render si cambian los textos (p. ej. tras aplicar traducciones)
    if ((name_ === 'title' || name_ === 'description') && old_ !== new_ && this.shadowRoot?.childElementCount) {
      this.render_();
      return;
    }
    const input_ = this.shadowRoot?.querySelector('input');
    if (!input_) return;
    if (name_ === 'checked') {
      input_.checked = this.hasAttribute('checked');
      input_.setAttribute('aria-checked', String(input_.checked));
    }
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
    const title_ = tr(this.dataset.i18nTitle, this.getAttribute('title') || 'Option');
    const desc_ = tr(this.dataset.i18nDescription, this.getAttribute('description') || '');
    const isChecked_ = this.hasAttribute('checked');
    const isDisabled_ = this.hasAttribute('disabled');
    const isExperimental_ = this.hasAttribute('experimental');
    const isCompact_ = this.hasAttribute('compact');

    // Nombre accesible: label visible o aria-label en modo compacto.
    const a11y_ = isCompact_
      ? `aria-label="${title_}"`
      : `aria-labelledby="qc-title"${desc_ ? ' aria-describedby="qc-desc"' : ''}`;

    this.shadowRoot.innerHTML = `
      <style>
        ${OPTION_BASE_CSS}
        :host([compact]) { padding: 0; border-bottom: none; }
        /* Switch Material 3: pista 44x24, pulgar con check al activarse */
        .qc__switch { position: relative; display: inline-block; flex-shrink: 0; width: 44px; height: 24px; }
        .qc__switch input { position: absolute; inset: -4px; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
        .qc__switch input:disabled { cursor: default; }
        .qc__slider {
          position: absolute; inset: 0; box-sizing: border-box;
          background: var(--gt-surface-container-high, #e9eef6);
          border: 2px solid var(--gt-outline, #747775);
          border-radius: var(--gt-shape-full, 9999px);
          transition: background var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease),
                      border-color var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
        }
        .qc__thumb {
          position: absolute; top: 50%; left: 4px;
          display: grid; place-items: center;
          width: 12px; height: 12px;
          border-radius: 50%;
          background: var(--gt-outline, #747775);
          transform: translateY(-50%);
          transition: transform 200ms var(--gt-motion-standard, ease),
                      width 200ms var(--gt-motion-standard, ease), height 200ms var(--gt-motion-standard, ease),
                      left 200ms var(--gt-motion-standard, ease), background 200ms var(--gt-motion-standard, ease);
        }
        .qc__thumb svg { width: 12px; height: 12px; fill: var(--gt-primary, #0b57d0); opacity: 0; transition: opacity 150ms; }
        .qc__switch:hover input:not(:disabled) + .qc__slider .qc__thumb { box-shadow: 0 0 0 8px var(--gt-state-hover, rgba(31, 31, 31, .08)); }
        input:checked + .qc__slider {
          background: var(--gt-primary, #0b57d0);
          border-color: var(--gt-primary, #0b57d0);
        }
        input:checked + .qc__slider .qc__thumb {
          left: 22px; width: 16px; height: 16px;
          background: var(--gt-on-primary, #ffffff);
        }
        input:checked + .qc__slider .qc__thumb svg { opacity: 1; }
        input:focus-visible + .qc__slider {
          outline: 2px solid var(--gt-primary, #0b57d0);
          outline-offset: 2px;
        }
        input:disabled + .qc__slider { opacity: .38; }
      </style>
      <div class="qc__row">
        ${isCompact_ ? '' : `
        <div class="qc__info">
          <label class="qc__title" id="qc-title" for="qc-ctl">
            ${title_}
            ${isExperimental_ ? `<span class="qc__exp-badge" title="${tr('experimentalTooltip', 'Experimental — may not work fully on all projects')}"><span aria-hidden="true">⚗️</span> ${tr('experimentalBadge', 'Experimental')}</span>` : ''}
          </label>
          ${desc_ ? `<div class="qc__desc" id="qc-desc" part="desc">${desc_}</div>` : ''}
        </div>`}
        <span class="qc__switch">
          <input type="checkbox" id="qc-ctl" role="switch" aria-checked="${isChecked_}" ${a11y_}
            ${isChecked_ ? 'checked' : ''} ${isDisabled_ ? 'disabled' : ''}>
          <span class="qc__slider" aria-hidden="true"><span class="qc__thumb"><svg viewBox="0 -960 960 960"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg></span></span>
        </span>
      </div>
    `;

    // Refleja el estado en el host y emite `toggle` para los módulos del popup.
    this.shadowRoot.querySelector('input').addEventListener('change', (e_) => {
      const checked_ = e_.target.checked;
      e_.target.setAttribute('aria-checked', String(checked_));
      checked_ ? this.setAttribute('checked', '') : this.removeAttribute('checked');

      this.dispatchEvent(new CustomEvent('toggle', {
        detail: { checked: checked_ },
        bubbles: true,
        composed: true
      }));
    });
  }
}
customElements.define('option-toggle', OptionToggle);
