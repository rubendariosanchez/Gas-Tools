/**
 * Creamos oyente para referenciar la instancia inicial
 */
document.addEventListener('GAS_TranferData', function(e) {

  // obtenemso la respuesta
  var response = JSON.parse(e.detail);

  // obtenemos los datos del complemento
  new GasToolsIde(response).init();
});


/** - https://codemirror.net/2/demo/complete.html
 *  - https://shields.io/
 * Creamos la clase de funciones personalizadas del editor, la trabajamos como prototipo para que funcione en todos las versiones de chrome
 */
function GasToolsIde(options) {
  
  // referenciamos el editor de Google Apps Script
  this.editor = window.jsWireMonacoEditor;
  this.element = document.querySelector("[data-gasreference='" + options.referenceId + "']"); //document.querySelector(".monaco-editor.no-user-select");
  this.container = apiRub.getClosestTag(this.element, "c-wiz");
  this.element.gastools = this;

  // referenicamos el html
  this.options = options;
  this.loadedThemes = [];

  // establecemos que el this de las siguientes funciones es el this de la clase
  this.wrapLineAction = this.wrapLineAction.bind(this);  
  this.toogleMenuFiles = this.toogleMenuFiles.bind(this);
  this.createOptionToogle = this.createOptionToogle.bind(this);
  this.createOptionWrapLine = this.createOptionWrapLine.bind(this);

  this.changeTheme = this.changeTheme.bind(this);
 
  // se cambia el nombre del archivo activo
  var domFileName = document.querySelector("#ctnCurrentFileName");
  
  // se valida que ya exista
  if(domFileName){
    domFileName.innerHTML = escapeHTMLPolicy.createHTML(this.getCurrFileName());
  }
}

/**
 * Permite inicializar el campo de mostrar u ocultar lista de archivos
 */
 GasToolsIde.prototype.createOptionWrapLine = function() {
  
  // referenciamos la intancia de la clase de
  var _this = this;

  // agregamos la opción en el menu de la izquierda
  var contentMenu = _this.container.querySelector(".td5WLe");

  // se valida si ya existe el boton para no agregarlo
  if (contentMenu.querySelector("#btnRubToogleWrapLine")) return false;

  // removemos los valores anteriores
  apiRub.removeElem("btnRubToogleWrapLine");

  // creamos la opción
  var option = document.createElement('div');
  option.className = "kcW8jf";
  option.id = "btnRubToogleWrapLine";

  // Agregamos el contenido Html
  option.innerHTML = escapeHTMLPolicy.createHTML(_this.options.wrapLine);

  // agregamos la opción en el menu de la izquierda
  contentMenu.appendChild(option);

  // agregamos el evento al boton del
  option.addEventListener("click", function() {
    _this.wrapLineAction(this);
  });
}

/**
 * mostrar u ocultar un panel
 */
GasToolsIde.prototype.wrapLineAction = function(currButton) {
  
  // obtenemos el valor de linea de código
  var valueWrapLine = jsWireMonacoEditor.getOption(116);

  // se referncia el icono
  var iconDom = currButton.querySelector("i.google-material-icons");

  // se valida si es visible el menu
  if (valueWrapLine && valueWrapLine == "off") {

    // extendemos la linea de código
    jsWireMonacoEditor.updateOptions({ wordWrap: "on" });

    // agregamos el icono de mostrar
    iconDom.innerHTML = escapeHTMLPolicy.createHTML("wrap_text");
  } else {

    // No extendemos la linea de código
    jsWireMonacoEditor.updateOptions({ wordWrap: "off" });

    // agregamos el icono de ocultar
    iconDom.innerHTML = escapeHTMLPolicy.createHTML("subject");
  }
}

/**
 * Permite nsertar el HTMl en el DOM 
**/
escapeHTMLPolicy = trustedTypes.createPolicy("forceInner", {
  createHTML: (to_escape) => to_escape
})

/**
 * Método para inicializar la clase de herramientas
 */
