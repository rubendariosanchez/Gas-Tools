/**
 * @fileoverview Sección "Acceso a proveedores" de la pestaña IA.
 *
 * Muestra un toggle por proveedor de IA y concede/revoca sus host
 * permissions opcionales con `chrome.permissions`. El estado se sincroniza
 * al cargar y cuando Chrome notifica cambios (onAdded / onRemoved).
 */

import { AI_PROVIDER_ORIGINS } from '../utils/Providers.js';
import { Toast } from '../utils/Toast.js';
import { tr } from '../utils/I18n.js';
import { normalizeSearchText } from './settings-renderer.js';

const TOGGLE_ID_PREFIX_ = 'provider-access-';

/**
 * Inicializa la sección de acceso a proveedores.
 */
export function initProviderAccessModule() {
    const container = document.getElementById('provider-access-list');
    if (!container || !chrome?.permissions) return;

    renderProviderToggles_(container);
    refreshProviderStates_();

    // Importante: el request debe hacerse dentro del gesto del usuario (sin awaits previos)
    container.addEventListener('toggle', (e) => {
        const providerId = e.target?.dataset?.providerId;
        if (providerId) handleProviderToggle_(providerId, e.target, e.detail.checked);
    });

    // Reflejar cambios hechos desde chrome://extensions u otras vistas
    const onPermissionsChanged = () => refreshProviderStates_();
    chrome.permissions.onAdded.addListener(onPermissionsChanged);
    chrome.permissions.onRemoved.addListener(onPermissionsChanged);
    window.addEventListener('pagehide', () => {
        chrome.permissions.onAdded.removeListener(onPermissionsChanged);
        chrome.permissions.onRemoved.removeListener(onPermissionsChanged);
    }, { once: true });
}

/**
 * Crea un `<option-toggle>` por proveedor.
 * @private
 */
function renderProviderToggles_(container) {
    const fragment = document.createDocumentFragment();
    Object.entries(AI_PROVIDER_ORIGINS).forEach(([providerId, provider]) => {
        const toggle = document.createElement('option-toggle');
        toggle.id = `${TOGGLE_ID_PREFIX_}${providerId}`;
        toggle.dataset.providerId = providerId;
        toggle.setAttribute('title', provider.label);
        toggle.setAttribute('description', provider.origins.join(' · '));
        // Indexado para la búsqueda común de la pestaña IA.
        toggle.dataset.search = normalizeSearchText(`${provider.label} ${providerId} ${provider.origins.join(' ')}`);
        fragment.appendChild(toggle);
    });
    container.replaceChildren(fragment);
}

/**
 * Marca cada toggle según los permisos concedidos actualmente.
 * @private
 */
async function refreshProviderStates_() {
    await Promise.all(Object.entries(AI_PROVIDER_ORIGINS).map(async ([providerId, provider]) => {
        const toggle = document.getElementById(`${TOGGLE_ID_PREFIX_}${providerId}`);
        if (!toggle) return;
        try {
            const granted = await chrome.permissions.contains({ origins: provider.origins });
            setToggleState_(toggle, granted);
        } catch (err) {
            console.error(`[Providers] Error checking ${providerId}:`, err);
        }
    }));
}

/** @private */
function setToggleState_(toggle, checked) {
    checked ? toggle.setAttribute('checked', '') : toggle.removeAttribute('checked');
}

/**
 * Solicita o revoca los orígenes del proveedor.
 * @private
 */
function handleProviderToggle_(providerId, toggle, checked) {
    const provider = AI_PROVIDER_ORIGINS[providerId];
    if (!provider) return;

    // La llamada se hace de forma síncrona en el handler para conservar el gesto
    const request = checked
        ? chrome.permissions.request({ origins: provider.origins })
        : chrome.permissions.remove({ origins: provider.origins });

    request
        .then((ok) => {
            // Éxito sin toast (el switch ya lo refleja); solo se avisa de errores.
            if (ok) return;
            setToggleState_(toggle, !checked);
            Toast.show(tr('toastProviderDenied', 'Permission not changed: $1', [provider.label]), 'error');
        })
        .catch((err) => {
            console.error(`[Providers] Permission error for ${providerId}:`, err);
            setToggleState_(toggle, !checked);
            Toast.show(tr('toastProviderError', 'Could not update access for $1', [provider.label]), 'error');
        });
}
