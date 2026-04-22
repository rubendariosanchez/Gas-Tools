/**
 * @fileoverview DomUtils - Utilidades de manipulación del DOM optimizadas.
 * @version 1.0.0
 * @author Rubén Sánchez (rubencho.dev@gmail.com)
 */

class DomUtils {
  
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
  static #policy = window.trustedTypes?.createPolicy("qc-security-policy", {
    createHTML: (input) => input
  });

  /**
   * Inserta HTML de forma segura cumpliendo con las políticas de seguridad (CSP).
   * @param {HTMLElement} container - El contenedor donde se insertará el HTML.
   * @param {string} htmlContent - La cadena de texto HTML a renderizar.
   */
  static setHTML(container, htmlContent) {
    if (!container) return;

    if (this.#policy) {
      container.innerHTML = this.#policy.createHTML(htmlContent);
    } else {
      // Fallback para navegadores/entornos sin Trusted Types
      container.innerHTML = htmlContent;
    }
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
}