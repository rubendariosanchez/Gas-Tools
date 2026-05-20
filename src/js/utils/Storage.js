/**
 * API para gestionar IndexedDB de forma simplificada.
 */
export class StorageAPI {
    constructor(dbName = 'QualityCodeDB', version = 2) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
    }

    /**
     * Abre la conexión con la base de datos.
     */
    async open() {
        // Si la conexión fue cerrada por Chrome, reabrimos
        if (this.db) {
            try {
                // Prueba rápida para ver si la conexión sigue viva
                this.db.transaction('settings', 'readonly').abort();
                return this.db;
            } catch {
                this.db = null; // conexión muerta, forzamos reapertura
            }
        }

        // Si no hay conexión, abrimos una nueva
        return new Promise((resolve, reject) => {
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
                this.db = request.result;
                resolve(this.db);
            };

            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Guarda o actualiza un registro en un store específico.
     */
    async set(storeName, data) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);

            // Si el objeto tiene un 'id', lo usamos como clave, sino se asume que el store es de tipo key-value
            const request = store.put(data);

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Obtiene todos los registros de un store.
     */
    async getAll(storeName) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
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
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.delete(id);

            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Obtiene un registro por ID o clave (para settings).
     * Si el store es de tipo key-value, se debe pasar la clave como segundo argumento.
     */
    async get(storeName, key) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const request = store.get(key);

          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }
}

// Exportamos una instancia única (Singleton)
export const DB = new StorageAPI();