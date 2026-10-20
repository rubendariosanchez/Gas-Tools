/**
 * Notifica a los editores sobre actualizaciones.
 * Con `changed` el background reenvía el delta sin volver a leer IndexedDB.
 * @param {string} updateType 'settings' | 'snippets' | 'themes'.
 * @param {Object|null} changed Solo las claves de settings que cambiaron.
 * @param {Object|null} options Opciones completas ya guardadas (Side Panel las usa).
 * @returns {Promise<void>} Promesa que se resuelve cuando el background confirma recepción
 */
export function notifyEditors(updateType = 'settings', changed = null, options = null) {
  const message = { type: 'NOTIFY_UPDATE', updateType };
  if (changed && typeof changed === 'object') message.changed = changed;
  if (options && typeof options === 'object') message.options = options;

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, () => {
        // Leer lastError evita el aviso "Unchecked runtime.lastError".
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_) {
      resolve(); // Contexto invalidado: no hay a quién notificar.
    }
  });
}
