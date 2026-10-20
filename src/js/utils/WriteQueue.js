/**
 * @fileoverview Cola de escritura serializada (sin dependencias de Chrome).
 *
 * Encadena tareas async para que cada read-modify-write termine antes de
 * empezar el siguiente: evita que dos toggles rápidos se pisen en IndexedDB.
 */

/**
 * Crea una cola que ejecuta las tareas de una en una, en orden de llegada.
 * @returns {(task: () => Promise<*>|*) => Promise<*>} Encola `task` y resuelve con su resultado.
 */
export function createWriteQueue() {
    let tail = Promise.resolve();

    return (task) => {
        const run = tail.then(() => task());
        // Un fallo no debe bloquear las tareas siguientes de la cola.
        tail = run.catch(() => {});
        return run;
    };
}
