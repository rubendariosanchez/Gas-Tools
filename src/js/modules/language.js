/**
 * @fileoverview Selector de idioma (EN/ES) de la cabecera del popup.
 *
 * - Fuente de verdad: opción `ui-language` en IndexedDB (igual que el resto
 *   de settings, así llega al editor vía `notifyEditors`).
 * - Espejo en localStorage para que el popup arranque ya traducido sin
 *   esperar a IndexedDB.
 * - Al cambiar, el popup se recarga (instantáneo y consistente con todos
 *   los componentes ya pintados). Los paneles del editor toman el idioma
 *   al recargar la pestaña de Apps Script.
 */

import { DB } from '../utils/Storage.js';
import { G_PROPERTY_NAME } from '../utils/Variables.js';
import { Toast } from '../utils/Toast.js';
import { tr, normalizeLanguage, storeLanguage } from '../utils/I18n.js';
import { saveSingleOption_ } from './settings.js';

// Bandera de sessionStorage para mostrar el aviso tras recargar el popup.
const CHANGED_FLAG = 'gasToolsUiLanguageChanged';

/**
 * Inicializa el selector. Debe llamarse también cuando el popup se abre
 * fuera del editor (allí solo afecta al popup).
 * @param {string} currentLang Idioma con el que se tradujo el popup.
 */
export function initLanguageModule(currentLang) {
    const trigger = document.getElementById('uiLanguageTrigger');
    const menu    = document.getElementById('uiLanguageMenu');
    const code    = document.getElementById('uiLanguageCode');
    if (!trigger || !menu) return;

    const options = [...menu.querySelectorAll('.qc__lang-option')];
    let activeIdx = 0;

    // Estado inicial: código visible y opción marcada.
    if (code) code.textContent = currentLang.toUpperCase();
    options.forEach((opt, i) => {
        const selected = opt.dataset.value === currentLang;
        opt.setAttribute('aria-selected', String(selected));
        if (selected) activeIdx = i;
    });

    const setActive_ = (idx) => {
        activeIdx = (idx + options.length) % options.length;
        options.forEach((opt, i) => opt.classList.toggle('qc__lang-option--active', i === activeIdx));
    };

    const open_ = () => {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        setActive_(options.findIndex((o) => o.getAttribute('aria-selected') === 'true'));
        menu.focus();
    };

    const close_ = (focusTrigger = false) => {
        if (menu.hidden) return;
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (focusTrigger) trigger.focus();
    };

    const choose_ = (value) => {
        close_(true);
        if (value && value !== currentLang) changeLanguage_(value);
    };

    // Clic en cualquier parte del botón (icono, código o flecha) abre/cierra.
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden ? open_() : close_();
    });

    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            open_();
        }
    });

    menu.addEventListener('click', (e) => {
        const opt = e.target.closest('.qc__lang-option');
        if (opt) choose_(opt.dataset.value);
    });

    menu.addEventListener('mousemove', (e) => {
        const idx = options.indexOf(e.target.closest('.qc__lang-option'));
        if (idx !== -1 && idx !== activeIdx) setActive_(idx);
    });

    menu.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive_(activeIdx + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive_(activeIdx - 1); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose_(options[activeIdx]?.dataset.value); }
        else if (e.key === 'Escape' || e.key === 'Tab') { close_(e.key === 'Escape'); }
    });

    // Cerrar al hacer clic fuera.
    document.addEventListener('click', (e) => {
        if (!menu.hidden && !e.target.closest('#uiLanguage')) close_();
    });

    showPendingNotice_();
    syncWithDatabase_(currentLang);
}

/** Persiste el idioma elegido y recarga el popup. */
async function changeLanguage_(value) {
    const lang = normalizeLanguage(value);
    storeLanguage(lang);
    try {
        await saveSingleOption_('ui-language', lang);
    } catch (err) {
        console.error('[Language] No se pudo guardar el idioma:', err);
    }
    try { sessionStorage.setItem(CHANGED_FLAG, '1'); } catch (_) { /* noop */ }
    location.reload();
}

/** Muestra el aviso de "recarga Apps Script" después del cambio. */
function showPendingNotice_() {
    try {
        if (sessionStorage.getItem(CHANGED_FLAG) !== '1') return;
        sessionStorage.removeItem(CHANGED_FLAG);
    } catch (_) {
        return;
    }
    Toast.show(
        tr('toastLanguageChanged', 'Language updated. Reload the Apps Script tab to apply it in the editor.'),
        'success',
        4000
    );
}

/**
 * Si IndexedDB tiene otro idioma (p. ej. localStorage borrado o cambio desde
 * otro perfil), lo adopta y recarga una sola vez.
 */
async function syncWithDatabase_(currentLang) {
    try {
        const data = await DB.get('settings', G_PROPERTY_NAME);
        const dbLang = data?.options?.['ui-language'];
        if (!dbLang) return;
        const lang = normalizeLanguage(dbLang);
        if (lang === currentLang) return;
        // Tras guardar en localStorage, la recarga arranca ya con `lang`,
        // así que no puede entrar en bucle.
        storeLanguage(lang);
        location.reload();
    } catch (_) { /* sin DB: se mantiene el idioma local */ }
}
