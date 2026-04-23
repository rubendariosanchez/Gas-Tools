# AGENTS.md

## Propósito del proyecto
Extensión de Chrome (Manifest V3) para potenciar el IDE de Google Apps Script con:
- ajustes avanzados de editor Monaco
- snippets personalizados y de sistema
- temas (predefinidos y personalizados)
- utilidades de UI en el editor (ej. búsqueda avanzada)

El proyecto no usa build step: se trabaja directamente sobre archivos fuente.

## Stack y restricciones
- JavaScript ES Modules (sin TypeScript)
- Web Components para UI del popup y del editor inyectado
- `chrome.runtime`, `chrome.storage.sync`, `declarativeContent`
- IndexedDB para datos locales (`snippets`, `themes`, `settings`)
- Sin framework frontend
- Sin tests automatizados ni linter configurado en repo

## Estructura principal del repo
- `manifest.json`: configuración MV3, permisos, content scripts, popup y recursos expuestos.
- `extension/background.js`: service worker; centraliza mensajería y sincronización entre popup/content script.
- `extension/js/mainFunctions.js`: content script puente (mundo aislado) que inyecta scripts al `MAIN` world y reenvía eventos.
- `extension/js/gasTools.js`: lógica principal aplicada al Monaco editor de GAS (settings, snippets, tema, UI extra).
- `extension/js/domUtils.js`: utilidades DOM para inyección segura y delegación.
- `extension/js/components/`: web components usados dentro del editor inyectado.
- `src/html/index.html`: popup principal de la extensión.
- `src/js/app.js`: entrypoint del popup; orquesta módulos.
- `src/js/modules/`: módulos del popup (`settings`, `snippets`, `themes`, `ui`).
- `src/components/`: web components del popup (`option-toggle`, `snippet-card`, `theme-card`, modales).
- `src/js/utils/`: utilidades compartidas (`Storage`, `Variables`, `Notify`, etc.).
- `themes/*.json`: definiciones de temas Monaco empaquetadas.
- `resources/icons/`: íconos de la extensión.

## Flujo funcional (alto nivel)
1. El popup (`src/js/app.js`) administra configuración y catálogos de snippets/temas.
2. El popup guarda en IndexedDB y notifica cambios con `chrome.runtime.sendMessage`.
3. `background.js` recibe `NOTIFY_UPDATE` y reenvía `SETTINGS_UPDATED` al tab activo.
4. `mainFunctions.js` escucha ese mensaje, pide datos frescos al background y los reexpone al mundo de página con `CustomEvent`.
5. `gasTools.js` consume esos eventos y aplica cambios al editor Monaco en vivo.

## Persistencia de datos
- IndexedDB (vía `src/js/utils/Storage.js`):
  - `settings`: documento raíz con `id = G_PROPERTY_NAME`
  - `snippets`: snippets de usuario
  - `themes`: temas personalizados
- `chrome.storage.sync`:
  - metadatos de configuración global
  - tema activo (`themes.active`)

Regla práctica: catálogo y contenido pesado en IndexedDB; estado global/sincronizable en `chrome.storage.sync`.

## Convenciones de desarrollo
- Mantener ES modules y separación por responsabilidades (popup vs content script vs injected script).
- Evitar lógica monolítica en `app.js`; agregar comportamiento en `src/js/modules/*`.
- Mantener los Web Components autocontenidos (template/eventos internos).
- Reutilizar `DB` singleton en vez de crear nuevas capas de storage.
- Para notificar cambios al editor, usar siempre `notifyEditors(updateType)`.
- Mantener nombres de `message.type` y `CustomEvent` consistentes con los ya existentes:
  - `GET_SETTINGS`, `GET_SNIPPETS`, `GET_ACTIVE_THEME`, `NOTIFY_UPDATE`, `SETTINGS_UPDATED`
  - `GAS_TransferData`, `GAS_SettingsUpdated`, `GAS_DataUpdated`

## Guía para cambios comunes
### Nueva opción de configuración (toggle)
1. Agregar default en `DEFAULT_SETTINGS_OPTIONS` (`src/js/utils/Variables.js`).
2. Agregar el `option-toggle` en `src/html/index.html`.
3. Incluir el id en `optionIds` de `src/js/modules/settings.js`.
4. Aplicar el comportamiento en `GasCustomEditor.applySettings()` (`extension/js/gasTools.js`).
5. Validar guardado, reset y actualización en tiempo real.

### Nuevo snippet de sistema
1. Agregar entrada en `DEFAULT_SNIPPETS` (`src/js/utils/Variables.js`).
2. Verificar visibilidad en pestaña `Default` del popup.
3. Confirmar carga en editor con toggle `load-snippets`.

### Nuevo tema
- Sistema: agregar JSON en `themes/` y entrada en `THEME_LIST`.
- Personalizado: se crea desde `ThemeModal`, persiste en IndexedDB y se notifica con `notifyEditors('themes')`.

## Ejecución local
1. Ir a `chrome://extensions/`
2. Activar `Developer mode`
3. `Load unpacked` sobre la carpeta raíz del repo
4. Abrir un proyecto en `https://script.google.com/home/projects/*/edit*`
5. Probar popup y cambios en editor

## Verificación manual mínima (antes de release)
- La extensión aparece y funciona solo en URLs de GAS editor.
- Toggle `Enable extension` enciende/apaga efectos sin recargar pestaña.
- Guardar/reset de opciones funciona y persiste.
- Snippets custom: crear/editar/eliminar + reflejo en Monaco.
- Temas: seleccionar/duplicar/editar/eliminar custom + aplicación inmediata.
- Popup fuera del editor GAS muestra pantalla informativa (sin inicializar módulos pesados).

## Empaquetado y publicación
1. Incrementar versión en `manifest.json`.
2. Comprimir el contenido de la raíz (no la carpeta contenedora).
3. Subir zip al panel de Chrome Web Store.

## Notas para agentes/colaboradores
- Evitar refactors amplios sin necesidad en `extension/js/gasTools.js` (archivo crítico de runtime).
- Si se añaden nuevos mensajes entre capas, actualizar simultáneamente:
  - popup/utils que emiten
  - `background.js`
  - `mainFunctions.js`
  - listener en `gasTools.js`
- No introducir herramientas de build/lint sin acordarlo explícitamente con el mantenedor.