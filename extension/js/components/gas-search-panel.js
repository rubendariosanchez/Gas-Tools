class GasSearchPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.setupListeners();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: none;
          position: fixed;
          top: 60px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10000;
          width: 500px;
          background: #ffffff;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15);
          font-family: 'Roboto', Arial, sans-serif;
          overflow: hidden;
          animation: slideDown 0.2s ease-out;
        }

        @keyframes slideDown {
          from { transform: translate(-50%, -10px); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }

        .container { display: flex; flex-direction: column; }

        .search-header {
          display: flex;
          align-items: center;
          padding: 8px 16px;
          border-bottom: 1px solid #e0e0e0;
        }

        .search-icon {
          color: #5f6368;
          margin-right: 12px;
          font-size: 20px;
        }

        input {
          flex: 1;
          border: none;
          outline: none;
          font-size: 16px;
          color: #3c4043;
          height: 40px;
          background: transparent;
        }

        .results {
          max-height: 300px;
          overflow-y: auto;
          padding: 8px 0;
          background: #f8f9fa;
        }

        .no-results {
          padding: 16px;
          text-align: center;
          color: #70757a;
          font-size: 14px;
        }

        /* Estilo para simular el tema oscuro si el IDE lo usa */
        :host([theme="dark"]) {
          background: #202124;
          color: #e8eaed;
          border: 1px solid #3c4043;
        }
        :host([theme="dark"]) input { color: #e8eaed; }
        :host([theme="dark"]) .results { background: #202124; }
      </style>

      <div class="container">
        <div class="search-header">
          <span class="search-icon">🔍</span>
          <input type="text" placeholder="Search files or symbols..." id="searchInput" autocomplete="off">
        </div>
        <div class="results" id="resultsContainer">
          <div class="no-results">Type something to search...</div>
        </div>
      </div>
    `;
  }

  setupListeners() {
    const input = this.shadowRoot.getElementById('searchInput');
    
    // Cerrar al presionar Escape
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.style.display = 'none';
    });

    // Evitar que los clics dentro del panel lo cierren (si implementas lógica de cierre al hacer clic fuera)
    this.addEventListener('click', (e) => e.stopPropagation());

    input.addEventListener('input', (e) => {
      this.dispatchEvent(new CustomEvent('search-input', {
        detail: { value: e.target.value },
        bubbles: true,
        composed: true
      }));
    });
  }

  open() {
    this.style.display = 'block';
    setTimeout(() => this.shadowRoot.getElementById('searchInput').focus(), 50);
  }
}

customElements.define('gas-search-panel', GasSearchPanel);