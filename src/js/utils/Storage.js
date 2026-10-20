/**
 * @fileoverview Wrapper minimalista de IndexedDB para uso compartido.
 *
 * Expone un singleton `DB` con la API `open / get / getAll / put / delete /
 * clear` que cualquier capa (popup, background, content script) puede
 * importar. La base de datos es `QualityCodeDB` con tres stores:
 *  - `settings`: opciones del usuario.
 *  - `snippets`: snippets personalizados.
 *  - `themes`: temas personalizados (los protegidos viven en `THEME_LIST`).
 *
 * Cachea la conexión y la invalida en `onclose`/`onversionchange` (Chrome
 * puede cerrarla cuando el service worker duerme); la siguiente operación reabre.
 */
export class StorageAPI {
    constructor(dbName = 'QualityCodeDB', version = 2) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
        // Apertura en curso: llamadas concurrentes comparten la misma petición.
        this._opening = null;
    }

    /**
     * Abre (o reutiliza) la conexión con la base de datos.
     * @returns {Promise<IDBDatabase>}
     * @throws {DOMException} Si IndexedDB rechaza la apertura.
     */
    async open() {
        if (this.db) return this.db;
        if (this._opening) return this._opening;

        this._opening = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                // Creamos almacenes de objetos (tablas)
                if (!db.objectStoreNames.contains('snippets')) {
                    db.createObjectStore('snippets', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('themes')) {
                    db.createObjectStore('themes', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'id' }); // Almacén simple llave-valor
                }
            };

            request.onsuccess = () => {
                const db = request.result;
                // Conexión cerrada por Chrome u otra pestaña sube la versión: se descarta la caché.
                const invalidate = () => { if (this.db === db) this.db = null; };
                db.onclose = invalidate;
                db.onversionchange = () => { invalidate(); db.close(); };
                this.db = db;
                resolve(db);
            };

            request.onerror = () => reject(request.error);
        }).finally(() => { this._opening = null; });

        return this._opening;
    }

    /**
     * Abre una transacción; si la conexión cacheada murió, reabre una vez.
     * @param {string} storeName
     * @param {IDBTransactionMode} mode
     * @returns {Promise<IDBTransaction>}
     * @throws {DOMException} Si la transacción no puede crearse tras reabrir.
     * @private
     */
    async _tx(storeName, mode) {
        const db = await this.open();
        try {
            return db.transaction(storeName, mode);
        } catch (err) {
            if (err?.name !== 'InvalidStateError') throw err;
            if (this.db === db) this.db = null;
            return (await this.open()).transaction(storeName, mode);
        }
    }

    /**
     * Guarda o actualiza un registro en un store específico.
     */
    async set(storeName, data) {
        const tx = await this._tx(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            // Si el objeto tiene un 'id', lo usamos como clave, sino se asume que el store es de tipo key-value
            tx.objectStore(storeName).put(data);

            // Se resuelve al confirmarse la transacción (datos ya persistidos).
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    /**
     * Obtiene todos los registros de un store.
     */
    async getAll(storeName) {
        const tx = await this._tx(storeName, 'readonly');
        return new Promise((resolve, reject) => {
            const store = tx.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Elimina un registro por ID.
     */
    async delete(storeName, id) {
        const tx = await this._tx(storeName, 'readwrite');
        return new Promise((resolve, reject) => {
            tx.objectStore(storeName).delete(id);

            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    /**
     * Obtiene un registro por ID o clave (para settings).
     * Si el store es de tipo key-value, se debe pasar la clave como segundo argumento.
     */
    async get(storeName, key) {
      const tx = await this._tx(storeName, 'readonly');
      return new Promise((resolve, reject) => {
          const store = tx.objectStore(storeName);
          const request = store.get(key);

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }
}

// Exportamos una instancia única (Singleton)
export const DB = new StorageAPI();