/** 
 * Creamos la clase para manejar una ventana en la que podra visualizar la lista de errores
 */
function PopoverGasIde(trigger, editor, monacoEditor, fileObject) {
  
  // referenciamos la opción donde se da clic y la variable para almacenar el elemento
  this.trigger = trigger;
  this.element = null;

  // variable que controla la apertura del elemento a mostrar
  this._isOpen = false;
  this.editor = editor;
  this.fileObject = fileObject;

  this.initX = 0;
  this.initY = 0;
  this.monacoEditor = monacoEditor;
  this.mousePressX = 0;
  this.mousePressY = 0;

  // llamamos el metodo para agregar el evento
  this.addEvent();

  // establecemos que el this de las siguientes funciones es el this de la clase
  this.repositionElement = this.repositionElement.bind(this);
}

/**
 * Método para mostrar u ocultar la ventana
 */
PopoverGasIde.prototype.toggle = function(e) {

  // Se detiene la propagación de algun otro evento
  e.stopPropagation();

  // se valida si ya esta abierta la ventana
  if (this._isOpen && document.querySelector('.rs__popover-gas')) {

    // Se cierra la ventana
    this.close(e);
  } else {

    // se garantiza que no exista ningun panel abiertp
    document.querySelectorAll('.rs__popover-gas').forEach(function(element) {

      //Eliminamos los popovers actuales
      element.parentNode.removeChild(element);
    });

    // agregamos la clase de apertura
    this.trigger.classList.add('rs__popover-open');

    // se procede a crear el contenedor
    this.createPopover();

    // se cambia el estado a que ya es abierta la ventana
    this._isOpen = true;

    // lo posiciona en el lugar indicado
    this.position();
  }
};


/**
 * Método para mostrar u ocultar la ventana
 */
PopoverGasIde.prototype.addEvent = function() {

  // definimos cual es el this base de la clase
  var this_ = this;

  // Se establece el evento al elemento
  this_.trigger.addEventListener('click', this_.toggle.bind(this_));

  // Asignamos el evento para realizar la busqueda multiple
  this_.monacoEditor.addEventListener("keydown", function (e) {

    // obtenemos el número de la tecla seleccionada
    var keyValue = this ? e.keyCode : e.which;
    
    // Se valida que se mantenga oprimida la tecla shift o alt
    if (e.shiftKey || e.altKey) { // Tecla shift
      switch (keyValue) {
        case 70: // tecla F

          //abrimos o cerramos la ventana de busqueda
          this_.trigger.dispatchEvent(new Event("click"));

          e.cancelBubble = true;
          e.returnValue = false;

          // Evitamos realizar otros comandos - for firefox and others
          if (e.stopPropagation) {
            e.stopPropagation();
            e.preventDefault();
          }

        // Salimos del ciclo
        return false;
        break;
      }
    }
  });
}

/**
 * Método que permite cerrar la ventana
 */
PopoverGasIde.prototype.close = function(e) {

  // Se valida si no se esta realizando clic dentro del elemento
  if (this.element) {

    // se remueve el elemento
    this.element.remove();

    // se remueve el elemento
    this.element = null;

    // cambiamos el estado
    this._isOpen = false;

    // removemos la clase 'popover-open'
    this.trigger.classList.remove('rs__popover-open');
  }

};

/**
 * Método que permite validar si se esta realizando clic dentro de la ventana
 */
PopoverGasIde.prototype.targetIsInsideElement = function(e) {

  // Se referencia el elemento
  var target = e.target;

  // se valida que exista o que sea valido
  if (target && this.element) {
    do {

      // Se valida que el elemento pertenezca al popover
      if (this.element && target === this.element) {
        // se retorna verdadero
        return true;
      }
    } while (target = target.parentNode);
  }

  // por defecto se retorna falso
  return false;

};

/**
 * Método que permite establcer la posición de la ventana
 */
PopoverGasIde.prototype.position = function(e) {

  // se valida que el elemento exista
  if (this.element) {

    // Se obtiene los datos de la posición de cada elemento
    var triggerRect = this.trigger.getBoundingClientRect(),
      elementRect = this.element.getBoundingClientRect();

    //this.element.style.left = Number(triggerRect.left) + Number((triggerRect.width / 2) - Number(elementRect.width / 2)) + 'px';
    this.element.style.left = (Number(triggerRect.left) - 120) + 'px';
    this.element.style.top = (Number(triggerRect.bottom) + 10) + 'px';
  }
};

