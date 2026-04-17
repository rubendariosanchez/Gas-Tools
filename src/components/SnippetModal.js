export class SnippetModal extends HTMLElement {

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  /**
   * Se ejecuta cuando el componente entra al DOM
   */
  connectedCallback() {
    this.render_();
    this.initEvents_();
  }

  /**
   * Renderiza la estructura del modal
   */
  render_() {

    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Fira+Code:wght@400&display=swap">

      <style>
        * {
          box-sizing: border-box;
        }
        
        :host {
          position: fixed;
          inset: 0;
          display: none;
          z-index: 1000;
        }

        :host(.qc__active) {
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* Overlay */
        .qc__overlay {
          position: absolute;
          inset: 0;
          background: rgba(0,0,0,0.7);
        }

        /* Modal */
        .qc__modal {
          position: relative;
          background: var(--qc__bg-surface, #252526);
          width: 92%;
          max-width: 360px;
          border-radius: 12px;
          border: 1px solid #333;
          overflow: hidden;
          box-shadow: 0 20px 40px rgba(0,0,0,0.6);
          font-family: var(--qc__font-sans, sans-serif);
          color: #fff;
          z-index: 1;
        }

        /* Header */
        .qc__header {
          padding: 16px;
          background: #1e1e1e;
          border-bottom: 1px solid #333;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .qc__title {
          font-size: 14px;
          font-weight: 600;
        }

        .qc__subtitle {
          font-size: 11px;
          color: #9ca3af;
        }

        .qc__close {
          background: transparent;
          border: none;
          color: #9ca3af;
          font-size: 18px;
          cursor: pointer;
        }

        /* Body */
        .qc__body {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .qc__form-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .qc__form-row {
          display: flex;
          gap: 10px;
        }

        .qc__form-row > .qc__form-group {
          flex: 1;
        }

        label {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          color: var(--qc__primary, #3b82f6);
        }

        input, select, textarea {
          width: 100%;
          background: #121212;
          border: 1px solid #333;
          border-radius: 6px;
          color: #fff;
          padding: 10px;
          font-size: 13px;
          outline: none;
        }

        textarea {
          font-family: var(--qc__font-mono, monospace);
          height: 140px;
          resize: none;
        }

        input:focus, textarea:focus, select:focus {
          border-color: var(--qc__primary, #3b82f6);
        }

        /* Footer */
        .qc__footer {
          padding: 12px 16px;
          background: #1e1e1e;
          border-top: 1px solid #333;
          display: flex;
          gap: 10px;
        }

        .qc__btn {
          flex: 1;
          padding: 10px;
          border-radius: 6px;
          border: none;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
        }

        .qc__btn--secondary {
          background: #2d2d2d;
          color: #fff;
        }

        .qc__btn--primary {
          background: var(--qc__primary, #3b82f6);
          color: #fff;
        }

        .qc__editor {
          border: 1px solid #2a2a2a;
          border-radius: 8px;
          overflow: hidden;
          background: #1e1e1e;
        }

        /* Header tipo VSCode */
        .qc__editor-header {
          background: #252526;
          padding: 6px 10px;
          font-size: 11px;
          color: #9ca3af;
          border-bottom: 1px solid #2a2a2a;
        }

        .qc__file-name {
          font-family: var(--qc__font-mono);
        }

        /* Body */
        .qc__editor-body {
          display: flex;
          height: 160px;
        }

        /* Números de línea */
        .qc__line-numbers {
          width: 35px;
          background: #1a1a1a;
          color: #6b7280;
          font-size: 12px;
          padding: 10px 5px;
          text-align: right;
          user-select: none;
          font-family: var(--qc__font-mono);
          line-height: 1.5;
        }

        /* Textarea */
        .qc__editor textarea {
          flex: 1;
          border: none;
          outline: none;
          resize: none;
          padding: 10px;
          background: transparent;
          color: #d4d4d4;
          font-family: var(--qc__font-mono);
          font-size: 12px;
          line-height: 1.5;
        }
      </style>

      <div class="qc__overlay"></div>

      <div class="qc__modal">
        
        <div class="qc__header">
          <div>
            <div class="qc__title">Snippet</div>
            <div class="qc__subtitle">Create or edit snippet</div>
          </div>
          <button class="qc__close">&times;</button>
        </div>

        <div class="qc__body">

          <div class="qc__form-group">
            <label>Name</label>
            <input type="text" id="name" autocomplete="off">
          </div>

          <div class="qc__form-row">

            <div class="qc__form-group">
              <label>Prefix</label>
              <input type="text" id="prefix" autocomplete="off">
            </div>

            <div class="qc__form-group">
              <label>Language</label>
              <select id="lang">
                <option>JavaScript</option>
                <option>Google Apps Script</option>
              </select>
            </div>

          </div>

          <div class="qc__form-group">
            <label>Code</label>

            <div class="qc__editor">

              <!-- Header tipo VSCode -->
              <div class="qc__editor-header">
                <span class="qc__file-name">snippet.js</span>
              </div>

              <!-- Editor -->
              <div class="qc__editor-body">
                <div class="qc__line-numbers" id="lines"></div>
                <textarea id="code" spellcheck="false"></textarea>
              </div>

            </div>
          </div>

        </div>

        <div class="qc__footer">
          <button class="qc__btn qc__btn--secondary" id="cancel">Cancel</button>
          <button class="qc__btn qc__btn--primary" id="save">Save</button>
        </div>

      </div>
    `;
  }

  /**
   * Inicializa los eventos del componente
   */
  initEvents_() {

    // Cerrar modal
    this.shadowRoot.querySelector('.qc__close').onclick = () => this.close_();
    this.shadowRoot.querySelector('#cancel').onclick = () => this.close_();
    this.shadowRoot.querySelector('.qc__overlay').onclick = () => this.close_();

    // Guardar
    this.shadowRoot.querySelector('#save').onclick = () => this.handleSave_();
    const textarea_ = this.shadowRoot.getElementById('code');
    const lines_ = this.shadowRoot.getElementById('lines');

    /**
     * Actualiza numeración de líneas
     */
    this.updateLines_ = () => {
      const textarea_ = this.shadowRoot.getElementById('code');
      const lines_ = this.shadowRoot.getElementById('lines');

      const count_ = textarea_.value.split('\n').length;
      lines_.innerHTML = Array.from({ length: count_ }, (_, i) => i + 1).join('<br>');
    };

    // Eventos
    textarea_.addEventListener('input', () => this.updateLines_());
    textarea_.addEventListener('scroll', () => {
      lines_.scrollTop = textarea_.scrollTop;
    });

    // Inicial
    this.updateLines_();
  }
  

  /**
   * Abre el modal con datos opcionales
   * @param {Object|null} snip
   */
  open_(snip = null) {

    this.classList.add('qc__active');

    this.shadowRoot.getElementById('name').value = snip?.title || '';
    this.shadowRoot.getElementById('prefix').value = snip?.prefix || '';
    this.shadowRoot.getElementById('lang').value = snip?.lang || 'JavaScript';
    this.shadowRoot.getElementById('code').value = snip?.code || '';
    this._editingId = snip?.id || null;

    // recalcular las líneas para el código cargado
    this.updateLines_();
  }

  /**
   * Cierra el modal
   */
  close_() {
    this.classList.remove('qc__active');
  }

  /**
   * Maneja el evento de guardado
   */
  handleSave_() {
    const name_ = this.shadowRoot.getElementById('name').value.trim();
    const prefix_ = this.shadowRoot.getElementById('prefix').value.trim();
    const lang_ = this.shadowRoot.getElementById('lang').value;
    const code_ = this.shadowRoot.getElementById('code').value.trim();

    // Validaciones
    if (!name_ || !prefix_ || !lang_ || !code_) {
      this.dispatchEvent(new CustomEvent('form-error', {
        detail: { message: 'All fields are required' },
        bubbles: true,
        composed: true
      }));
      return;
    }

    if (prefix_.includes(' ')) {
      this.dispatchEvent(new CustomEvent('form-error', {
        detail: { message: 'Prefix cannot contain spaces' },
        bubbles: true,
        composed: true
      }));
      return;
    }

    // Datoa a guardar (nuevo o editado)
    const data_ = {
      id: this._editingId || Date.now().toString(),
      title: name_,
      prefix: prefix_,
      lang: lang_,
      code: code_
    };

    // Debug útil (opcional)
    console.log('Saving snippet:', data_);

    // Creamos el evento respectivo para que app.js lo escuche y maneje el guardado
    this.dispatchEvent(new CustomEvent('save-snippet', {
      detail: data_,
      bubbles: true,
      composed: true
    }));

    // Agregamos el mensaje de exito
    this.dispatchEvent(new CustomEvent('form-success', {
      detail: { message: 'Snippet saved successfully' },
      bubbles: true,
      composed: true
    }));

    this.close_();
  }
}

customElements.define('snippet-modal', SnippetModal);