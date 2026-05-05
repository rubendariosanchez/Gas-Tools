# AGENTS.md

## Propósito
Extensión Chrome (MV3) para mejorar el editor de Google Apps Script. Objetivo: implementar cambios sin romper el flujo popup → background → content script → injected script.

## Stack
- JS ES Modules, Web Components, Chrome APIs (runtime, storage, tabs)
- IndexedDB (settings, snippets, themes) + chrome.storage.sync
- Sin build step ni tests

## Arquitectura (4 capas)
| Capa | Archivo | Rol |
|------|---------|-----|
| Popup UI | `src/html/index.html`, `src/js/app.js` | UI y configuración |
| Background | `extension/background.js` | Messenger centralizado |
| Content script | `extension/js/mainFunctions.js` | Bridge: runtime → CustomEvent |
| Injected | `extension/js/gasTools.js` | Aplica cambios al Monaco |

## Flujo de datos
1. Popup guarda en IndexedDB → 2. `notifyEditors(updateType)` → 3. Background reenvía `SETTINGS_UPDATED` → 4. Content script dispara `GAS_SettingsUpdated`/`GAS_DataUpdated` → 5. gasTools.js aplica cambios live.

## Contratos (NO romper)
- Mensajes: `GET_SETTINGS`, `GET_SNIPPETS`, `GET_ACTIVE_THEME`, `NOTIFY_UPDATE`, `SETTINGS_UPDATED`
- Eventos: `GAS_TransferData`, `GAS_SettingsUpdated`, `GAS_DataUpdated`

## Persistencia
- IndexedDB: settings, snippets, themes (catálogos grandes)
- chrome.storage.sync: estado global sincronizable (tema activo)

## Convenciones
- Comentarios en español, código en inglés
- Reutilizar singleton `DB` (`src/js/utils/Storage.js`)
- Funciones internas con sufijo `_` (ej: `loadSnippets_`)
- Variables, parámetros, funciones, clases y CustomEvents en inglés (evitar mezcla ES/EN en identificadores)
- Comentarios de funciones en formato JSDoc corto, en español, solo cuando aporten contexto real
- Mantener una responsabilidad por archivo/módulo (evitar archivos "copy", "old" o variantes temporales en rutas activas)

## Componentes clave (inventario rápido)
- Popup: `src/components/OptionToggle.js`, `src/components/SnippetCard.js`, `src/components/SnippetModal.js`, `src/components/ThemeCard.js`, `src/components/ThemeModal.js`
- Injected UI: `extension/js/components/gas-search-panel.js`, `extension/js/components/gas-chat-panel.js`
- Utilidades de DOM: `extension/js/domUtils.js`

## Reglas de calidad mínima por componente
- Exponer API pública mínima (`open/close/toggle/setEditor` cuando aplique)
- Limpiar listeners globales en `disconnectedCallback` para evitar memory leaks
- Evitar `innerHTML` directo: usar `DomUtils.setHTML`
- Evitar logs de depuración excesivos en flujo normal (dejar solo logs útiles de error/estado)
- Evitar duplicar lógica entre popup/background/content/injected; extraer helper cuando se repita

## Patrón para nuevas opciones
1. Default en `DEFAULT_SETTINGS_OPTIONS` (`src/js/utils/Variables.js`)
2. `<option-toggle>` en `src/html/index.html`
3. ID en lista de `src/js/modules/settings.js`
4. Comportamiento en `applySettings()` de `gasTools.js`
5. Notificar y validar live

## Verificación manual
- Popup funciona en editor GAS y fuera
- Enable/desable sin romper sesión
- Save/Reset persiste correctamente
- Snippets: crear, editar, eliminar y reflejan en Monaco
- Temas: seleccionar, duplicar, editar, eliminar y aplicación inmediata
- Sin errores en consola

## Anti-patrones
- Saltar background (popup → injected directo)
- Duplicar providers/snippets sin limpiar estado
- Cambiar contratos sin actualizar todas las capas