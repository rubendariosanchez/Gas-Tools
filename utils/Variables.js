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
    id: 'base-gs-data',
    title: 'Sheet Data',
    prefix: 'gsd',
    lang: 'Google Apps Script',
    code: 'function getSheetData() {\n  const ss = SpreadsheetApp.getActiveSpreadsheet();\n  return ss.getDataRange().getValues();\n}',
    protected: true
  }
];