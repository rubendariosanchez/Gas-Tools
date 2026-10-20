// Nombre de la propiedad raíz usada en chrome.storage
export const G_PROPERTY_NAME = 'QualityCode';

/** Convierte valores en opciones `{ value, label }` con label = value. */
const plainOptions_ = (values) => values.map((v) => ({ value: String(v), label: String(v) }));

const FONT_FAMILIES_ = [
    'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Roboto Mono', 'Geist Mono', 'IBM Plex Mono',
    'Space Mono', 'DM Mono', 'Azeret Mono', 'Inconsolata', 'Anonymous Pro', 'Cousine', 'PT Mono',
    'Noto Sans Mono', 'Share Tech Mono', 'Martian Mono', 'Nova Mono', 'VT323', 'Consolas', 'Monaco', 'Menlo',
];
const FONT_SIZES_ = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28, 30, 32, 34, 36, 40, 48];
const LINE_HEIGHTS_ = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 34, 36, 40, 48];

/**
 * Secciones del popup en orden de pintado (`icon` = nombre del registro de GasUi, `collapsible` = plegable con <details>).
 * @type {Array<{id: string, tab: string, i18n: string, icon: string, collapsible?: boolean}>}
 */
export const SETTINGS_SECTIONS = [
    { id: 'editor-text', tab: 'editor', i18n: 'sectionEditorText', icon: 'textFields' },
    { id: 'editor-display', tab: 'editor', i18n: 'sectionEditorDisplay', icon: 'eye' },
    { id: 'editor-editing', tab: 'editor', i18n: 'sectionEditorEditing', icon: 'editNote' },
    { id: 'editor-cursor', tab: 'editor', i18n: 'sectionEditorCursor', icon: 'swipeVertical' },
    { id: 'tools-explorer', tab: 'tools', i18n: 'sectionToolsExplorer', icon: 'folderOpen' },
    { id: 'tools-diagnostics', tab: 'tools', i18n: 'sectionToolsDiagnostics', icon: 'troubleshoot' },
    { id: 'tools-advanced', tab: 'tools', i18n: 'sectionAdvanced', icon: 'sliders', collapsible: true },
    { id: 'ai-autocomplete', tab: 'ai', i18n: 'sectionAiAutocomplete', icon: 'autoAwesome' },
    { id: 'ai-responses', tab: 'ai', i18n: 'sectionAiResponses', icon: 'translate' },
    { id: 'themes-appearance', tab: 'themes', i18n: 'sectionAppearance', icon: 'contrast' },
];

/**
 * Esquema declarativo único de las opciones del popup.
 * - `tab: 'header'`: se pinta en la cabecera; `managed`: lo pinta un módulo propio (idioma).
 * - `storage: 'sync'`: vive en chrome.storage.sync bajo `storageKey` (no entra en DEFAULT_SETTINGS_OPTIONS).
 * - `parent`: opción hija; se deshabilita (no se oculta) con el padre apagado.
 * @type {Array<Object>}
 */