GasToolsIde.prototype.init = function() {

  // se inicializa los elementos del módulos
  this.createOptionToogle();

  // Se crear la opción para el ajuste de linea
  this.createOptionWrapLine();

  // Se crea opción de lista de temas
  this.createThemeList();

  // Consultamos las propiedades de la cuenta de usuario sobre el tema seleccionado
  this.setTheme(this.options.currTheme, false);

  // Se habilita la opción de busqueda
  this.addEventButtonSearch();
}

/**
 * Permite obtener la lista de archivos ordenados
 */
GasToolsIde.prototype.getCurrFileObject = function() {

  // variable para alamacenar los archivo en orden especifico
  var fileObject = {
    list: {},
    models: {}
  };

  // variable que referencia los nombres de los archivos
  let contentFiles = document.querySelector("ul.StrnGf-VfPpkd-rymPhb.StrnGf-VfPpkd-rymPhb-OWXEXe-EzIYc.Fcw6db.GFlqGb");

  // lista de archivos
  let files = contentFiles.querySelectorAll("li"),
    currFile, pos, isManifest = false, positionIndex;

  // Obtenemos la lista de modelos
  const models = monaco.editor.getModels();

  // recorremos cada uno de los items
  for (var i = 0; i < files.length; i++) {

    // referenciamos el archivo actual
    currFile = files[i].querySelector(".dxw0vf");
    positionIndex = files[i].getAttribute("data-index");
    
    // se valida que exista la posición
    if(positionIndex && models[positionIndex]){
      
      // agregamos la propiedad junto al nombre del archivo
      fileObject.list[positionIndex] = currFile.innerText || "";
      fileObject.models[models[positionIndex].uri.path] = currFile.innerText || "";
    }
  }
  
  
  // retornamos la lista de archivos
  return fileObject;
}

/**
 * Permite validar si el tema no es el actual
 */
GasToolsIde.prototype.addEventButtonSearch = function() {

  // Se referencia el boton de busquedas
  var button = this.container.querySelector("#rsBtnSearchGas");

  // se valida que exista
  if (button) {

    // Agregamamos el evento al elemento
    new PopoverGasIde(button, this.editor, this.element, this.getCurrFileObject());
  }

}

/**
 * Permite validar si el tema no es el actual
 */
GasToolsIde.prototype.notCurrTheme = function(theme) {
  
  // se obtiene el tema actual
  var editorTheme = this.editor._themeService._theme;
  
  // validamos si existe la propiedad "editorTheme" y 
  if (editorTheme.themeName && editorTheme.themeName != theme) {
    return true;
  }
  return false;
}

/**
 * Permite inicializar el campo de mostrar u ocultar lista de archivos
 */
GasToolsIde.prototype.createThemeList = function() {

  // referenciamos la intancia de la clase de
  var _this = this;

  // Elemento base para ingresar el campo de temas de
  var elementBase = _this.container.querySelector(".INSTk");

  // agregamos la opción en el menu de la izquierda
  var parentOption = elementBase.parentNode;

  // se valida si ya existe la lista ya existe
  if (parentOption.querySelector("#sltRubThemeList")) return false;

  // removemos los valores anteriores
  apiRub.removeElem("sltRubThemeList");
  apiRub.removeElem("ctnCurrentFileName");

  // creamos la opción
  var option = document.createElement('div');
  option.className = "yggLIc";
  option.id = "sltRubThemeList";

  // Agregamos el contenido Html
  option.innerHTML = escapeHTMLPolicy.createHTML(_this.options.optionTheme);

  // agregamos la opción en el menu de la izquierda
  parentOption.insertBefore(option, elementBase);

  // agregamos la lista de items
  _this.addThemeList(option);

  // asignamos el evento 
  option.querySelector(".droplist__themes").addEventListener("click", function() {

    _this.changeTheme(this, option);
  });

  // creamos la opción para colorcar el nombre del archivo
  var optionFileName = document.createElement('div');
  optionFileName.className = "yggLIc rs__current-file";
  optionFileName.id = "ctnCurrentFileName";
  optionFileName.innerHTML = escapeHTMLPolicy.createHTML(_this.getCurrFileName());

  // agregamos la opción en el menu de la izquierda
  parentOption.insertBefore(optionFileName, parentOption.querySelector("div.yggLIc:last-child"));
}

