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

  /**
   * Cuando el elemento se conecta al DOM, renderiza su contenido basado en los atributos proporcionados.
   * Esto asegura que el toggle se muestre correctamente incluso si los atributos se establecen antes de añadirlo al DOM.
   * @private
   */
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
    const isExperimental_ = this.hasAttribute('experimental');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; padding: 14px 0; border-bottom: 1px solid #222; }
        .qc__row { display: flex; justify-content: space-between; align-items: center; }
        .qc__info { flex: 1; padding-right: 16px; }
        .qc__title { color: #fff; font-size: 14px; font-weight: 500; font-family: sans-serif; display: inline-flex; align-items: center; gap: 8px; }
        .qc__desc { color: #9ca3af; font-size: 11px; margin-top: 3px; line-height: 1.4; }
        .qc__exp-badge {
          display: inline-flex; align-items: center; gap: 3px;
          padding: 1px 7px;
          font-size: 9.5px; font-weight: 600;
          letter-spacing: 0.04em; text-transform: uppercase;
          border-radius: 999px;
          background: rgba(251,188,4,0.14);
          color: #fbbc04;
          border: 1px solid rgba(251,188,4,0.35);
          font-family: sans-serif;
        }
        .qc__exp-note {
          color: #f5b343; font-size: 10.5px; margin-top: 4px;
          font-family: sans-serif; line-height: 1.45;
          font-style: italic;
        }

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
          <div class="qc__title">
            ${title_}
            ${isExperimental_ ? `<span class="qc__exp-badge" title="Experimental — may not work fully on all projects">⚗️ Experimental</span>` : ''}
          </div>
          ${desc_ ? `<div class="qc__desc">${desc_}</div>` : ''}
          ${isExperimental_ ? `<div class="qc__exp-note">Experimental feature. It may not work in 100% of cases — feedback welcome.</div>` : ''}
        </div>
        <label class="qc__switch">
          <input type="checkbox" ${isChecked_ ? 'checked' : ''}>
          <span class="qc__slider"></span>
        </label>
      </div>
    `;

    // Escuchar cambios en el checkbox para actualizar el atributo 'checked' del componente y emitir un evento personalizado
    this.shadowRoot.querySelector('input').addEventListener('change', (e_) => {
      if (e_.target.checked) {
        this.setAttribute('checked', '');
      } else {
        this.removeAttribute('checked');
      }

      // Emitimos un evento personalizado con el nuevo estado del toggle para que app.js pueda reaccionar a este cambio
      this.dispatchEvent(new CustomEvent('toggle', {
        detail: { checked: e_.target.checked },
        bubbles: true,
        composed: true
      }));
    });
  }
}
customElements.define('option-toggle', OptionToggle);