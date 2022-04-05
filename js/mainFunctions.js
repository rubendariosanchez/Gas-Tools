"use strict";
// Google Apps Script se basa del proyecto "Monaco Editor" : https://bitwiser.in/monaco-themes/ - https://github.com/JeanRemiDelteil
// Proyecto que nos puede ayudar - https://github.com/leonhartX/gas-github/blob/master/src
// Información de funciones adicionales: https://www.programmersought.com/article/9092859547/
// iniciamos el aplicativo, después de agregar el contenido HTML
// Agregamos los elementos en el editor
initPageContent();

/**
 * Permite inicializar el contenido de la pagina
 */
function initPageContent(evt) {

  // establecemos un intervalos con el objetivo de verificar cuando el editor este cargado por completo
  var editorStateInterval = setInterval(checkLoadPage, 0);

  /**
   * Permite chequear si la pagina fue cargada con éxito, antes de aplicar alguna cambio
   */
  function checkLoadPage() {

    // Eliminamos ciclo creado
    clearInterval(editorStateInterval);
    
    // realizamos la consulta de los elementos a crear en al interfaz
    Promise.all([
        fetch(chrome.runtime.getURL('html/optionToogle.html')),
        fetch(chrome.runtime.getURL('html/themeList.html')),
        fetch(chrome.runtime.getURL('css/gasToolsStyle.css')),
        fetch(chrome.runtime.getURL('html/optionWrapLine.html')),
      ]).then(async([dataOne, dataTwo, dataStyle, dataWrapLine]) => {
        
        // retornamos los datos
        return {
          optionToogle: await dataOne.text(),
          optionTheme: await dataTwo.text(),
          styles: await dataStyle.text(),
          //modal: await dataModal.text(),
          wrapLine: await dataWrapLine.text()
        };
      }).then((response) => {
        
        // Agregamos el css para mostrar la opción de búsqueda
        createElementInDom("style", document.head, response.styles);

        // removemos la propiedad que no vamos a usar
        delete response.styles;

        // Agregamos el css para mostrar los detalles del error
        //createElementInDom("div", document.body, response.modal);

        // removemos la propiedad que no vamos a usar
        //delete response.modal;

        // Agregamos el script en la página
        addFileInPage("js/library.js", "script");
        addFileInPage("js/gasTools.js", "script");
        addFileInPage("js/popover.js", "script");

        // agregamos la url de la carpeta de themas
        response.themeUrl = chrome.runtime.getURL('themes');

        // referenciamos la instanci de la clase de chrome storage
        var instanceChrome = chrome.storage.sync;

        // Elegimos el elemento donde se va a crear un observador  para identificar si se realiza alguna modificación
        // se usa un API de Javascript: https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver
        var targetNode = document.querySelector("#yDmH0d");

        // Se deine los parametros de configuración del observador: https://developer.mozilla.org/en-US/docs/Web/API/MutationObserverInit
        var configObserver = { attributes: true, false: true, subtree: true };

        // Crear una instancia de observador vinculada a la función de devolución de llamada
        var observerDom = new MutationObserver(function(mutationsList) {

          // recorremos cada uno de las mutaciónes o cambios existentes
          for (var i = 0; i < mutationsList.length; i++) {

            // Valdiamos si el cambio fuen el la lista de hijos
            if (mutationsList[i].attributeName === 'class' && mutationsList[i].target.classList.contains("monaco-editor")) {

              // se valida que no exista la instancia en el elementos
              if (!mutationsList[i].target.getAttribute("data-gasreference")) {

                // referenciamos el elemento del editor
                var targetEditor = mutationsList[i].target;

                // obtenemos un valor consecutivo
                var referenceId = uniqueID();

                // agregamos la nueva propiedad del element
                targetEditor.setAttribute("data-gasreference", referenceId);
                response.referenceId = referenceId;

                // inicializamos la clase con las nuevas funciones del editor
                instanceChrome.get(['gasToolsNewProperties'], function(item) {

                  // definimos el tema respectivo
                  response.currTheme = "vs";

                  // validamos si existe la propiedad y existe clase
                  if (item && item.gasToolsNewProperties && item.gasToolsNewProperties.themeName) {

                    // actualizamos el tema de acuerdo a lo almacenado por el usuario
                    response.currTheme = item.gasToolsNewProperties.themeName;
                  }

                  /* Example: Send data from the page to your Chrome extension */
                  document.dispatchEvent(new CustomEvent('GAS_TranferData', {
                    detail: JSON.stringify(response)
                  }));
                });
              }
            }
          }
        });

        // Comience a observar el nodo objetivo para las mutaciones configuradas
        observerDom.observe(targetNode, configObserver);
      }).catch((err) => {
        console.error(err);
      });
  }
}

/**
 * Permite crear un elemento y agregar un contenido
 */
function createElementInDom(tag, reference, content) {

  // creamos el elemento
  var elem = document.createElement(tag);

  // agregamos el contenido
  elem.innerHTML = content;

  // agregamos el contenido
  reference.appendChild(elem);
}

/**
 * Permite generar ID unico
 */
function uniqueID() {
  function chr4() {
    return Math.random().toString(16).slice(-4);
  }
  return chr4() + chr4() +
    '-' + chr4() +
    '-' + chr4() +
    '-' + chr4() +
    '-' + chr4() + chr4() + chr4();
}

/**
 * Permite agregar un archivo js en la pagina
 */
function addFileInPage(fileName, tag) {

  // Creamos un elemento de tipo script
  var scriptElement = document.createElement(tag);

  // Agregar el archivo y no olvidar agregarlo en la sesión web_accessible_resources en el manifest.json
  scriptElement.src = chrome.runtime.getURL(fileName);

  // Agregamos el archivo en encabezado de la pagina y si no lo encuentra lo agrega al inicio del DOM
  (document.head || document.documentElement).appendChild(scriptElement);

  // Validamos para que cuando se cargue el script se elimine el elemento creado temporalmente
  scriptElement.onload = function() {

    // Eliminamos el elemento
    this.remove();
  };
}

/**
 * Creamos oyente para almacenar los datos en la base de datos
 */
document.addEventListener('GAS_SavingThemeData', function(e) {
  
  // Guardamos la clase seleccionada
  chrome.storage.sync.set({
    'gasToolsNewProperties': {
      'themeName': (e.detail || "vs")
    }
  });
});
