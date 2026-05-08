import { G_PROPERTY_NAME } from './Variables.js';

/**
 * Sincroniza la última actualización en IndexedDB.
 * @private
 */
export async function syncLastUpdated() {
    const timestamp = new Date().toISOString();
    const result = await chrome.storage.sync.get([G_PROPERTY_NAME]);

    // Se actualiza la propiedad lastUpdated con la fecha actual
    await chrome.storage.sync.set({
        [G_PROPERTY_NAME]: {
            ...result[G_PROPERTY_NAME],
            lastUpdated: timestamp
        }
    });
}