/**
 * Permite obtener el nombre del archivo seleccionado actualmente
 */
 GasToolsIde.prototype.getCurrFileName = function() {

  // Referenciamos el modal actual
  var currModel = this.editor._modelData.model;

  // retornamoe el nombre del archivo
  return String(currModel.uri._formatted).replace(/inmemory:\/\/model\//gi, "Model ");//fileObject.models[currModel.uri.path] || "-";
}

/*
 * Permite establecer el tema en el editor
 */
GasToolsIde.prototype.changeTheme = function(currButton, contentList) {

  // obtenemos el elemento seleccionado
  var elemSelected = contentList.querySelector(".gas__theme-item[aria-selected=\"true\"]");
  
  // se valida que en efecto exista
  if (elemSelected && this.notCurrTheme(elemSelected)) {

    // se obtiene le tema seleccionado
    var themeSelected = elemSelected.getAttribute("data-value");

    // se valida si no existe un tema se selecciona uno por defecto
    if (!themeSelected) themeSelected = "vs";
    
    // se establece el tema seleccionado
    this.setTheme(themeSelected, true);
  }
}

/**
 * Establecemos el tema por defecto o el guardado por el usuario
 */
GasToolsIde.prototype.setTheme = function(newTheme, isSave) {

  var _this = this;

  // validamos si no existe el valor
  newTheme = newTheme || 'vs';

  // Validamos si se debe guardar la clase
  if (isSave) {

    // Guardamos la clase seleccionada
    document.dispatchEvent(new CustomEvent('GAS_SavingThemeData', {
      detail: newTheme
    }));

  }
  
  // se valida si el tema elegido es el de por defcato
  if (newTheme == "vs") {

    // Se establece el tema por defceto
    //this.editor._themeService.setTheme("apps-script-light");
    monaco.editor.setTheme("apps-script-light");
  } else {

    // validamos si el tema aun no ha sido cargado
    if (!_this.loadedThemes[newTheme]) {
      
      // se define la url donde estan los temas - https://github.com/rubenchodev/monaco-themes/blob/main/
      //var path = 'https://bitwiser.in/monaco-themes/themes/' + _this.themeObjectList[newTheme] + '.json';
      //var path = '/themes/' + _this.themeObjectList[newTheme] + '.json?alt=media';
      var path = _this.options.themeUrl + '/' + _this.themeObjectList[newTheme] + '.json'
      
      // obteneos la información 
      fetch(path).then(function(response) {
          //return (response.text())
            // Convert to JSON
            return response.json();
        }).then(data => {

          // se agrega a la lista de temas ya registrados
          _this.loadedThemes[newTheme] = true;

          // se confirma que en efecto este inicializado el editor
          if (window.monaco) {
            monaco.editor.defineTheme(newTheme, data);
            monaco.editor.setTheme(newTheme);
          }
        }).catch(function(error) {
          
          // se confirma que en efecto este inicializado el editor
          if (window.monaco) {
            // se define el tema
            monaco.editor.setTheme("apps-script-light");
          }
        });
    } else {

      // se confirma que en efecto este inicializado el editor
      if (window.monaco) {
        // se define el tema
        monaco.editor.setTheme(newTheme);
      }
    }

  }

}

/*
 * Permite agregar la lista de temas disponibles
 */
GasToolsIde.prototype.addThemeList = function(container) {

  // Lista de temas
  const themeList = [
    { text: "Default", value: "vs" },
    { text: "Active4D", value: "active4d" },
    { text: "All Hallows Eve", value: "all-hallows-eve" },
    { text: "Amy", value: "amy" },
    { text: "Birds of Paradise", value: "birds-of-paradise" },
    { text: "Blackboard", value: "blackboard" },
    { text: "Brilliance Black", value: "brilliance-black" },
    { text: "Brilliance Dull", value: "brilliance-dull" },
    { text: "Chrome DevTools", value: "chrome-devtools" },
    { text: "Clouds Midnight", value: "clouds-midnight" },
    { text: "Clouds", value: "clouds" },
    { text: "Cobalt", value: "cobalt" },
    { text: "Dawn", value: "dawn" },
    { text: "Dreamweaver", value: "dreamweaver" },
    { text: "Eiffel", value: "eiffel" },
    { text: "Espresso Libre", value: "espresso-libre" },
    { text: "GitHub", value: "github" },
    { text: "IDLE", value: "idle" },
    { text: "Katzenmilch", value: "katzenmilch" },
    { text: "Kuroir Theme", value: "kuroir-theme" },
    { text: "LAZY", value: "lazy" },
    { text: "MagicWB (Amiga)", value: "magicwb--amiga-" },
    { text: "Merbivore Soft", value: "merbivore-soft" },
    { text: "Merbivore", value: "merbivore" },
    { text: "Monokai Bright", value: "monokai-bright" },
    { text: "Monokai", value: "monokai" },
    { text: "Night Owl", value: "night-owl" },
    { text: "Oceanic Next", value: "oceanic-next" },
    { text: "Pastels on Dark", value: "pastels-on-dark" },
    { text: "Slush and Poppies", value: "slush-and-poppies" },
    { text: "Solarized-dark", value: "solarized-dark" },
    { text: "Solarized-light", value: "solarized-light" },
    { text: "SpaceCadet", value: "spacecadet" },
    { text: "Sunburst", value: "sunburst" },
    { text: "Textmate (Mac Classic)", value: "textmate--mac-classic-" },
    { text: "Tomorrow-Night-Blue", value: "tomorrow-night-blue" },
    { text: "Tomorrow-Night-Bright", value: "tomorrow-night-bright" },
    { text: "Tomorrow-Night-Eighties", value: "tomorrow-night-eighties" },
    { text: "Tomorrow-Night", value: "tomorrow-night" },
    { text: "Tomorrow", value: "tomorrow" },
    { text: "Twilight", value: "twilight" },
    { text: "Upstream Sunburst", value: "upstream-sunburst" },
    { text: "Vibrant Ink", value: "vibrant-ink" },
    { text: "Xcode_default", value: "xcode-default" },
    { text: "Zenburnesque", value: "zenburnesque" },
    { text: "iPlastic", value: "iplastic" },
    { text: "idleFingers", value: "idlefingers" },
    { text: "krTheme", value: "krtheme" },
    { text: "monoindustrial", value: "monoindustrial" }
  ];

  // referenciamos el elemento en el DOM de la lista de valores
  var itemDom = container.querySelector(".gas__theme-list");

  // se valida si existe el contenedor de los items
  if (itemDom) {

    var itemContent, notFound = true,
      arialSelected = false,
      tabindex, addClass = "";

    // recorremos cada uno de los items de
    for (var i = 0; i < themeList.length; i++) {

      arialSelected = false;
      tabindex = -1;
      addClass = "";

      // se valida si el tema actual es el que se seleccionado
      if (themeList[i].value == this.options.currTheme) {
        arialSelected = true;
        notFound = false;
        tabindex = 0;
        addClass = " KKjvXb";
      }

      // creamos el contenedor del item
      itemContent = document.createElement('div');
      itemContent.className = ("MocG8c epDKCb LMgvRb gas__theme-item" + addClass);
      itemContent.setAttribute("data-value", themeList[i].value);
      itemContent.setAttribute("aria-selected", arialSelected);
      itemContent.setAttribute("tabindex", tabindex);
      itemContent.setAttribute("role", "option");
      itemContent.setAttribute("jsname", "wQNmvb");

      // Agregamos el contenido Html
      itemContent.innerHTML = escapeHTMLPolicy.createHTML(`<div class="kRoyt MbhUzd ziS7vd" jsname="ksKsZd"></div>
      <span jsslot="" class="vRMGwf oJeWuf">${themeList[i].text}</span>`);

      // agregamos la opción en el menu de la izquierda
      itemDom.appendChild(itemContent);
    }
  }
}


/**
 * Permite inicializar el campo de mostrar u ocultar lista de archivos
 */
GasToolsIde.prototype.createOptionToogle = function() {
  
  // referenciamos la intancia de la clase de
  var _this = this;

  // agregamos la opción en el menu de la izquierda
  var contentMenu = _this.container.querySelector(".td5WLe");

  // se valida si ya existe el boton para no agregarlo
  if (contentMenu.querySelector("#btnRubToogle")) return false;

  // removemos los valores anteriores
  apiRub.removeElem("btnRubToogle");

  // creamos la opción
  var option = document.createElement('div');
  option.className = "kcW8jf";
  option.id = "btnRubToogle";
  option.setAttribute("jsaction", "keydown:c385td; click:o6ZaF;");
  option.setAttribute("jsname", "RUBEN01");

  // Agregamos el contenido Html
  option.innerHTML = escapeHTMLPolicy.createHTML(_this.options.optionToogle);

  // agregamos la opción en el menu de la izquierda
  contentMenu.appendChild(option);

  // agregamos el evento al boton del
  option.addEventListener("click", function() {
    _this.toogleMenuFiles(this);
  });
}

/*
 *mostrar u ocultar un panel
 */
GasToolsIde.prototype.toogleMenuFiles = function(currButton) {

  // se referncia el icono
  var iconDom = currButton.querySelector("i.google-material-icons");

  // referenciamos el menu file
  var menuDom = this.container.querySelector(".Kp2okb.SQyOec");

  // se valida que exista el menu item
  if (menuDom) {

    // estado inicializar
    var stateDisplay = "none";

    // se valida si es visible el menu
    if (menuDom.style.display == "none") {
      stateDisplay = "block";

      // agregamos el icono de mostrar
      iconDom.innerHTML = escapeHTMLPolicy.createHTML("keyboard_arrow_left");
    } else {

      // agregamos el icono de ocultar
      iconDom.innerHTML = escapeHTMLPolicy.createHTML("keyboard_arrow_right");
    }

    // mostramos u oculptamso el menu
    menuDom.style.display = stateDisplay;

    // removemos la clase que extiende el menu de opciones
    this.container.querySelector(".td5WLe").classList.remove("DmojYb");
  }
}

/**
 * Lista de temas disponibles
 **/
GasToolsIde.prototype.themeObjectList = {
  "active4d": "Active4D",
  "all-hallows-eve": "All Hallows Eve",
  "amy": "Amy",
  "birds-of-paradise": "Birds of Paradise",
  "blackboard": "Blackboard",
  "brilliance-black": "Brilliance Black",
  "brilliance-dull": "Brilliance Dull",
  "chrome-devtools": "Chrome DevTools",
  "clouds-midnight": "Clouds Midnight",
  "clouds": "Clouds",
  "cobalt": "Cobalt",
  "dawn": "Dawn",
  "dreamweaver": "Dreamweaver",
  "eiffel": "Eiffel",
  "espresso-libre": "Espresso Libre",
  "github": "GitHub",
  "idle": "IDLE",
  "katzenmilch": "Katzenmilch",
  "kuroir-theme": "Kuroir Theme",
  "lazy": "LAZY",
  "magicwb--amiga-": "MagicWB (Amiga)",
  "merbivore-soft": "Merbivore Soft",
  "merbivore": "Merbivore",
  "monokai-bright": "Monokai Bright",
  "monokai": "Monokai",
  "night-owl": "Night Owl",
  "oceanic-next": "Oceanic Next",
  "pastels-on-dark": "Pastels on Dark",
  "slush-and-poppies": "Slush and Poppies",
  "solarized-dark": "Solarized-dark",
  "solarized-light": "Solarized-light",
  "spacecadet": "SpaceCadet",
  "sunburst": "Sunburst",
  "textmate--mac-classic-": "Textmate (Mac Classic)",
  "tomorrow-night-blue": "Tomorrow-Night-Blue",
  "tomorrow-night-bright": "Tomorrow-Night-Bright",
  "tomorrow-night-eighties": "Tomorrow-Night-Eighties",
  "tomorrow-night": "Tomorrow-Night",
  "tomorrow": "Tomorrow",
  "twilight": "Twilight",
  "upstream-sunburst": "Upstream Sunburst",
  "vibrant-ink": "Vibrant Ink",
  "xcode-default": "Xcode_default",
  "zenburnesque": "Zenburnesque",
  "iplastic": "iPlastic",
  "idlefingers": "idleFingers",
  "krtheme": "krTheme",
  "monoindustrial": "monoindustrial"
};