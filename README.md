# Google Apps Script Tools (GAS-Tools)

<details open>
<summary><h2>🇪n English version</h2></summary>

Chrome extension that turns the Google Apps Script editor into a modern IDE: AI autocomplete, chat with your favorite models, live linter, multi-file search, 50+ themes and a lot of customization options.

[**Install from the Chrome Web Store**](https://chrome.google.com/webstore/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp)

---

## ✨ What's included

### 🤖 AI Autocomplete
Inline code suggestions while you type (ghost text), just like in VS Code or Cursor.
- Reads context before and after the cursor for accurate suggestions.
- Write a comment describing what you want and the AI implements it.
- Works in `.gs`, `.html`, `.json` and `.css` files.

### 💬 AI Chat inside the editor
A side panel to talk to your AI model without leaving Apps Script.
- **Supported providers:** OpenAI, Anthropic (Claude), Google Gemini, DeepSeek, Kimi (Moonshot), Nvidia Build, ChatLLM and OpenRouter.
- **`@` commands to send context:**
  - `@selection` → currently selected text.
  - `@file` → the whole open file.
  - `@project` → all files in the project.
- **Quick actions on every code block of the response:** copy, insert at cursor or replace selection.
- API keys are stored locally.

### 🔍 Multi-file advanced search
Shortcut `Alt+Shift+F`. Search a string and find it across every file of the project at once, with results grouped by file and keyboard navigation (`↑ / ↓ / Enter`).

### 🪲 Live linter (Error Lens)
Shows errors and warnings **at the end of the offending line**, with no need to save first. A pulsing red dot in the toolbar lets you know when the active file has errors.

Detects, among other things:
- Unclosed parentheses, braces or brackets.
- Unterminated strings.
- `==` and `!=` (suggests `===` / `!==`).
- Const reassignment.
- Duplicate parameters.
- Assignments inside `if` / `while`.
- Unreachable code after `return` / `throw`.
- Missing semicolons.
- Comparison with `NaN`.

### 📄 Active file indicator
A toolbar button that always shows the name of the open file, even when the Apps Script tree doesn't reflect it. Click it for a popover with:
- Full file name.
- Detected language.
- Line count and size in bytes.
- Number of errors, warnings, infos and hints.

### 🎨 50+ themes
Catalog with classics like Dracula, Monokai, Solarized, Tomorrow Night, Night Owl, GitHub, Cobalt, Twilight, Xcode and many more. You can:
- Apply any theme with one click.
- Duplicate a theme and tweak its colors.
- Create your own from scratch.

### 🧰 Code snippets
- Predefined catalog for JavaScript and HTML/GAS (`clog`, `gss`, `htmlgas`, ...).
- Built-in editor to create, edit and delete your own snippets.
- Triggered by prefix in Monaco's autocomplete.

### ⚡ Shortcuts
- `Alt+Shift+F` → open multi-file search.
- `Alt+Shift+C` → open AI chat.

---

## ⚙️ What you can configure

From the extension popup (click the icon in Chrome):

**Appearance**
- Active editor theme.
- Font (includes several monospaced ones via Google Fonts: JetBrains Mono, Fira Code, Roboto Mono, etc.).
- Font size.
- Line height.

**Editor**
- Minimap on / off.
- Line numbers.
- Word wrap.
- Current line highlight.
- Vertical rulers (80 / 120 columns).
- Highlight occurrences of the word under the cursor.
- Render whitespace.
- Bracket pair colorization.
- Quick suggestions.
- Auto-closing brackets.
- Indentation guides.
- Code folding.
- Smooth scrolling.
- Scroll beyond the last line.
- Tab size (`tabSize`).
- Cursor style and blinking.

**Features**
- Toggle AI autocomplete.
- Toggle the linter (Error Lens).
- Global toggle to disable the whole extension without uninstalling it.

**Snippets and themes**
- Create, duplicate, edit and delete snippets.
- Create, duplicate, edit and delete themes.

---

## 🚀 Installation

Available on the [Chrome Web Store](https://chrome.google.com/webstore/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp). One click and it's installed.

## 🔑 Configuring the AI

1. Open the Apps Script editor.
2. Click the **AI** button in the toolbar (or press `Alt+Shift+C`).
3. Click the **Settings** (⚙️) icon inside the panel.
4. Pick your provider, paste your API key and optionally tweak the model and system prompt.

Keys are stored locally in your browser. They are only used when you make a request to the provider you configured.

---

## 🙏 Credits

- **File tree handling:** the idea and approach for handling the editor's file tree are based on [JeanRemiDelteil / appsScriptColor](https://github.com/JeanRemiDelteil/appsScriptColor/tree/master). We used that project as a guide to understand how to work with the Apps Script editor's file structure.
- **Live linter (Error Lens):** the idea of showing diagnostics at the end of the line is inspired by [usernamehw / vscode-error-lens](https://github.com/usernamehw/vscode-error-lens/tree/master). We based the integration of this feature on top of Monaco inside the Apps Script editor on that project.

---

## 📄 License

MIT — created by [Rubén Darío Sánchez](https://github.com/rubendariosanchez).

---
</details>

<details>
<summary><h2>🇪🇸 Versión en español</h2></summary>

Extensión Chrome que transforma el editor de Google Apps Script en un IDE moderno: autocompletado con IA, chat con tus modelos favoritos, linter en vivo, búsqueda en todos los archivos, más de 50 temas y muchas opciones de personalización.

[**Instalar desde la Chrome Web Store**](https://chrome.google.com/webstore/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp)

---

## ✨ Qué incluye

### 🤖 Autocompletado IA
Sugerencias de código mientras escribes (ghost text), igual que en VS Code o Cursor.
- Lee el contexto antes y después del cursor para sugerir lo que necesitas.
- Escribe un comentario describiendo lo que quieres y la IA lo implementa.
- Funciona en `.gs`, `.html`, `.json` y `.css`.

### 💬 Chat AI dentro del editor
Un panel lateral para conversar con tu modelo de IA sin salir de Apps Script.
- **Proveedores soportados:** OpenAI, Anthropic (Claude), Google Gemini, DeepSeek, Kimi (Moonshot), Nvidia Build, ChatLLM y OpenRouter.
- **Comandos `@` para enviar contexto:**
  - `@selection` → el texto que tienes seleccionado.
  - `@file` → todo el archivo abierto.
  - `@project` → todos los archivos del proyecto.
- **Acciones rápidas en cada bloque de código de la respuesta:** copiar, insertar en el cursor o reemplazar la selección.
- Tus API keys quedan guardadas localmente.

### 🔍 Búsqueda avanzada multi-archivo
Atajo `Alt+Shift+F`. Busca un texto y lo encuentra en todos los archivos del proyecto al mismo tiempo, con resultados agrupados por archivo y navegación con `↑ / ↓ / Enter`.

### 🪲 Linter en vivo (Error Lens)
Muestra los errores y advertencias **al final de la línea** donde ocurren, sin esperar a guardar. Incluye un punto rojo pulsante en la barra superior cuando hay errores en el archivo activo.

Detecta entre otras cosas:
- Paréntesis, llaves o corchetes sin cerrar.
- Strings sin terminar.
- `==` y `!=` (sugiere usar `===` / `!==`).
- Reasignación de constantes.
- Parámetros duplicados.
- Asignaciones dentro de un `if` / `while`.
- Código inalcanzable después de `return` / `throw`.
- Punto y coma faltante.
- Comparación con `NaN`.

### 📄 Indicador de archivo activo
Botón en la barra superior que muestra siempre el nombre del archivo abierto, incluso cuando el árbol de Apps Script no lo refleja. Al hacer clic se abre un popover con:
- Nombre completo.
- Lenguaje detectado.
- Cantidad de líneas y tamaño en bytes.
- Número de errores, warnings, infos y hints.

### 🎨 Más de 50 temas
Catálogo con clásicos como Dracula, Monokai, Solarized, Tomorrow Night, Night Owl, GitHub, Cobalt, Twilight, Xcode y muchos más. Puedes:
- Aplicar cualquiera con un clic.
- Duplicar un tema y editar sus colores.
- Crear los tuyos desde cero.

### 🧰 Snippets de código
- Catálogo predefinido para JavaScript y HTML/GAS (`clog`, `gss`, `htmlgas`, ...).
- Editor propio para crear, editar y eliminar tus snippets.
- Disparo por prefijo en el autocompletado de Monaco.

### ⚡ Atajos
- `Alt+Shift+F` → abrir búsqueda multi-archivo.
- `Alt+Shift+C` → abrir chat con IA.

---

## ⚙️ Qué puedes configurar

Desde el popup de la extensión (clic en el icono de Chrome):

**Apariencia**
- Tema activo del editor.
- Fuente (incluye varias monoespaciadas vía Google Fonts: JetBrains Mono, Fira Code, Roboto Mono, etc.).
- Tamaño de fuente.
- Altura de línea.

**Editor**
- Minimapa visible / oculto.
- Números de línea.
- Word wrap.
- Resaltado de la línea actual.
- Reglas verticales (80 / 120 columnas).
- Resaltado de ocurrencias de la palabra bajo el cursor.
- Render de espacios en blanco.
- Bracket pair colorization.
- Sugerencias rápidas (quick suggestions).
- Cierre automático de paréntesis.
- Guías de indentación.
- Folding de código.
- Smooth scrolling.
- Scroll más allá de la última línea.
- Tamaño de tabulación (`tabSize`).
- Estilo y parpadeo del cursor.

**Características**
- Activar / desactivar el autocompletado IA.
- Activar / desactivar el linter (Error Lens).
- Toggle global para deshabilitar toda la extensión sin desinstalarla.

**Snippets y temas**
- Crear, duplicar, editar y eliminar snippets.
- Crear, duplicar, editar y eliminar temas.

---

## 🚀 Instalación

Disponible en la [Chrome Web Store](https://chrome.google.com/webstore/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp). Un clic e instala.

## 🔑 Configurar la IA

1. Abre el editor de Apps Script.
2. Pulsa el botón **AI** en la barra superior (o `Alt+Shift+C`).
3. Pulsa el icono de **Settings** (⚙️) dentro del panel.
4. Elige tu proveedor, pega tu API key y, opcionalmente, ajusta el modelo y el system prompt.

Las claves se guardan localmente en tu navegador. Solo se usan cuando haces una consulta al proveedor que tú configuraste.

---

## 🙏 Créditos

- **Manejo del árbol de archivos:** la idea y el enfoque del manejo del árbol de archivos del editor están basados en [JeanRemiDelteil / appsScriptColor](https://github.com/JeanRemiDelteil/appsScriptColor/tree/master). Usamos ese proyecto como guía para entender cómo trabajar con la estructura de archivos del editor de Apps Script.
- **Linter en vivo (Error Lens):** la idea de mostrar los diagnósticos al final de la línea está inspirada en [usernamehw / vscode-error-lens](https://github.com/usernamehw/vscode-error-lens/tree/master). Nos basamos en ese proyecto para integrar esta característica en Monaco dentro del editor de Google Apps Script.

---

## 📄 Licencia

MIT — creado por [Rubén Darío Sánchez](https://github.com/rubendariosanchez).

</details>