/**
 * Método que permite crear la ventana
 */
PopoverGasIde.prototype.createPopover = function(e) {

  // referenciamo la instancia de la clase
  var _this = this;

  // creamos el elemento
  _this.element = document.createElement('div');

  // agregamos las clases respectivas
  _this.element.className = 'rs__popover-gas rs__popover-gas-bottom';

  // agregamos el elemento al cuerpo de la página
  document.body.appendChild(_this.element);

  // creamos el elemento del títulos
  var titleElement = document.createElement('div');
  titleElement.classList.add('rs__popover-gas__title');
  titleElement.innerHTML = escapeHTMLPolicy.createHTML('Advanced search');
  titleElement.title = 'Move panel';
  _this.element.appendChild(titleElement);

  // Se agrega el botón de cerrar
  var closeElement = document.createElement('button');
  closeElement.classList.add('rs__popover-gas__close');
  closeElement.innerHTML = escapeHTMLPolicy.createHTML('X');
  closeElement.title = 'Close panel';
  titleElement.appendChild(closeElement);

  // se establece el evento al boton de salir
  closeElement.addEventListener('click', this.close.bind(this));

  // asignamos un evento para que cuando se mueva el elemento cambie de ubicación
  titleElement.addEventListener('mousedown', function(event) {

    // se referencia el padre
    var parent = this.parentNode;

    _this.initX = parent.offsetLeft;
    _this.initY = parent.offsetTop;
    _this.mousePressX = event.clientX;
    _this.mousePressY = event.clientY;

    // asignamos el evento de mover el panel
    this.addEventListener('mousemove', _this.repositionElement, false);

  }, false);

  // Cuando se detiene se elimina el movimiento
  window.addEventListener('mouseup', function() {
    titleElement.removeEventListener('mousemove', _this.repositionElement, false);
  }, false);

  // creamos el elemento del contenedor
  var contentElement = document.createElement('div');
  contentElement.classList.add('rs__popover-gas__content');
  _this.element.appendChild(contentElement);

  // creamos el contenido
  _this.addFormSeacrh(contentElement);
};

/**
 * Método que permite agregar mover un elemento en la interfaz
 */
PopoverGasIde.prototype.repositionElement = function(event, element) {
  event.target.parentNode.style.left = this.initX + event.clientX - this.mousePressX + 'px';
  event.target.parentNode.style.top = this.initY + event.clientY - this.mousePressY + 'px';
}

/**
 * Método que permite agregar el panel de búsqueda
 */
PopoverGasIde.prototype.addFormSeacrh = function(contentElement) {

  // referenciamos la intancia de la clase de
  var _this = this;

  // creamos el contenedor del campo y el boton
  var formEle = document.createElement('form');
  formEle.classList.add('rs__popover-content-field');
  contentElement.appendChild(formEle);

  // creamos el campo de búsqueda
  var input = document.createElement('input');
  input.classList.add('rs__popover-input');
  input.setAttribute("type", "text");
  input.setAttribute("placeholder", "Enter the word");
  formEle.appendChild(input);
  input.focus();

  // creamos el campo de búsqueda
  var button = document.createElement('button');
  button.classList.add('rs__popover-button');
  button.setAttribute("type", "submit");
  button.innerHTML = escapeHTMLPolicy.createHTML("Find");
  formEle.appendChild(button);

  // creamos el contenedor de resultado de búsqueda
  var divresults = document.createElement('div');
  divresults.classList.add('rs__popover-results');
  divresults.innerHTML = escapeHTMLPolicy.createHTML("No results");
  contentElement.appendChild(divresults);

  // asignamos ele evento al campo
  formEle.addEventListener("submit", function(evt) {
    evt.preventDefault();
    divresults.innerHTML = escapeHTMLPolicy.createHTML("Searching...");
    _this.findAllMatches(this, divresults);
  });
};

/**
 * Permite validar si el tema no es el actual
 */
