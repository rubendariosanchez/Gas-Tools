// Nombre de la propiedad raíz usada en chrome.storage
export const G_PROPERTY_NAME = 'QualityCode';

// Configuración por defecto para las opciones de usuario
export const DEFAULT_SETTINGS_OPTIONS = {
    'global-enable': true,
    'load-snippets': true,
    'showMinimap': true,
    'wordWrap': false,
    'bracketPairs': true,
    'smoothScrolling': true,
    'tabCompletion': true,
    'scrollBeyondLastLine': false,
    'peekWidget': true,
    'formatOnSave': true
};

// Archivo de configuración para variables globales y constantes
export const DEFAULT_SNIPPETS = [
  // ── UTILIDADES DE CONSOLA ──────────────────────────
  {
    id: 'js-console-log',
    title: 'Log to console',
    prefix: 'clog', // Cambiado para evitar conflicto con 'log'
    lang: 'javascript',
    code: 'console.log(${1:variable});',
    protected: true
  },
  {
    id: 'gas-logger',
    title: 'GAS Logger',
    prefix: 'log',
    lang: 'javascript',
    code: 'Logger.log(${1:message});',
    protected: true
  },

  // ── GOOGLE APPS SCRIPT ESPECÍFICOS ──────────────────
  {
    id: 'gas-get-ss',
    title: 'Get Active Spreadsheet',
    prefix: 'gss',
    lang: 'javascript',
    code: 'const ss = SpreadsheetApp.getActiveSpreadsheet();\nconst sheet = ss.getSheetByName("${1:Sheet1}");\n$0',
    protected: true
  },
  {
    id: 'gas-get-values',
    title: 'Get Range Values',
    prefix: 'getval',
    lang: 'javascript',
    code: 'const ${1:data} = sheet.getRange("${2:A2:C}").getValues();\n$0',
    protected: true
  },
  {
    id: 'gas-ui-alert',
    title: 'Browser Alert',
    prefix: 'alert',
    lang: 'javascript',
    code: 'SpreadsheetApp.getUi().alert("${1:Message}");',
    protected: true
  },

  // ── ESTRUCTURAS DE CONTROL ──────────────────────────
  {
    id: 'js-for',
    title: 'For Loop',
    prefix: 'for',
    lang: 'javascript',
    code: 'for (let i = 0; i < ${1:array}.length; i++) {\n\tconst item = ${1:array}[i];\n\t$0\n}',
    protected: true
  },
  {
    id: 'js-for-of',
    title: 'For-Of Loop (Modern)',
    prefix: 'forof',
    lang: 'javascript',
    code: 'for (const ${1:item} of ${2:array}) {\n\t$0\n}',
    protected: true
  },
  {
    id: 'js-foreach',
    title: 'For-Each Loop',
    prefix: 'fe',
    lang: 'javascript',
    code: '${1:array}.forEach(${2:item} => {\n\t$0\n});',
    protected: true
  },
  {
    id: 'js-if-else',
    title: 'If-Else Statement',
    prefix: 'ife',
    lang: 'javascript',
    code: 'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}',
    protected: true
  },
  {
    id: 'js-trycatch',
    title: 'Try-Catch GAS',
    prefix: 'try',
    lang: 'javascript',
    code: 'try {\n\t$1\n} catch (e) {\n\tLogger.log("Error: " + e.toString());\n}',
    protected: true
  },

  // ── ARRAYS Y TRANSFORMACIÓN ───────────────────────
  {
    id: 'js-map',
    title: 'Map Array',
    prefix: 'map',
    lang: 'javascript',
    code: 'const ${1:newArray} = ${2:oldArray}.map(${3:item} => {\n\treturn $0\n});',
    protected: true
  },
  {
    id: 'js-filter',
    title: 'Filter Array',
    prefix: 'filter',
    lang: 'javascript',
    code: 'const ${1:filtered} = ${2:array}.filter(${3:item} => ${4:item.id === 1});',
    protected: true
  },

  // ── DOCUMENTACIÓN Y COMENTARIOS ─────────────────────
  {
    id: 'js-comment-block',
    title: 'JSDoc Comment',
    prefix: 'doc',
    lang: 'javascript',
    code: '/**\n * ${1:Description}\n * @param {${2:Type}} ${3:paramName}\n * @return {${4:Type}}\n */',
    protected: true
  },
  {
    id: 'js-todo',
    title: 'To-Do Comment',
    prefix: 'todo',
    lang: 'javascript',
    code: '// TODO: ${1:pending_task} - ${CURRENT_DATE}', 
    protected: true
  },

  {
    id: 'html-gas-base',
    title: 'GAS HTML Base',
    prefix: 'htmlgas',
    lang: 'html',
    code: '<!DOCTYPE html>\n<html>\n  <head>\n    <base target="_top">\n    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/normalize/8.0.1/normalize.min.css">\n    <?!= include("Stylesheet"); ?>\n  </head>\n  <body>\n    ${1:<h1>Hola Mundo</h1>}\n    \n    <?!= include("JavaScript"); ?>\n  </body>\n</html>',
    protected: true
  },

  // ── FORMULARIOS Y ENTRADAS ────────────────────────
  {
    id: 'html-input-group',
    title: 'Input Group with Label',
    prefix: 'field',
    lang: 'html',
    code: '<div class="field-group">\n  <label for="${1:id}">${2:Label}</label>\n  <input type="${3:text}" id="${1:id}" name="${1:id}" placeholder="${4:Enter value...}">\n</div>',
    protected: true
  },
  {
    id: 'html-button',
    title: 'Styled Button',
    prefix: 'btn',
    lang: 'html',
    code: '<button type="button" id="${1:btnId}" class="btn-primary">\n  ${2:Click Me}\n</button>',
    protected: true
  },
  {
    id: 'html-select',
    title: 'Select Dropdown',
    prefix: 'select',
    lang: 'html',
    code: '<label for="${1:id}">${2:Choose:}</label>\n<select id="${1:id}" name="${1:id}">\n  <option value="${3:val1}">${4:Option 1}</option>\n  <option value="${5:val2}">${6:Option 2}</option>\n</select>',
    protected: true
  },

  // ── COMPONENTES DE INTERFAZ ────────────────────────
  {
    id: 'html-div-container',
    title: 'Div Container',
    prefix: 'divc',
    lang: 'html',
    code: '<div class="${1:container}">\n  $0\n</div>',
    protected: true
  },
  {
    id: 'html-table',
    title: 'Professional Table',
    prefix: 'table',
    lang: 'html',
    code: '<table class="data-table">\n  <thead>\n    <tr>\n      <th>${1:Header 1}</th>\n      <th>${2:Header 2}</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>$3</td>\n      <td>$4</td>\n    </tr>\n  </tbody>\n</table>',
    protected: true
  },

  // ── CARGA Y SCRIPTS ──────────────────────────────
  {
    id: 'html-script-include',
    title: 'GAS Script Include',
    prefix: 'incjs',
    lang: 'html',
    code: '<?!= include("${1:JavaScript}"); ?>',
    protected: true
  },
  {
    id: 'html-css-include',
    title: 'GAS CSS Include',
    prefix: 'incss',
    lang: 'html',
    code: '<?!= include("${1:Stylesheet}"); ?>',
    protected: true
  },
  {
    id: 'html-spinner',
    title: 'Loading Spinner',
    prefix: 'loader',
    lang: 'html',
    code: '<div id="loader" class="spinner" style="display:none;">\n  <div class="double-bounce1"></div>\n  <div class="double-bounce2"></div>\n  <p>Cargando...</p>\n</div>',
    protected: true
  }
];