export const SETTINGS_SCHEMA = [
    // Cabecera
    { key: 'ui-language', type: 'select', default: 'en', tab: 'header', section: null, managed: true,
        i18n: { title: 'uiLanguageTitle', description: 'uiLanguageTitle' },
        options: [{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }] },
    { key: 'global-enable', type: 'toggle', default: true, tab: 'header', section: null,
        i18n: { title: 'optGlobalEnableTitle', description: 'optGlobalEnableDesc' } },

    // Editor · Texto
    { key: 'fontFamily', type: 'select', default: 'Roboto Mono', tab: 'editor', section: 'editor-text',
        i18n: { title: 'optFontFamilyTitle', description: 'optFontFamilyDesc' },
        options: plainOptions_(FONT_FAMILIES_), keywords: ['font', 'typeface', 'fuente', 'tipografía'] },
    { key: 'fontSize', type: 'select', default: 13, tab: 'editor', section: 'editor-text',
        i18n: { title: 'optFontSizeTitle', description: 'optFontSizeDesc' },
        options: plainOptions_(FONT_SIZES_), keywords: ['font', 'size', 'zoom', 'tamaño'] },
    { key: 'lineHeight', type: 'select', default: 19, tab: 'editor', section: 'editor-text',
        i18n: { title: 'optLineHeightTitle', description: 'optLineHeightDesc' },
        options: plainOptions_(LINE_HEIGHTS_), keywords: ['spacing', 'interlineado'] },

    // Editor · Visualización
    { key: 'lineNumbers', type: 'toggle', default: true, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optLineNumbersTitle', description: 'optLineNumbersDesc' }, keywords: ['gutter', 'números'] },
    { key: 'renderLineHighlight', type: 'toggle', default: true, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optLineHighlightTitle', description: 'optLineHighlightDesc' }, keywords: ['current line', 'línea actual'] },
    { key: 'showMinimap', type: 'toggle', default: false, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optShowMinimapTitle', description: 'optShowMinimapDesc' }, keywords: ['minimap', 'minimapa', 'overview'] },
    { key: 'rulers', type: 'toggle', default: false, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optRulersTitle', description: 'optRulersDesc' }, keywords: ['column', 'reglas', 'columna'] },
    { key: 'renderWhitespace', type: 'toggle', default: false, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optRenderWhitespaceTitle', description: 'optRenderWhitespaceDesc' }, keywords: ['spaces', 'tabs', 'espacios'] },
    { key: 'occurrencesHighlight', type: 'toggle', default: true, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optOccurrencesHighlightTitle', description: 'optOccurrencesHighlightDesc' }, keywords: ['matches', 'coincidencias'] },
    { key: 'guides-indentation', type: 'toggle', default: true, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optIndentGuidesTitle', description: 'optIndentGuidesDesc' }, keywords: ['indent', 'sangría', 'guías'] },
    { key: 'bracketPairs', type: 'toggle', default: true, tab: 'editor', section: 'editor-display',
        i18n: { title: 'optBracketPairsTitle', description: 'optBracketPairsDesc' }, keywords: ['brackets', 'colors', 'llaves', 'corchetes'] },

    // Editor · Edición
    { key: 'tabSize', type: 'select', default: 2, tab: 'editor', section: 'editor-editing',
        i18n: { title: 'optTabSizeTitle', description: 'optTabSizeDesc' },
        options: plainOptions_([2, 4, 6, 8]), keywords: ['indent', 'tab', 'sangría', 'tabulación'] },
    { key: 'wordWrap', type: 'toggle', default: true, tab: 'editor', section: 'editor-editing',
        i18n: { title: 'optWordWrapTitle', description: 'optWordWrapDesc' }, keywords: ['wrap', 'ajuste', 'líneas largas'] },
    { key: 'autoClosingBrackets', type: 'toggle', default: true, tab: 'editor', section: 'editor-editing',
        i18n: { title: 'optAutoClosingBracketsTitle', description: 'optAutoClosingBracketsDesc' }, keywords: ['brackets', 'cierre', 'paréntesis'] },
    { key: 'quickSuggestions', type: 'toggle', default: true, tab: 'editor', section: 'editor-editing',
        i18n: { title: 'optQuickSuggestionsTitle', description: 'optQuickSuggestionsDesc' }, keywords: ['intellisense', 'autocomplete', 'sugerencias'] },
    { key: 'folding', type: 'toggle', default: true, tab: 'editor', section: 'editor-editing',
        i18n: { title: 'optFoldingTitle', description: 'optFoldingDesc' }, keywords: ['collapse', 'plegar', 'contraer'] },

    // Editor · Cursor y desplazamiento
    { key: 'cursorStyle', type: 'select', default: 'line', tab: 'editor', section: 'editor-cursor',
        i18n: { title: 'optCursorStyleTitle', description: 'optCursorStyleDesc' },
        options: [
            { value: 'line', label: 'Line' }, { value: 'block', label: 'Block' },
            { value: 'underline', label: 'Underline' }, { value: 'line-thin', label: 'Line thin' },
            { value: 'block-outline', label: 'Block outline' }, { value: 'underline-thin', label: 'Underline thin' },
        ], keywords: ['caret', 'cursor'] },
    { key: 'cursorBlinking', type: 'select', default: 'blink', tab: 'editor', section: 'editor-cursor',
        i18n: { title: 'optCursorBlinkingTitle', description: 'optCursorBlinkingDesc' },
        options: [
            { value: 'blink', label: 'Blink' }, { value: 'smooth', label: 'Smooth' },
            { value: 'phase', label: 'Phase' }, { value: 'hidden', label: 'Hidden' },
        ], keywords: ['caret', 'parpadeo', 'animation'] },
    { key: 'smoothScrolling', type: 'toggle', default: true, tab: 'editor', section: 'editor-cursor',
        i18n: { title: 'optSmoothScrollingTitle', description: 'optSmoothScrollingDesc' }, keywords: ['scroll', 'desplazamiento'] },
    { key: 'scrollBeyondLastLine', type: 'toggle', default: false, tab: 'editor', section: 'editor-cursor',
        i18n: { title: 'optScrollBeyondLastLineTitle', description: 'optScrollBeyondLastLineDesc' }, keywords: ['scroll', 'desplazamiento', 'final'] },

    // Herramientas · Explorador de archivos
    { key: 'gas-folders', type: 'toggle', default: true, tab: 'tools', section: 'tools-explorer',
        i18n: { title: 'optGasFoldersTitle', description: 'optGasFoldersDesc' }, keywords: ['folders', 'tree', 'carpetas', 'árbol'] },
    { key: 'gas-folders-color', type: 'color', default: '#5f6368', tab: 'tools', section: 'tools-explorer', parent: 'gas-folders',
        i18n: { title: 'optFolderColorTitle', description: 'optFolderColorDesc' }, keywords: ['color', 'folder', 'carpeta'] },
    { key: 'gas-file-gs-color', type: 'color', default: '#4086f4', tab: 'tools', section: 'tools-explorer', parent: 'gas-folders',
        i18n: { title: 'optGsColorTitle', description: 'optGsColorDesc' }, keywords: ['color', 'gs', 'script'] },
    { key: 'gas-file-html-color', type: 'color', default: '#fc490b', tab: 'tools', section: 'tools-explorer', parent: 'gas-folders',
        i18n: { title: 'optHtmlColorTitle', description: 'optHtmlColorDesc' }, keywords: ['color', 'html'] },
    { key: 'gas-file-json-color', type: 'color', default: '#1bb24b', tab: 'tools', section: 'tools-explorer', parent: 'gas-folders',
        i18n: { title: 'optJsonColorTitle', description: 'optJsonColorDesc' }, keywords: ['color', 'json', 'manifest'] },
    { key: 'gas-file-tabs', type: 'toggle', default: false, tab: 'tools', section: 'tools-explorer',
        i18n: { title: 'optGasFileTabsTitle', description: 'optGasFileTabsDesc' }, keywords: ['tabs', 'pestañas', 'files', 'archivos', 'vscode'] },

    // Herramientas · Diagnósticos
    { key: 'gas-error-lens', type: 'toggle', default: true, tab: 'tools', section: 'tools-diagnostics',
        i18n: { title: 'optErrorLensTitle', description: 'optErrorLensDesc' }, keywords: ['errors', 'lint', 'errores', 'diagnostics'] },
    { key: 'gas-error-lens-custom-rules', type: 'toggle', default: false, tab: 'tools', section: 'tools-diagnostics', parent: 'gas-error-lens',
        i18n: { title: 'optErrorLensCustomRulesTitle', description: 'optErrorLensCustomRulesDesc' }, keywords: ['rules', 'reglas', 'heuristics'] },

    // Herramientas · Avanzado
    { key: 'debug-mode', type: 'toggle', default: false, tab: 'tools', section: 'tools-advanced',
        i18n: { title: 'optDebugModeTitle', description: 'optDebugModeDesc' }, keywords: ['debug', 'logs', 'console', 'depuración'] },

    // IA
    { key: 'ai-autocomplete', type: 'toggle', default: false, tab: 'ai', section: 'ai-autocomplete', experimental: true,
        i18n: { title: 'optAiAutocompleteTitle', description: 'optAiAutocompleteDesc' }, keywords: ['ai', 'ia', 'suggestions', 'copilot'] },
    { key: 'aiResponseLanguage', type: 'select', default: 'auto', tab: 'ai', section: 'ai-responses',
        storage: 'sync', storageKey: 'gasToolsAiLanguage',
        i18n: { title: 'optAiResponseLanguageTitle', description: 'optAiResponseLanguageDesc' },
        options: [
            { value: 'auto', label: 'Auto' }, { value: 'es', label: 'Español' }, { value: 'en', label: 'English' },
            { value: 'pt', label: 'Português' }, { value: 'fr', label: 'Français' },
            { value: 'de', label: 'Deutsch' }, { value: 'it', label: 'Italiano' },
        ], keywords: ['language', 'idioma', 'chat'] },

    // Temas
    { key: 'ide-dark-mode', type: 'toggle', default: false, tab: 'themes', section: 'themes-appearance',
        i18n: { title: 'optIdeDarkModeTitle', description: 'optIdeDarkModeDesc' }, keywords: ['dark', 'oscuro', 'night', 'noche'] },
];

/**
 * Indica si la entrada se guarda en IndexedDB junto al resto de settings.
 * @param {Object} entry Entrada de SETTINGS_SCHEMA.
 * @returns {boolean}
 */
export function isStoredSetting(entry) {
    return entry?.storage !== 'sync';
}

/**
 * Defaults de las entradas guardadas en IndexedDB, opcionalmente filtradas por pestaña.
 * @param {string[]} [tabs] Pestañas a incluir (todas si se omite).
 * @returns {Object} Mapa clave → default.
 */
export function getSchemaDefaults(tabs) {
    return Object.fromEntries(SETTINGS_SCHEMA
        .filter((e) => isStoredSetting(e) && (!tabs || tabs.includes(e.tab)))
        .map((e) => [e.key, e.default]));
}

// Configuración por defecto para las opciones de usuario (derivada del esquema).
export const DEFAULT_SETTINGS_OPTIONS = Object.freeze(getSchemaDefaults());

// Versión del esquema de settings; subirla obliga a re-normalizar lo guardado.
export const SETTINGS_SCHEMA_VERSION = 2;

// Claves retiradas que se eliminan al normalizar.
const REMOVED_SETTINGS_KEYS = ['load-snippets'];

// Toggles que antes guardaban texto (valores de Monaco) y ahora son booleanos.
// Tabla duplicada en `toBool_` de extension/js/gas-tools.js (MAIN world, sin módulos ES).
const LEGACY_BOOL_KEYS = [
    'lineNumbers', 'renderLineHighlight', 'rulers', 'occurrencesHighlight',
    'renderWhitespace', 'autoClosingBrackets', 'scrollBeyondLastLine',
];
const LEGACY_TRUE_VALUES = ['on', 'line', 'all', 'singleFile', 'always', 'selection', 'boundary', 'gutter', 'true'];
const LEGACY_FALSE_VALUES = ['', 'off', 'none', 'never', 'false'];

/**
 * Convierte un valor heredado (booleano o texto de Monaco) en booleano.
 * @param {*} val Valor guardado.
 * @param {boolean} fallback Valor si el texto no se reconoce.
 * @returns {boolean}
 */
export function legacyToBool(val, fallback = false) {
    if (typeof val === 'boolean') return val;
    if (LEGACY_TRUE_VALUES.includes(val)) return true;
    if (LEGACY_FALSE_VALUES.includes(val) || val == null) return false;
    return fallback;
}

/**
 * Normaliza las opciones guardadas: rellena defaults, migra textos a booleanos y fija `schemaVersion`. Pura e idempotente.
 * @param {Object|null|undefined} raw Opciones leídas de IndexedDB.
 * @returns {Object} Opciones nuevas (no muta `raw`).
 */
export function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { ...DEFAULT_SETTINGS_OPTIONS, ...source };
    LEGACY_BOOL_KEYS.forEach((key) => {
        out[key] = legacyToBool(out[key], DEFAULT_SETTINGS_OPTIONS[key]);
    });
    REMOVED_SETTINGS_KEYS.forEach((key) => delete out[key]);
    out.schemaVersion = SETTINGS_SCHEMA_VERSION;
    return out;
}

/**
 * Indica si dos objetos de opciones planos difieren (comparación superficial por clave).
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
export function settingsDiffer(a, b) {
    const keysA = Object.keys(a || {});
    const keysB = Object.keys(b || {});
    if (keysA.length !== keysB.length) return true;
    return keysA.some((k) => !Object.is(a[k], b?.[k]));
}

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