/**
 * Notifica a los editores sobre actualizaciones.
 * @param {*} updateType 
 */
export function notifyEditors(updateType = 'settings') {
  // Enviamos un mensaje a través de chrome.runtime para que el background script lo reciba y luego lo reenvíe a los content scripts activos
  chrome.runtime.sendMessage({ type: 'NOTIFY_UPDATE', updateType });
}