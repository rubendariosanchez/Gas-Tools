/**
 * Librería con funciones genericas para su uso del complemento
 * @autor Equipo de Desarrollo Sinova S.A.S.
 */
var apiRub = {

  /**
   * Permite eliminar un elemento del DOM
   */
  removeElem: function(id) {

    // referenciamos el elemento
    const elem = document.getElementById(id);

    if (elem) {

      // referenciamos el padre y eliminamos el hijo seleccionado
      const parent = elem.parentNode;
      parent.removeChild(elem);
    }
  },

  /**
   * Obtiene el elemento por la clase
   */
  getClosestTag: function(el, tag) {
    // this is necessary since nodeName is always in upper case
    tag = tag.toUpperCase();

    do {

      if (el.nodeName === tag) {
        // tag name is found! let's return it. :)
        return el;
      }
    } while (el = el.parentNode);

    // not found :(
    return null;
  }

};