PopoverGasIde.prototype.findAllMatches = function(element, divresults) {
  
  // referenciamos la intancia de la clase de
  var _this = this;

  let result = {},
    keys = [];

  // obtenemos el texto de búsqueda
  let searchText = element.querySelector("input").value;
  if (searchText && String(searchText).length > 2) {

    //Se consulta la lista de modelos existentes
    monaco.editor.getModels().forEach((model, index) => {
      
      // referenciamos la clave de acuerdo al clic
      property = String(model.uri._formatted).replace(/inmemory:\/\/model\//gi, "Model ");
      
      // se recorre cada uno de los modelos
      for (let match of model.findMatches(searchText)) {

        // se valdia si el modelo a un no se ha registrado
        if (!result[property]) {
          result[property] = [];
        }

        // se procesa cada na de las busquedas
        result[property].push({
          text: model.getLineContent(match.range.startLineNumber),
          range: match.range,
          model: model
        });
      }
    });

    // se valida si existe almenos una concidencia
    if (Object.keys(result).length > 0) {
      divresults.innerHTML = escapeHTMLPolicy.createHTML('');

      // se crea la lista principal
      var listUl = document.createElement('ul'),
        itemLi;
      listUl.className = "rs__main-ul";

      // se agrega la lista al contenedor
      divresults.appendChild(listUl);

      // recooremos cada uno de los grupos de archivos
      for (var key in result) {

        // se agrega cada lista
        itemLi = document.createElement('li');
        itemLi.innerHTML = escapeHTMLPolicy.createHTML(key);

        // agregamos los items de la lista
        this.addSubList(itemLi, result[key]);

        // se agrega el item en la tabla de resultados
        listUl.appendChild(itemLi);
      }

    } else {
      divresults.innerHTML = escapeHTMLPolicy.createHTML('No results');
    }

  } else {
    divresults.innerHTML = escapeHTMLPolicy.createHTML('Enter minimum 3 characters');
  }

};


/**
 * Creamos la sublista de items de búsqueda
 */
PopoverGasIde.prototype.addSubList = function(content, results) {

  // referenciamos la intancia de la clase de
  var _this = this;

  // se crea la lista principal
  var listUl = document.createElement('ul'),
    itemLi;

  // se agrega la lista al contenedor
  content.appendChild(listUl);

  // recooremos cada uno de los grupos de archivos
  for (var i = 0; i < results.length; i++) {

    // se agrega cada lista
    itemLi = document.createElement('li');
    itemLi.innerText = ("Line " + results[i].range.startLineNumber + ": " + results[i].text);
    itemLi.title = results[i].text;
    itemLi.findData = results[i];

    // asignamos ele evento al campo
    itemLi.addEventListener("click", function() {
      _this.goto(this);
    });

    // se agrega el item en la tabla de resultados
    listUl.appendChild(itemLi);
  }
}

//where range and model, corresponding to findAllMatches returns the range and model properties of the object in the result set
PopoverGasIde.prototype.goto = function(element) {
  
  // Eliminaos los archivos selecciondos
  this.clearSelectedFile();

  // obtenemso los datos
  var findData = element.findData;
  
  // Se referencia el modelo a usar
  this.editor.setModel(findData.model);

  // Se selecciona el texto encontrado
  this.editor.setSelection(findData.range);

  // Coloque la posición seleccionada en el medio para mostrar
  this.editor.revealRangeInCenter(findData.range);

  // se cambia el nombre del archivo activo
  var domFileName = document.querySelector("#ctnCurrentFileName");
  
  // se valida que ya exista
  if(domFileName){
    domFileName.innerHTML = escapeHTMLPolicy.createHTML(this.getCurrFileName(findData.model, this));
  }
}

/**
 * Permiteeliminar la selección de los archivos
 */
 PopoverGasIde.prototype.clearSelectedFile = function() {

  // variable que referencia los nombres de los archivos
  var contentFiles = document.querySelector("ul.StrnGf-VfPpkd-rymPhb.StrnGf-VfPpkd-rymPhb-OWXEXe-EzIYc.Fcw6db.GFlqGb");

  // Obtenemos los archivos seleccionados
  var domFiles = contentFiles.querySelectorAll("li.UeVsd");

  // se valida que realmente exista alguno
  if(domFiles && domFiles.length > 0){

    // recorremos cada uno de los items
    for (var i = 0; i < domFiles.length; i++) {
      domFiles[i].classList.remove("UeVsd");
    }
  }
 }

/**
 * Permite obtener el nombre del archivo seleccionado actualmente
 */
 PopoverGasIde.prototype.getCurrFileName = function(model, instance) {
  
  // Retornamos el nombre formateado
  return String(model.uri._formatted).replace(/inmemory:\/\/model\//gi, "Model ");
    
  // retornamos el valor por defecto
  return "-";
}