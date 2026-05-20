"use strict";
/**
 * @fileoverview Bootstrap del editor personalizado para Google Apps Script.
 * Este archivo se inyecta en el mundo MAIN después de `gas-tools.js` (que
 * define la clase {@link GasCustomEditor}). Aquí no hay clases; solo se
 * orquesta:
 *
 *   1. Singleton guard: evita doble inicialización en navegación SPA.
 *   2. Detección de Monaco: observa el DOM hasta encontrar `jsWireMonacoEditor`.
 *   3. Recepción de datos del content script (`GAS_TransferData`) y
 *      creación o actualización del singleton de `GasCustomEditor`.
 *   4. Reenvío de cambios del popup (`GAS_SettingsUpdated`, `GAS_DataUpdated`).
 *   5. Manejo de habilitación/deshabilitación global (`GAS_GlobalEnable/Disable`).
 *
 * Todo lo referenciado desde aquí (clase, eventos) vive en otros archivos;
 * este orquestador es simple a propósito para que sea fácil leer el flujo
 * de inicialización de un vistazo.
 */
;(() => {
  if (window.__gasToolsInit) return;
  window.__gasToolsInit = true;

  // ── Constantes de eventos compartidos con main-functions.js ────────────
  const GAS_EVENTS = {
    TRANSFER_DATA:    'GAS_TransferData',
    SETTINGS_UPDATED: 'GAS_SettingsUpdated',
    DATA_UPDATED:     'GAS_DataUpdated',
    GLOBAL_DISABLE:   'GAS_GlobalDisable',
    GLOBAL_ENABLE:    'GAS_GlobalEnable',
  };

  // ── Estado mínimo del bootstrap ────────────────────────────────────────
  // `G_GLOBALLY_DISABLED` se expone también en `window.__gasGloballyDisabled`
  // para que la clase `GasCustomEditor` (definida en otro archivo) pueda
  // leerlo sin depender de variables del IIFE.
  let G_GLOBALLY_DISABLED  = false;
  let G_MONACO_READY       = false;
  /** @type {InstanceType<typeof GasCustomEditor>|null} */
  let G_GAS_TOOLS_INSTANCE = null;

  /** Sincroniza la bandera global con el flag expuesto en window. */
  const syncDisabledFlag = (value) => {
    G_GLOBALLY_DISABLED        = value;
    window.__gasGloballyDisabled = value;
  };
  syncDisabledFlag(false);

  // Cola de payloads `GAS_TransferData` que llegan mientras hay una
  // inicialización en curso, para no perderlos.
  const G_PENDING_QUEUE = [];

  // Referencias a los listeners (para poder removerlos si fuera necesario).
  const _listeners = {};

  // ─────────────────────────────────────────────────────────────────────
  // Detección de Monaco
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Marca Monaco como listo y arranca la inicialización si ya hay datos
   * pendientes. Se invoca tanto sincrónicamente (caché caliente) como desde
   * el MutationObserver (Monaco aparece tras montar el DOM).
   */
  function markMonacoReady_() {
    if (G_MONACO_READY) {
      // Ya estaba listo, pero puede haber datos pendientes tras navegación SPA.
      if (window._PENDING_GAS_DATA && window.jsWireMonacoEditor) {
        initializeEditor_(window._PENDING_GAS_DATA);
      }
      return;
    }
    G_MONACO_READY = true;
    if (window._PENDING_GAS_DATA) {
      initializeEditor_(window._PENDING_GAS_DATA);
    }
  }

  // Observa el DOM hasta detectar la aparición de Monaco.
  const G_MAIN_OBSERVER = new MutationObserver(() => {
    if (!window.jsWireMonacoEditor) return;
    G_MAIN_OBSERVER.disconnect();   // Monaco ya encontrado; el observer ya no es necesario.
    markMonacoReady_();
  });

  // Caso "caché caliente": Monaco ya estaba en window cuando este script
  // se evaluó. En ese caso el observer no se dispararía nunca.
  if (window.jsWireMonacoEditor) {
    markMonacoReady_();
  } else {
    G_MAIN_OBSERVER.observe(document.body, { childList: true, subtree: true });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Espera del contenedor raíz del editor (c-wiz)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Espera a que exista un `c-wiz[data-p]` completamente activo en el DOM
   * antes de invocar el callback. Estrategia en tres capas para tolerar
   * todas las variantes de carga de GAS:
   *
   *  1. Snapshot inmediato: si el elemento ya está listo, resolvemos sin
   *     crear ningún observer ni intervalo.
   *  2. MutationObserver: escucha `childList`, `subtree` y cambios de
   *     atributos para detectar tanto la inserción del nodo como el cambio
   *     de `aria-busy` de "true" a "false".
   *  3. Polling de respaldo cada 300 ms: cubre casos donde el observer no
   *     se dispara (p.ej. GAS muta nodos fuera de `document.body`).
   *
   * Un `c-wiz[data-p]` se considera "activo" cuando:
   *   - Es el único presente en el DOM y su `aria-busy` no es "true", o
   *   - Hay varios y su `aria-busy` es explícitamente "false".
   *
   * Invoca el callback con `null` tras 30 s si no se encontró ninguno, para
   * no bloquear indefinidamente; `initializeEditor_` descartará la instancia
   * y esperará al siguiente `GAS_TransferData`.
   *
   * @param {(cwiz: HTMLElement|null) => void} callback  Se ejecuta exactamente una vez.
   * @private
   */
  function waitForCwiz_(callback) {
    let done      = false;
    let observer  = null;
    let pollId    = 0;
    let timeoutId = 0;

    /**
     * Cancela todos los mecanismos de espera e invoca el callback.
     * La guardia `done` garantiza que se ejecute una sola vez.
     * @param {HTMLElement|null} cwiz
     */
    const finish_ = (cwiz) => {
      if (done) return;
      done = true;
      if (observer)  observer.disconnect();
      if (pollId)    clearInterval(pollId);
      if (timeoutId) clearTimeout(timeoutId);
      callback(cwiz);
    };

    /**
     * Evalúa el estado actual del DOM.
     * Devuelve `true` (y llama a `finish_`) si encontró un contenedor válido.
     * @returns {boolean}
     */
    const resolve_ = () => {
      const containers = document.querySelectorAll('c-wiz[data-p]');

      // Un único contenedor: válido solo si no está ocupado NI oculto.
      if (
        containers.length === 1 &&
        containers[0].getAttribute('aria-busy') !== 'true' &&
        containers[0].getAttribute('aria-hidden') !== 'true'
      ) {
        finish_(containers[0]);
        return true;
      }

      // Varios contenedores: el activo no tiene aria-busy="true" ni aria-hidden="true".
      const active = document.querySelector(
        'c-wiz[data-p]:not([aria-hidden="true"]):not([aria-busy="true"])'
      );
      if (active) {
        finish_(active);
        return true;
      }

      return false;
    };

    // Capa 1: snapshot inmediato; si ya está listo no creamos nada más.
    if (resolve_()) return;

    // Capa 2: MutationObserver sin `attributeFilter` para capturar tanto
    // inserciones de nodos como cambios de `aria-busy` y `data-p`.
    observer = new MutationObserver(() => resolve_());
    observer.observe(document.body, {
      childList:  true,
      subtree:    true,
      attributes: true,
    });

    // Capa 3: polling de respaldo cada 300 ms.
    pollId = setInterval(() => resolve_(), 300);

    // Timeout duro a 30 s: resuelve con `null` para liberar el bootstrap.
    timeoutId = setTimeout(() => finish_(null), 30_000);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Recepción de datos del content script
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Procesa un payload de `GAS_TransferData`. Si hay otra inicialización
   * en curso, encola el payload para reproducirlo después.
   * @param {Object} data
   */
  function processTransferData_(data) {
    if (window.__gasToolsBusy) {
      G_PENDING_QUEUE.push(data);
      return;
    }
    window._PENDING_GAS_DATA = data;
    if (window.jsWireMonacoEditor) {
      if (!G_MONACO_READY) markMonacoReady_();
      initializeEditor_(data);
    } else if (!window._gasSpaPollInterval) {
      // Polling defensivo por si Monaco aún no está disponible.
      window._gasSpaPollInterval = setInterval(() => {
        if (window._PENDING_GAS_DATA && window.jsWireMonacoEditor) {
          clearInterval(window._gasSpaPollInterval);
          window._gasSpaPollInterval = null;
          markMonacoReady_();
        }
      }, 300);
      // Límite de 60 s: evita que el intervalo quede vivo indefinidamente
      // si Monaco nunca aparece (pestaña en segundo plano, carga fallida…).
      setTimeout(() => {
        if (window._gasSpaPollInterval) {
          clearInterval(window._gasSpaPollInterval);
          window._gasSpaPollInterval = null;
        }
      }, 60_000);
    }
  }

  /**
   * Crea o actualiza la instancia singleton de `GasCustomEditor` con los
   * datos recibidos. Si la extensión está deshabilitada globalmente no hace
   * nada. Al terminar —tanto por la vía síncrona como por el callback de
   * `waitForCwiz_`— llama a `release_()` para limpiar el flag `busy` y
   * drenar la cola de payloads pendientes.
   *
   * Flujos de salida:
   *   A) Deshabilitado globalmente   → release_() inmediato.
   *   B) Instancia ya existe         → mergeAndReinit + release_() inmediato.
   *   C) Primera inicialización      → espera c-wiz, init(cwiz), release_()
   *                                    dentro del callback de waitForCwiz_.
   *   D) Error en construcción       → release_() en catch.
   *
   * @param {Object} data
   */
  function initializeEditor_(data) {
    window.__gasToolsBusy = true;

    /**
     * Libera el flag `busy` y procesa el siguiente payload de la cola,
     * si lo hay. Se llama desde todos los caminos de salida de esta función.
     */
    const release_ = () => {
      window.__gasToolsBusy = false;
      if (G_PENDING_QUEUE.length) {
        processTransferData_(G_PENDING_QUEUE.shift());
      }
    };

    // Flujo A: extensión deshabilitada globalmente.
    if (G_GLOBALLY_DISABLED) {
      window._PENDING_GAS_DATA = null;
      release_();
      return;
    }

    // Limpiamos el polling de Monaco si seguía activo.
    if (window._gasSpaPollInterval) {
      clearInterval(window._gasSpaPollInterval);
      window._gasSpaPollInterval = null;
    }

    // Flujo B: la instancia ya existe; solo actualizamos su estado.
    if (G_GAS_TOOLS_INSTANCE) {
      try {
        G_GAS_TOOLS_INSTANCE.mergeAndReinit(data);
        window._PENDING_GAS_DATA = null;
      } catch (e) {
        console.error('[GASTools] mergeAndReinit falló:', e);
      }
      release_();
      return;
    }

    // Flujo C: primera inicialización.
    try {
      G_GAS_TOOLS_INSTANCE = new GasCustomEditor(data);
      window._PENDING_GAS_DATA = null;
    } catch (e) {
      console.error('[GASTools] No se pudo construir GasCustomEditor:', e);
      release_();
      return;
    }

    // Esperamos a que el contenedor `c-wiz[data-p]` esté listo para pasar
    // la referencia directamente a `init()` y evitar que la clase tenga que
    // buscarlo de nuevo. Si transcurren 30 s sin encontrarlo, descartamos la
    // instancia y dejamos que el próximo `GAS_TransferData` reintente.
    waitForCwiz_((cwiz) => {
      if (!cwiz) {
        console.warn('[GASTools] c-wiz no encontrado tras 30 s; abortando inicialización.');
        G_GAS_TOOLS_INSTANCE = null;
        release_();
        return;
      }
      try {
        // `init` recibe el elemento ya localizado para que la clase lo
        // establezca internamente sin repetir la búsqueda en el DOM.
        G_GAS_TOOLS_INSTANCE.init(cwiz);
      } catch (e) {
        console.error('[GASTools] init() falló:', e);
        G_GAS_TOOLS_INSTANCE = null;
      }
      release_();
    });
    // ⚠ No llamar release_() aquí: el callback asíncrono de waitForCwiz_
    //   es el único responsable de liberarlo en el flujo C.
  }

  // ─────────────────────────────────────────────────────────────────────
  // Listeners de eventos del bridge
  // ─────────────────────────────────────────────────────────────────────

  // Habilitación / deshabilitación global de la extensión.
  _listeners.onGlobalEnable = () => syncDisabledFlag(false);
  document.addEventListener(GAS_EVENTS.GLOBAL_ENABLE, _listeners.onGlobalEnable);

  _listeners.onGlobalDisable = () => syncDisabledFlag(true);
  document.addEventListener(GAS_EVENTS.GLOBAL_DISABLE, _listeners.onGlobalDisable);

  // Cierre de paneles flotantes ante navegación SPA fuera del editor.
  _listeners.onHidePanels = () => {
    document.querySelector('gas-search-panel')?.close?.();
    document.querySelector('gas-chat-panel')?.close?.();
  };
  document.addEventListener('GAS_HidePanels', _listeners.onHidePanels);

  // Vuelta al editor desde otra subruta (Ejecuciones, Despliegues, etc.).
  // Pedimos a la instancia que recapture el modelo principal: cuando el
  // usuario regresa, GAS abre por defecto el archivo "principal" del
  // proyecto, así que ese es el momento natural para refrescar el ancla.
  //
  // Nota: el evento puede llegar ANTES de que la nueva instancia esté
  // lista (la limpieza de `data-gasreference` en el content script
  // dispara `GAS_TransferData` y ese flujo crea la instancia con un
  // pequeño delay). Para no perderlo, marcamos un flag que será leído
  // por `mergeAndReinit` / `init` cuando la instancia esté disponible.
  _listeners.onReturnToEditor = () => {    
    window.__gasReturnPending = true;
    G_GAS_TOOLS_INSTANCE?.refreshInitialModel?.();

    // Disparar Ctrl+S para que GAS guarde antes de recargar
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));

    // Dar tiempo a GAS para procesar el guardado antes de recargar
    setTimeout(() => window.location.reload(), 1000);
  };
  document.addEventListener('GAS_ReturnToEditor', _listeners.onReturnToEditor);

  // Datos iniciales del editor (settings, snippets, tema, botones).
  _listeners.onTransferData = (e) => {
    try {
      processTransferData_(JSON.parse(e.detail));
    } catch (_) { /* payload inválido; se descarta silenciosamente */ }
  };
  document.addEventListener(GAS_EVENTS.TRANSFER_DATA, _listeners.onTransferData);

  // Cambios de settings desde el popup.
  _listeners.onSettingsUpdated = (e) => {
    try {
      const options = JSON.parse(e.detail);
      if ('global-enable' in options) {
        const isEnabled = options['global-enable'];
        syncDisabledFlag(!isEnabled);
        if (!isEnabled) {
          G_GAS_TOOLS_INSTANCE?.disable();
          return;
        }
        if (G_GAS_TOOLS_INSTANCE) {
          G_GAS_TOOLS_INSTANCE.enable();
        } else if (window._PENDING_GAS_DATA) {
          initializeEditor_(window._PENDING_GAS_DATA);
        }
      }
      if (!G_GAS_TOOLS_INSTANCE) return;
      G_GAS_TOOLS_INSTANCE.updateSettings(options);
    } catch (_) { /* payload inválido; se descarta silenciosamente */ }
  };
  document.addEventListener(GAS_EVENTS.SETTINGS_UPDATED, _listeners.onSettingsUpdated);

  // Actualizaciones de snippets o tema activo desde el popup.
  _listeners.onDataUpdated = (e) => {
    try {
      const { updateType, data } = JSON.parse(e.detail);
      if (!G_GAS_TOOLS_INSTANCE) return;
      if (updateType === 'snippets') G_GAS_TOOLS_INSTANCE.updateSnippets(data);
      if (updateType === 'themes')   G_GAS_TOOLS_INSTANCE.updateTheme(data);
    } catch (_) { /* payload inválido; se descarta silenciosamente */ }
  };
  document.addEventListener(GAS_EVENTS.DATA_UPDATED, _listeners.onDataUpdated);
})();