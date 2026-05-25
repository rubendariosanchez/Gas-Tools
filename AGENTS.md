# AGENTS.md

## Propósito
Extensión Chrome (MV3) para mejorar el editor de Google Apps Script. Objetivo: implementar cambios sin romper el flujo popup → background → content script → injected (MAIN world).

## Stack
- JS ES Modules, Web Components, Chrome APIs (runtime, storage, tabs).
- IndexedDB (settings, snippets, themes) + `chrome.storage.sync`.
- Sin build step, sin transpilación, sin tests automáticos.
- Trusted Types: usar `DomUtils.setHTML` en vez de `innerHTML`.

## Arquitectura (4 capas)
| Capa            | Archivo principal                                   | Rol                                                    |
|-----------------|-----------------------------------------------------|--------------------------------------------------------|
| Popup UI        | `src/html/index.html`, `src/js/app.js`              | Configuración del usuario.                             |
| Background      | `extension/background.js`                           | Service worker: chrome.storage + proxy a LLMs.         |
| Content script  | `extension/js/main-functions.js`                    | Bridge `chrome.runtime` ↔ `CustomEvent`.               |
| Injected (MAIN) | `extension/js/gas-tools-main.js`, `gas-tools.js`    | Modifica Monaco (`window.jsWireMonacoEditor`).         |

## Flujo de datos
1. Popup guarda en IndexedDB.
2. `notifyEditors(updateType)` solicita propagación.
3. Background reenvía `SETTINGS_UPDATED` / `DATA_UPDATED` al content script.
4. Content script dispara `GAS_SettingsUpdated` o `GAS_DataUpdated`.
5. `gas-tools.js` aplica los cambios live sin recargar.

## Contratos (NO romper)
- **Mensajes (chrome.runtime):** `GET_SETTINGS`, `GET_SNIPPETS`, `GET_ACTIVE_THEME`, `NOTIFY_UPDATE`, `SETTINGS_UPDATED`, `LLM_REQUEST`, `LLM_GET_CONFIG`, `LLM_SAVE_CONFIG`.
- **CustomEvents (DOM):** `GAS_TransferData`, `GAS_SettingsUpdated`, `GAS_DataUpdated`, `GAS_HidePanels`, `GAS_GlobalEnable`, `GAS_GlobalDisable`, `GAS_LLM_REQUEST`, `GAS_LLM_RESPONSE`, `GAS_LLM_GET_CONFIG`, `GAS_LLM_CONFIG_RESULT`, `GAS_LLM_SAVE_CONFIG`.

## Persistencia
- **IndexedDB:** settings completos, snippets, themes (catálogos grandes).
- **chrome.storage.sync:** tema activo, toggle global, API keys de LLM.

## Convenciones
- Comentarios en español; código en inglés.
- Reutilizar el singleton `DB` (`src/js/utils/Storage.js`).
- Funciones internas con sufijo `_` (ej. `_loadSnippets_`).
- Variables, parámetros, funciones, clases y CustomEvents en inglés (sin mezcla ES/EN en identificadores).
- JSDoc breve en español, solo cuando aporte contexto real.
- Una responsabilidad por archivo. Evitar variantes "copy", "old", "backup" en rutas activas (mover al subdirectorio `backup/` solo durante migraciones puntuales). Chrome rechaza carpetas que empiezan con `_`, así que no se debe usar ese prefijo dentro del paquete de la extensión.
- Clases CSS de la UI inyectada con prefijo `qc__` para evitar colisiones con GAS.

## Inventario de la UI inyectada
- **Popup (`src/`):** `OptionToggle`, `OptionSelect`, `OptionColor`, `SnippetCard`, `SnippetModal`, `ThemeCard`, `ThemeModal`.
- **Editor (`extension/js/components/`):** `gas-search-panel`, `gas-chat-panel`, `gas-current-file`.
- **Servicios (`extension/js/services/`):** `dom-utils`, `gas-ai-autocomplete`, `gas-error-lens`, `gas-folders`, `llm-providers`.
- **Templates (`extension/html/`):** `searchButton.html`, `chatButton.html`, `currentFileButton.html`, `sidepanel.html`.

## Reglas de calidad mínima por componente
- API pública mínima (`open` / `close` / `toggle` / `setEditor` / `refresh` cuando aplique).
- Listeners globales registrados deben removerse en `disconnectedCallback` o en el teardown correspondiente.
- Evitar `innerHTML` directo: usar `DomUtils.setHTML`.
- Logs de depuración solo en flujos de error/estado, no en cada keystroke.
- Reutilizar helpers (`_injectToolbarButton_`, `_teardownToolbarUi_`, `_bindGlobalShortcut_`, `_bindMonacoShortcut_` en `gas-tools.js`) en vez de duplicar lógica.

## Patrón para nuevas opciones
1. Default en `DEFAULT_SETTINGS_OPTIONS` (`src/js/utils/Variables.js`).
2. `<option-toggle>` o `<option-select>` en `src/html/index.html`.
3. ID en lista de `src/js/modules/settings.js`.
4. Comportamiento en `applySettings()` de `gas-tools.js`.
5. Notificar (`notifyEditors`) y validar live.

## Verificación manual
- Popup funciona dentro y fuera del editor de GAS.
- Enable/disable global no rompe la sesión.
- Save/Reset persiste correctamente.
- Snippets: crear, editar, eliminar y verificar autocompletado en Monaco.
- Temas: seleccionar, duplicar, editar, eliminar y aplicación inmediata.
- Error Lens detecta errores reales y no genera falsos positivos en jQuery, regex literals, template strings ni objetos literales.
- Indicador de archivo activo muestra el nombre correcto al navegar entre archivos.
- Sin errores ni warnings inesperados en consola.

## Anti-patrones
- Saltar el background (popup → injected directo).
- Duplicar providers de Monaco al re-inicializar (proteger con flag estático `providersRegistered`).
- Cambiar contratos sin actualizar todas las capas.
- Modificar nodos de la `c-wiz` no activa de GAS (filtrar siempre con `c-wiz[data-p][aria-busy="false"]`).
- Reutilizar clases nativas de GAS (`jsaction`, `jscontroller`) sin replicar el cableado completo del HTML; preferir HTML del recurso (`extension/html/*.html`).

## Créditos a respetar al editar archivos relevantes
- `themes/*.json` provienen de [JeanRemiDelteil/appsScriptColor](https://github.com/JeanRemiDelteil/appsScriptColor). No reescribir ni renombrar sin documentar el cambio.
- `extension/js/services/gas-error-lens.js` se inspira en [usernamehw/vscode-error-lens](https://github.com/usernamehw/vscode-error-lens). Mantener la atribución en el README.
