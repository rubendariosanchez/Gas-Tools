/**
 * Notifica a los editores sobre actualizaciones.
 * @param {*} updateType
 * @returns {Promise<void>} Promesa que se resuelve cuando el background confirma recepción
 */
export function notifyEditors(updateType = 'settings') {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'NOTIFY_UPDATE', updateType }, (response) => {
      resolve();
    });
  });
}