// Exportamos el componente de alerta
export function ConfirmDialog(message) {

  // Devolvemos una promesa que se resolverá con true/false según la elección del usuario
  return new Promise(resolve => {
    const modal = document.getElementById('qc__confirm');
    const text = document.getElementById('qc__confirm-text');
    const ok = document.getElementById('qc__confirm-ok');
    const cancel = document.getElementById('qc__confirm-cancel');
    const previousFocus = document.activeElement;

    text.textContent = message;
    modal.classList.remove('hidden');
    cancel.focus(); // Foco en la opción segura

    const finish = (result) => {
      modal.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
      document.removeEventListener('keydown', onKeydown, true);
      previousFocus?.focus?.();
      resolve(result);
    };

    /** Escape cancela; Tab y Shift+Tab no salen del diálogo. */
    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const first = cancel;
      const last = ok;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !modal.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeydown, true);
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
  });
}
