// Creamos la clase para el manejo de toasts (notificaciones temporales)
export const Toast = {

  /**
   * 
   * Mostramos el respectivo mensaje
   */
  show(message, type = 'info', duration = 2500) {
    const container = document.getElementById('qc__toast-container');

    const toast = document.createElement('div');
    toast.className = `qc__toast qc__toast--${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, duration);
  }

};