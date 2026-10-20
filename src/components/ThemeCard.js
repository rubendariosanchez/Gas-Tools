import { tr } from '../js/utils/I18n.js';
import { escapeHtml, safeColor } from '../js/utils/Html.js';
import { icon } from '../js/utils/Icons.js';

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
    // Hoja base de GasUi (clase .gt-icon de los SVG).
    globalThis.GasUi?.adopt(this.shadowRoot);
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
    // Nombre escapado y colores validados (hex) antes de interpolarlos.
    const name_ = escapeHtml(this.getAttribute('name') || 'Theme');
    const colors_ = (this.getAttribute('colors') || '').split(',').map((c) => safeColor(c));
    const selected_ = this.hasAttribute('selected');
    const isProtected_ = this.hasAttribute('protected');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }

        .qc__card {
          position: relative;
          padding: var(--gt-space-3, 12px);
          border: 2px solid transparent;
          border-radius: var(--gt-shape-l, 16px);
          background: var(--gt-surface, #ffffff);
          box-shadow: 0 1px 2px rgba(0, 0, 0, .05), 0 1px 3px 1px rgba(0, 0, 0, .03);
          color: var(--gt-on-surface, #1f1f1f);
          font-family: var(--gt-font-plain, Arial, sans-serif);
          cursor: pointer;
          user-select: none;
          overflow: hidden;
          transition: background var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease),
                      box-shadow var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease),
                      transform var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
        }
        .qc__card:hover { box-shadow: var(--gt-elevation-2, 0 2px 6px rgba(0, 0, 0, .15)); transform: translateY(-1px); }
        .qc__card:focus-visible { outline: 2px solid var(--gt-primary, #0b57d0); outline-offset: 2px; }

        .qc__card.selected {
          border-color: var(--gt-primary, #0b57d0);
          background: color-mix(in srgb, var(--gt-primary, #0b57d0) 6%, var(--gt-surface, #ffffff));
        }

        /* Menú de acciones flotante */
        .qc__actions {
          position: absolute; top: 6px; right: 6px; z-index: 10;
          display: flex; gap: 2px;
          opacity: 0;
          transition: opacity var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
        }
        .qc__card:hover .qc__actions,
        .qc__card:focus-within .qc__actions { opacity: 1; }
        .qc__card:hover .qc__check-mark { opacity: 0; }

        .qc__action-btn {
          display: flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; padding: 0; border: none; cursor: pointer;
          border-radius: var(--gt-shape-full, 9999px);
          background: var(--gt-surface, #ffffff);
          color: var(--gt-on-surface-variant, #444746);
          box-shadow: var(--gt-elevation-1, 0 1px 3px rgba(0, 0, 0, .2));
        }
        .qc__action-btn:hover { color: var(--gt-primary, #0b57d0); }
        .qc__action-btn.delete:hover { color: var(--gt-error, #b3261e); }
        .qc__action-btn:focus-visible { outline: 2px solid var(--gt-primary, #0b57d0); }

        .qc__header { display: flex; flex-direction: column; margin-bottom: var(--gt-space-2, 8px); }
        .qc__title {
          max-width: 120px;
          font: var(--gt-type-title-s, 500 14px/20px Arial, sans-serif);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .qc__badge { font: var(--gt-type-label-s, 500 11px/16px Arial, sans-serif); opacity: .75; }

        .qc__palette { display: flex; margin-bottom: var(--gt-space-2, 8px); }
        .qc__dot {
          width: 16px; height: 16px; border-radius: 50%;
          box-shadow: 0 0 0 2px var(--gt-surface, #ffffff);
        }
        .qc__dot + .qc__dot { margin-left: -4px; }

        /* Vista previa sobre el fondo del propio tema */
        .qc__preview {
          padding: 8px 10px;
          border-radius: var(--gt-shape-s, 8px);
          background: ${colors_[0] || 'var(--gt-code-surface, #1e1e1e)'};
          font: 400 10px/16px var(--gt-font-mono, monospace);
          color: ${colors_[2] || 'var(--gt-code-on-surface, #d4d4d4)'};
        }
        .qc__kw { color: ${colors_[1] || 'var(--gt-code-on-surface, #d4d4d4)'}; }
        .qc__st { color: ${colors_[3] || 'var(--gt-code-on-surface, #d4d4d4)'}; }

        .qc__check-mark {
          position: absolute; right: 8px; top: 10px;
          color: var(--gt-primary, #0b57d0);
          display: ${selected_ ? 'block' : 'none'};
        }
      </style>

      <div class="qc__card ${selected_ ? 'selected' : ''}" role="button" tabindex="0" aria-pressed="${selected_}" aria-label="${name_}">
        <div class="qc__actions">
          <button type="button" class="qc__action-btn duplicate" title="${tr('themeDuplicate', 'Duplicate theme')}" aria-label="${tr('themeDuplicate', 'Duplicate theme')}">
            ${icon('copy', 16)}
          </button>
          ${!isProtected_ ? `
            <button type="button" class="qc__action-btn edit" title="${tr('themeEdit', 'Edit theme')}" aria-label="${tr('themeEdit', 'Edit theme')}">
              ${icon('pencil', 16)}
            </button>
            <button type="button" class="qc__action-btn delete" title="${tr('themeDelete', 'Delete theme')}" aria-label="${tr('themeDelete', 'Delete theme')}">
              ${icon('trash', 16)}
            </button>
          ` : ''}
        </div>

        <div class="qc__header">
          <span class="qc__title">${name_}</span>
          <span class="qc__badge">${isProtected_ ? tr('badgeSystem', 'system') : tr('badgeCustom', 'custom')}</span>
        </div>

        <div class="qc__palette" aria-hidden="true">
          ${colors_.filter(Boolean).map(c => `<div class="qc__dot" style="background:${c}"></div>`).join('')}
        </div>

        <div class="qc__preview" aria-hidden="true">
          <div><span class="qc__kw">class</span> <span class="qc__st">Theme</span> {}</div>
        </div>

        <span class="qc__check-mark" aria-hidden="true">${icon('checkCircleFill', 20)}</span>
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
      // Si el clic fue en un botón de acción, no hacemos nada aquí
      if (e.target.closest('.qc__action-btn')) return;

      // Esto activará el attributeChangedCallback y re-renderizará la tarjeta
      this.setAttribute('selected', '');

      // Creamos evento personalizado para notificar la selección del tema, con su value y name como detalle
      this.dispatchEvent(new CustomEvent('select-theme', {
        detail: { value: this.getAttribute('value'), name: this.getAttribute('name') },
        bubbles: true, composed: true
      }));
    };

    card.onkeydown = (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      card.click();
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