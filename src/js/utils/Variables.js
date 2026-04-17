// Nombre de la propiedad raíz usada en chrome.storage
export const G_PROPERTY_NAME = 'QualityCode';

// Configuración por defecto para las opciones de usuario
export const DEFAULT_SETTINGS_OPTIONS = {
    'global-enable': true,
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
  {
    id: 'base-logger',
    title: 'Logger Function',
    prefix: 'log',
    lang: 'JavaScript',
    code: 'function Logger(message) {\n  console.log("[LOG]", message);\n}',
    protected: true
  },
  {
    id: 'js-for',
    title: 'For Loop',
    prefix: 'for',
    lang: 'JavaScript',
    code: 'for (let ${1:index} = 0; ${1:index} < ${2:array}.length; ${1:index}++) {\n\tconst ${3:element} = ${2:array}[${1:index}];\n\t${0}\n}',
    protected: true
  },
  {
    id: 'js-for-backward',
    title: 'For Loop Backward',
    prefix: 'forbackward',
    lang: 'JavaScript',
    code: 'for (let ${1:index} = ${2:array}.length - 1; ${1:index} >= 0; ${1:index}--) {\n\tconst ${3:element} = ${2:array}[${1:index}];\n\t${0}\n}',
    protected: true
  },
  {
    id: 'js-for-of',
    title: 'For-Of Loop',
    prefix: 'forof',
    lang: 'JavaScript',
    code: 'for (const ${1:iterator} of ${2:array}) { \n\t${0}\n}',
    protected: true
  },
  {
    id: 'js-for-in',
    title: 'For-In Loop',
    prefix: 'forin',
    lang: 'JavaScript',
    code: 'for (const ${1:key} in ${2:object}) {\n\tconst ${3:element} = ${2:object}[${1:key}];\n\t${0}\n}',
    protected: true
  },
  {
    id: 'js-foreach',
    title: 'For-Each Loop',
    prefix: 'forEach',
    lang: 'JavaScript',
    code: '${1:array}.forEach(${2:element} => {\n\t${0}\n});',
    protected: true
  },
  {
    id: 'js-map',
    title: 'Map Loop',
    prefix: 'map',
    lang: 'JavaScript',
    code: '${1:array}.map(${2:element} => {\n\treturn ${2:element}${0}\n});',
    protected: true
  },
  {
    id: 'js-filter',
    title: 'Filter Loop',
    prefix: 'filter',
    lang: 'JavaScript',
    code: '${1:array}.filter(${2:element} => {\n\treturn ${2:element}${0}\n});',
    protected: true
  },
  {
    id: 'js-reduce',
    title: 'Array Reducer',
    prefix: 'reduce',
    lang: 'JavaScript',
    code: '${1:array}.reduce((${2:previousItem}, ${3:currentItem}) => {\n\t${0}\n\treturn ${2:previousItem}\n}, ${4:initialValue});',
    protected: true
  },
  {
    id: 'js-switch',
    title: 'Switch Statement',
    prefix: 'switch',
    lang: 'JavaScript',
    code: 'switch (${1:expr}) {\n\tcase ${2:value}:\n\t\t${0}\n\t\tbreak; \t\t\n\n\tdefault:\n\t\t\n\t\tbreak;\n}',
    protected: true
  },
  {
    id: 'js-function',
    title: 'Function Statement',
    prefix: 'function',
    lang: 'JavaScript',
    code: 'function ${1:name}(${2:params}) {\n\t${0}\n}',
    protected: true
  },
  {
    id: 'js-if',
    title: 'If Statement',
    prefix: 'if',
    lang: 'JavaScript',
    code: 'if (${1:condition}) {\n\t${0}\n}',
    protected: true
  },
  {
    id: 'js-ifelse',
    title: 'If-Else Statement',
    prefix: 'ifelse',
    lang: 'JavaScript',
    code: 'if (${1:condition}) {\n\t${0}\n} else {\n\t\n}',
    protected: true
  },
  {
    id: 'js-trycatch',
    title: 'Try-Catch Statement',
    prefix: 'trycatch',
    lang: 'JavaScript',
    code: 'try {\n\t${0}\n} catch (${1:error}) {\n\t\n}',
    protected: true
  },
  {
    id: 'js-console-log',
    title: 'Log to console',
    prefix: 'log',
    lang: 'JavaScript',
    code: 'console.log(${1:message});',
    protected: true
  },
  {
    id: 'js-todo',
    title: 'To-Do Comment',
    prefix: 'todo',
    lang: 'JavaScript',
    code: '// TODO: ${1:pending_task}',
    protected: true
  },
  {
    id: 'js-comment-block',
    title: 'JSDoc Comment',
    prefix: 'comment',
    lang: 'JavaScript',
    code: '/**\n * ${1:Description}\n */',
    protected: true
  }
];