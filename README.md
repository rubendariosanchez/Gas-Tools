# Google Apps Script Tools (GAS-Tools)

Extensión Chrome (Manifest V3) que transforma el editor de Google Apps Script en un IDE moderno con Inteligencia Artificial, temas avanzados, snippets y configuraciones de productividad.

## 🚀 Características Principales

### 1. 🤖 AI Autocomplete (Ghost Text)
Sugerencias de código en tiempo real directamente en el editor Monaco:
- **Context Awareness:** Entiende el código anterior y posterior (lookahead) para sugerencias precisas.
- **Soporte de Comentarios:** Escribe un comentario (`//`, `/* */` o `<!-- -->`) y deja que la IA implemente la lógica.
- **Debounce Inteligente:** Optimizado para no saturar la API mientras escribes.
- **Multi-Lenguaje:** Funciona en archivos `.gs`, `html`, `json` y `css`.

### 2. 💬 Panel de Chat AI Integrado
Un panel lateral interactivo para conversar con múltiples modelos de IA:
- **Proveedores Soportados:** OpenAI, Anthropic, Google Gemini, DeepSeek, Kimi (Moonshot), Nvidia Build y OpenRouter.
- **Comandos @Mention:**
  - `@selection`: Envía el texto seleccionado como contexto.
  - `@file`: Envía el contenido completo del archivo abierto.
  - `@project`: Envía todos los archivos del proyecto (respetando límites de tokens).
- **Herramientas de Código:** Copia, inserta o reemplaza código en el editor directamente desde el chat.

### 3. 🎨 Personalización Visual
- **Temas:** Más de 50 temas premium para el editor Monaco (Dark, Light, High Contrast).
- **Editor Configurable:** Control total sobre Minimapa, Word Wrap, Bracket Pair Colorization, Smooth Scrolling, Render Whitespace y más.
- **Fuentes:** Soporte para fuentes de programación populares como JetBrains Mono, Fira Code, Roboto Mono, etc.

### 4. ⚡ Productividad
- **Snippets:** Catálogo de snippets predefinidos para JS y HTML/GAS (ej: `clog`, `gss`, `htmlgas`).
- **Sidebar Colapsable:** Maximiza tu espacio de trabajo ocultando el panel de archivos original.
- **Format on Save:** Mantén tu código limpio automáticamente.

## 🛠️ Instalación

1. Descarga el repositorio o instálalo desde la [Chrome Web Store](https://chrome.google.com/webstore/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp).
2. Si lo instalas manualmente:
   - Ve a `chrome://extensions/`.
   - Activa el "Modo de desarrollador".
   - Haz clic en "Cargar descomprimida" y selecciona la carpeta de la extensión.

## ⚙️ Configuración de IA

Para usar las funciones de IA, debes configurar tus API Keys:
1. Abre el panel de chat en el editor de GAS.
2. Haz clic en el icono de **Settings** (⚙️).
3. Selecciona tu proveedor preferido e introduce tu API Key.
4. (Opcional) Ajusta el `System Prompt` para personalizar el comportamiento de la IA.

## 💻 Tech Stack

- **Core:** JavaScript ES Modules (sin build step).
- **UI:** Web Components (Shadow DOM) para aislamiento total de estilos.
- **Persistence:** IndexedDB para temas y snippets grandes + `chrome.storage.sync` para configuración de usuario.
- **Editor:** Inyección directa en la instancia de Monaco del IDE de Google.

## 📄 Licencia

MIT - Creado por [Rubén Darío Sánchez](https://github.com/rubendariosanchez)