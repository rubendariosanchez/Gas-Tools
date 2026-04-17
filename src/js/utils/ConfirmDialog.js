// Exportamos el componente de alerta
export function ConfirmDialog(message) {

  // Devolvemos una promesa que se resolverá con true/false según la elección del usuario
  return new Promise(resolve => {
    const modal = document.getElementById('qc__confirm');
    const text = document.getElementById('qc__confirm-text');
    const ok = document.getElementById('qc__confirm-ok');
    const cancel = document.getElementById('qc__confirm-cancel');

    text.textContent = message;
    modal.classList.remove('hidden');

    const clean = () => {
      modal.classList.add('hidden');
      ok.onclick = null;
      cancel.onclick = null;
    };

    ok.onclick = () => {
      clean();
      resolve(true);
    };

    cancel.onclick = () => {
      clean();
      resolve(false);
    };
  });
}