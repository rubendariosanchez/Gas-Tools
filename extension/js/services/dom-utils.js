/**
 * @fileoverview DomUtils - Utilidades de manipulación del DOM optimizadas.
 * @version 1.0.0
 * @author Rubén Sánchez (rubencho.dev@gmail.com)
 */

class DomUtils {
  /**
   * Prefijo para clases CSS de elementos inyectados por la extensión.
   * Permite limpiar todos los elementos de un tipo usando removeByClass.
   * @type {string}
   */
  static REF_CLASS_PREFIX = 'qc-ref--';

  /**
   * Clase única para identificar elementos inyectados que deben ser limpiados
   * al deshabilitar o reinicializar el componente.
   * @type {string}
   */
  static REF_CLASS = 'qc-ref';

  static #policy = null;
  static #policyInitialized = false;
  
  /**
   * Elimina un elemento del DOM de forma segura.
   * @param {string|HTMLElement} target - ID del elemento o el nodo directamente.
   */
  static remove(target) {
    const node = (typeof target === 'string') ? document.getElementById(target) : target;
    if (node) {
      // Método moderno: más rápido y limpio que parent.removeChild()
      node.remove();
    }
  }

  /**
   * Busca el ancestro más cercano que coincida con el tag o selector.
   * @param {HTMLElement} element - Elemento de origen.
   * @param {string} selector - Nombre del tag o selector CSS.
   * @returns {HTMLElement|null}
   */
  static closest(element, selector) {
    if (!element) return null;
    // Usamos el método nativo .closest() que está altamente optimizado en el motor del navegador
    return element.closest(selector);
  }

