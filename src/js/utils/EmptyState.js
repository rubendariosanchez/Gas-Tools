import { createIcon } from './Icons.js';

/**
 * Crea un estado vacío con icono, mensaje y acción opcional.
 * @param {Object} opts Opciones.
 * @param {string} opts.icon Nombre del registro de iconos (GasUi).
 * @param {string} opts.message Texto (se inserta como texto plano).
 * @param {string} [opts.actionLabel] Etiqueta del botón de acción.
 * @param {Function} [opts.onAction] Callback del botón.
 * @returns {HTMLElement}
 */
export function createEmptyState({ icon, message, actionLabel, onAction }) {
    const box = document.createElement('div');
    box.className = 'qc__empty-state';

    const iconEl = createIcon(icon);

    const text = document.createElement('p');
    text.textContent = message;
    box.append(iconEl, text);

    if (actionLabel && typeof onAction === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qc__btn qc__btn--tonal';
        btn.textContent = actionLabel;
        btn.addEventListener('click', onAction);
        box.appendChild(btn);
    }
    return box;
}
