# Google Apps Script Tools

Extensión Chrome (Manifest V3) que mejora el editor de Google Apps Script con configuración avanzada de Monaco, snippets y temas.

## Características

| # | Característica | Descripción |
| - | - | - |
| 1 | **Temas** | ~50 temas para el editor Monaco |
| 2 | **Snippets** | 23 snippets predefinidos (JS + HTML/GAS) |
| 3 | **Opciones de editor** | Minimap, word wrap, bracket pairs, smooth scrolling, tab completion, format on save, y más |
| 4 | **Mostrar/Ocultar archivos** | Panel lateral colapsable |

## Instalación

Desde [Chrome Web Store](https://chrome.google.com/webstore/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp) o cargar manualmente la extensión desde `manifest.json`.

## Snippets disponibles

**JavaScript:**
- `clog` - console.log
- `log` - Logger.log (GAS)
- `gss` - Get Active Spreadsheet
- `getval` - Get Range Values
- `alert` - Browser Alert
- `for`, `forof`, `fe` - Bucles
- `ife` - If-Else
- `try` - Try-Catch
- `map`, `filter` - Arrays
- `doc` - JSDoc comment
- `todo` - To-Do comment

**HTML/GAS:**
- `htmlgas` - Base template HTML
- `field`, `btn`, `select` - Form elements
- `divc`, `table` - Containers
- `incjs`, `incss` - GAS includes
- `loader` - Loading spinner

## Tech Stack

- Chrome Extension (Manifest V3)
- ES Modules (sin build step)
- Web Components
- IndexedDB + chrome.storage.sync

## Licencia

MIT