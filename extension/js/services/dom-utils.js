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
}