  /**
   * Inicialización única de la política de Trusted Types para evitar 
   * advertencias de seguridad en la extensión de Chrome.
   * @private
   */
  static #getTrustedPolicy() {
    if (this.#policyInitialized) return this.#policy;
    this.#policyInitialized = true;

    if (!window.trustedTypes?.createPolicy) {
      this.#policy = null;
      return this.#policy;
    }

    try {
      this.#policy = window.trustedTypes.createPolicy("qc-security-policy", {
        createHTML: (input) => input
      });
    } catch (err) {
      // Si la página restringe el nombre de política, seguimos sin Trusted Types policy.
      this.#policy = null;
      console.warn('[DomUtils] Trusted Types policy blocked by host CSP:', err);
    }

    return this.#policy;
  }

  /**
   * Inserta HTML de forma segura cumpliendo con las políticas de seguridad (CSP).
   * @param {HTMLElement} container - El contenedor donde se insertará el HTML.
   * @param {string} htmlContent - La cadena de texto HTML a renderizar.
   */
  static setHTML(container, htmlContent) {
    if (!container) return;
    const html = String(htmlContent ?? '');
    const policy = this.#getTrustedPolicy();

    if (policy) {
      try {
        container.innerHTML = policy.createHTML(html);
        return;
      } catch (err) {
        console.warn('[DomUtils] TrustedHTML assignment failed, using fragment fallback:', err);
      }
    }

    // Fallback sin innerHTML para entornos con Trusted Types estricto.
    const range = document.createRange();
    range.selectNode(container);
    const fragment = range.createContextualFragment(html);
    container.replaceChildren(fragment);
  }

  /**
   * Delegación de eventos para optimizar el rendimiento en listas largas.
   * @param {HTMLElement} parent - El contenedor que escuchará el evento.
   * @param {string} eventType - Tipo de evento (ej. 'click').
   * @param {string} selector - El hijo que debe disparar la acción.
   * @param {Function} callback - Acción a realizar.
   */
  static delegate(parent, eventType, selector, callback) {
    parent.addEventListener(eventType, (e) => {
      const target = e.target.closest(selector);
      if (target && parent.contains(target)) {
        callback.call(target, e, target);
      }
    });
  }

  /**
   * Elimina del DOM todos los elementos que tengan la clase `qc-ref` o
   * una clase que comience con `qc-ref--`.
   * Útil para limpieza en disable() sin depender de IDs individuales.
   */
  static removeRefElements() {
    document.querySelectorAll(`.${this.REF_CLASS}`).forEach(el => el.remove());
    document.querySelectorAll(`[class*="${this.REF_CLASS_PREFIX}"]`).forEach(el => el.remove());
  }

  /**
   * Lista canónica de paneles flotantes que solo deben mostrarse uno a la vez.
   * Centralizar el listado evita que cada panel olvide cerrar a un nuevo hermano.
   * @type {string[]}
   */
  static FLOATING_PANEL_TAGS = [
    'gas-chat-panel',
    'gas-current-file',
    'gas-actions-panel',
    'gas-github-panel',
  ];

  /**
   * Cierra todos los paneles flotantes registrados, salvo el indicado.
   * Cada panel debe exponer un método `close()` (todos los componentes
   * de `extension/js/components/` lo cumplen).
   *
   * @param {string} [exceptTag] - Custom element que NO debe cerrarse.
   *                                Si se omite, cierra todos los paneles.
   */
  static closeOtherFloatingPanels(exceptTag) {
    for (const tag of this.FLOATING_PANEL_TAGS) {
      if (tag === exceptTag) continue;
      document.querySelector(tag)?.close?.();
    }
  }

  /**
   * Sincroniza el atributo `theme` de un Web Component con la clase
   * canónica `gc__is-dark-mode` del `<body>`. Pensado para llamarse
   * desde `connectedCallback` para que un panel montado después de que
   * el usuario haya activado dark mode arranque ya con la paleta
   * correcta (sin parpadeo).
   *
   * @param {HTMLElement} host - Web Component (normalmente `this`).
   */
  static syncHostTheme(host) {
    const dark = document.body.classList.contains('gc__is-dark-mode');
    host.setAttribute('theme', dark ? 'dark' : 'light');
  }

  /**
   * Devuelve el bloque CSS con las design tokens compartidas por todos
   * los paneles flotantes. Los nombres siguen el prefijo `--gc-` (igual
   * que `gas-chat-panel`) y se exponen como variables CSS dentro del
   * `:host`, para que cada componente pueda referenciarlas en su
   * propio Shadow DOM.
   *
   * Uso: incluir el resultado al inicio del `<style>` interno de cada
   * componente, antes de cualquier regla propia. Los selectores
   * `:host([theme="light"])` y `:host([theme="dark"])` cubren los
   * dos modos sin requerir lógica JS adicional.
   *
   * @returns {string} CSS listo para insertarse dentro de un `<style>`.
   */
  static themeTokensCss() {
    return `
      :host {
        /* ── Backgrounds ── */
        --gc-bg:           #16181c;
        --gc-bg-raised:    #1e2027;
        --gc-bg-elevated:  #262830;
        --gc-bg-input:     #1a1c23;
        /* Superficie "suave" (gris muy claro en light, oscuro sutil en dark).
           Usada en headers de cards, hovers y zonas de estado. */
        --gc-surface-soft:       #1e2027;
        --gc-surface-soft-hover: #262830;

        /* ── Borders ── */
        --gc-border:       rgba(255,255,255,.08);
        --gc-border-focus: rgba(99,179,237,.5);

        /* ── Text ── */
        --gc-text:         #e8eaed;
        --gc-text-muted:   #8b8fa8;
        --gc-text-faint:   #4a4d5e;
        --gc-text-on-accent: #ffffff;

        /* ── Accent (azul marca) ── */
        --gc-accent:       #63b3ed;
        --gc-accent-dim:   rgba(99,179,237,.12);
        --gc-accent-glow:  rgba(99,179,237,.25);

        /* ── Semánticos: solid (texto sobre el color) y soft (fondo tenue) ── */
        --gc-green:        #68d391;
        --gc-green-strong: #2da44e;
        /* Versiones opacas en dark para evitar transparencias inconsistentes. */
        --gc-green-dim:    #1a2e23;
        --gc-green-soft:   #1f3a2c;
        --gc-green-text:   #4ade80;

        --gc-red:          #fc8181;
        --gc-red-strong:   #cf222e;
        --gc-red-dim:      #2e1d1d;
        --gc-red-soft:     #3a2424;
        --gc-red-text:     #f87171;

        --gc-amber:        #f6ad55;
        --gc-amber-soft:   #2d2417;
        --gc-amber-text:   #fbbf24;

        --gc-info:         #4493f8;
        /* En dark hacemos el soft semi-opaco aplicado sobre bg-raised:
           el resultado visible es un azul oscuro sólido y consistente. */
        --gc-info-soft:    #1d2a3a;
        --gc-info-border:  rgba(68,147,248,.30);

        /* ── User bubble (chat) ── */
        --gc-user-bg:      #2d3a52;
        --gc-user-border:  rgba(99,179,237,.2);

        /* ── Code ── */
        --gc-code-bg:      #11131a;
        --gc-code-border:  rgba(255,255,255,.06);

        /* ── Hover/overlay neutros (semi-transparente) ── */
        --gc-hover-soft:   rgba(255,255,255,.05);
        --gc-hover-strong: rgba(255,255,255,.08);

        /* ── Radii ── */
        --gc-r-sm:   6px;
        --gc-r-md:  10px;
        --gc-r-lg:  14px;
        --gc-r-xl:  18px;
        --gc-r-pill:999px;

        /* ── Shadows ── */
        --gc-shadow-panel: 0 32px 64px rgba(0,0,0,.7), 0 8px 24px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.05);
        --gc-shadow-menu:  0 16px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.07);

        /* ── Typography ── */
        --gc-font: 'DM Sans', system-ui, sans-serif;
        --gc-mono: 'DM Mono', 'Fira Code', Consolas, monospace;

        /* ── Transitions ── */
        --gc-ease: cubic-bezier(.16,1,.3,1);
      }

      :host([theme="light"]) {
        --gc-bg:           #fefefe;
        --gc-bg-raised:    #f8f9fa;
        --gc-bg-elevated:  #ffffff;
        --gc-bg-input:     #fafbfc;
        --gc-surface-soft:       #f6f8fa;
        --gc-surface-soft-hover: #eaeef2;

        --gc-border:       rgba(0,0,0,.09);
        --gc-border-focus: rgba(26,115,232,.5);

        --gc-text:         #202124;
        --gc-text-muted:   #5f6368;
        --gc-text-faint:   #9aa0a6;
        --gc-text-on-accent: #ffffff;

        --gc-accent:       #1a73e8;
        --gc-accent-dim:   rgba(26,115,232,.08);
        --gc-accent-glow:  rgba(26,115,232,.2);

        --gc-green:        #1e8e3e;
        --gc-green-strong: #2da44e;
        --gc-green-dim:    #dafbe1;
        --gc-green-soft:   rgba(45,164,78,.16);
        --gc-green-text:   #1a7f37;

        --gc-red:          #d93025;
        --gc-red-strong:   #cf222e;
        --gc-red-dim:      #ffebe9;
        --gc-red-soft:     rgba(207,34,46,.16);
        --gc-red-text:     #cf222e;

        --gc-amber:        #ea8600;
        --gc-amber-soft:   #fff8c5;
        --gc-amber-text:   #7d4e00;

        --gc-info:         #0969da;
        --gc-info-soft:    #ddf4ff;
        --gc-info-border:  rgba(9,105,218,.30);

        --gc-user-bg:      #e8f0fe;
        --gc-user-border:  rgba(26,115,232,.15);

        --gc-code-bg:      #f5f5f5;
        --gc-code-border:  rgba(0,0,0,.06);

        --gc-hover-soft:   rgba(0,0,0,.04);
        --gc-hover-strong: rgba(0,0,0,.06);

        --gc-shadow-panel: 0 32px 64px rgba(0,0,0,.25), 0 8px 24px rgba(0,0,0,.15), 0 0 0 1px rgba(0,0,0,.08);
        --gc-shadow-menu:  0 16px 40px rgba(0,0,0,.2), 0 0 0 1px rgba(0,0,0,.06);
      }
    `;
  }
}