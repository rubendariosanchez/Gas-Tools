# Ficha de Chrome Web Store — Google Apps Script Tools

Datos para llenar el panel de desarrollador de Chrome Web Store (https://chrome.google.com/webstore/devconsole), en el orden de sus pestañas. Los textos están listos para copiar y pegar. Revisado contra el código el 18/10/2026 (versión `0.1.0` del `manifest.json`).

> Esta carpeta **no** va dentro del paquete: `createZipFile.bat` copia una lista explícita de archivos y no incluye `general_resources/`, `AGENTS.md`, `CLAUDE.md`, `INFO.md`, `tests/`, `pages/`, `graphify-out/` ni `package.json`.

Elemento publicado: `iigobcdpmngdgiacebgenbccmdacnjhp` (https://chromewebstore.google.com/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp). Esta versión es una **actualización** de ese elemento.

| Archivo | Para qué campo |
|---|---|
| `../gas-tools.zip` | Paquete (generarlo antes con `createZipFile.bat`, ver §4) |
| `icon-128.png` | Icono de la tienda (128 × 128) |
| `screenshots/NN-*.png` | Capturas de pantalla (1280 × 800, PNG de 24 bits sin alfa) |
| `promo/small-440x280.png` | Mosaico promocional pequeño |
| `promo/marquee-1400x560.png` | Mosaico promocional con desplazamiento |
| `privacy-policy.html` | Política de privacidad autónoma (publicarla en una URL, ver §2.5) |
| `source/` | Capturas manuales del editor de Apps Script que usa el generador (ver §5) |
| `tools/generate-store-assets.mjs` | Vuelve a generar capturas y mosaicos con la interfaz real |

---

## 1. Ficha de Play Store

La ficha se publica en **inglés** (idioma predeterminado, `default_locale: "en"`) y se añade **español** como segundo idioma. El título y el resumen de cada idioma salen de `_locales/<idioma>/messages.json`; la descripción se pega por idioma en la consola.

### Detalles del producto

**Título del paquete** (sale de `extName`; no se edita en la consola; 24 de 75 caracteres)

```
Google Apps Script Tools
```

**Resumen del paquete — inglés** (sale de `extDescription` en `_locales/en`; 130 de 132 caracteres)

```
Turn the Apps Script editor into a modern IDE: AI chat, live errors, GitHub sync, folders, multi-file search, themes and snippets.
```

**Resumen del paquete — español** (sale de `extDescription` en `_locales/es`; 128 de 132 caracteres)

```
Convierte el editor de Apps Script en un IDE moderno: chat con IA, errores en vivo, sync con GitHub, carpetas, temas y snippets.
```

**Descripción — inglés** (copiar todo el bloque; máximo 16 000 caracteres)

```
Google Apps Script Tools adds the features of a modern IDE to the Google Apps Script editor you already use: AI chat and suggestions, live errors, GitHub sync, folders, multi-file search, 50+ themes and snippets. It works on top of script.google.com. There is no new app to learn and no account to create.

EDITOR
• Folders in the file tree: files named with "/" (for example utils/dates.gs) are shown as collapsible folders, with color icons by file type.
• Live errors (Error Lens): diagnostics shown at the end of the affected line while you type, no save required.
• Multi-file search: the native find widget (Ctrl+F) searches across every file of the project; Ctrl+Alt+F and Ctrl+Shift+F jump between files with matches.
• File tabs (optional): VS Code-style tabs above the editor for the files you open; close, reorder by drag and drop or Ctrl+Shift+←/→, and the same unsaved-changes dot as the file tree (tabs with unsaved changes can't be closed).
• Active file indicator, minimap, bracket pair colors, rulers, indentation guides, font and font size, applied live.
• Dark mode for the whole Apps Script interface.

AI (EXPERIMENTAL, BRING YOUR OWN KEY)
• AI chat in Chrome's side panel (Alt+Shift+C) with context from the selection, the current file or the whole project.
• Agent mode: the AI proposes edits and new files as a change set; you review the diff and accept or reject each change. Nothing is written without your approval.
• Inline AI suggestions while you type; accept with Tab.
• Providers: OpenAI, Anthropic, Google Gemini, OpenRouter, Abacus.AI ChatLLM, NVIDIA, and local models through Ollama or LM Studio.
• Network access to each provider is requested only when you turn it on.

GITHUB SYNC
• Sign in with GitHub (Device Flow) and link each Apps Script project to a repository and branch.
• Push and pull with a compact diff, per-file selection and a badge that tells whether each file changed in GAS, on GitHub or on both; a full-screen viewer to resolve conflicts file by file before pulling.
• Live progress and resumable transfers.
• Uses the Apps Script API with your Google account to read and write project files.

PROJECT ACTIONS
• Download the whole project as a ZIP.
• Delete several files at once.

THEMES AND SNIPPETS
• 50+ built-in editor themes plus a theme editor to duplicate and create your own.
• Built-in snippet catalog for Apps Script services, plus your own snippets with autocomplete.

LANGUAGES
• Interface in English and Spanish, selectable from the popup.

PRIVACY
The extension has no server and no analytics. Settings, snippets and themes stay in your browser. AI API keys, the GitHub token and the AI chat history are stored only on this device. Data leaves your browser only when you use a feature that needs it, and then it goes directly to that service: your AI provider, GitHub, or Google's Apps Script API.

Open source under the MIT license.
```

**Descripción — español** (copiar todo el bloque)

```
Google Apps Script Tools añade al editor de Google Apps Script las funciones de un IDE moderno: chat y sugerencias con IA, errores en vivo, sincronización con GitHub, carpetas, búsqueda en varios archivos, más de 50 temas y snippets. Funciona sobre script.google.com: no hay una aplicación nueva que aprender ni cuenta que crear.

EDITOR
• Carpetas en el árbol de archivos: los archivos con "/" en el nombre (por ejemplo utils/dates.gs) se muestran en carpetas plegables, con iconos de color por tipo de archivo.
• Errores en vivo (Error Lens): los diagnósticos aparecen al final de la línea mientras escribes, sin guardar.
• Búsqueda en varios archivos: el buscador nativo (Ctrl+F) recorre todo el proyecto; Ctrl+Alt+F y Ctrl+Shift+F saltan entre archivos con coincidencias.
• Pestañas de archivos (opcional): pestañas estilo VS Code sobre el editor con los archivos que abres; cerrar, reordenar arrastrando o con Ctrl+Shift+←/→ y el mismo punto de cambios sin guardar del árbol (las pestañas sin guardar no se pueden cerrar).
• Indicador del archivo activo, minimapa, colores de pares de corchetes, reglas, guías de indentación, fuente y tamaño, aplicados al instante.
• Modo oscuro para toda la interfaz de Apps Script.

IA (EXPERIMENTAL, CON TU PROPIA CLAVE)
• Chat con IA en el panel lateral de Chrome (Alt+Shift+C) con el contexto de la selección, el archivo actual o todo el proyecto.
• Modo agente: la IA propone ediciones y archivos nuevos como un conjunto de cambios; revisas el diff y aceptas o rechazas cada uno. No se escribe nada sin tu aprobación.
• Sugerencias de IA mientras escribes; se aceptan con Tab.
• Proveedores: OpenAI, Anthropic, Google Gemini, OpenRouter, Abacus.AI ChatLLM, NVIDIA y modelos locales con Ollama o LM Studio.
• El acceso de red a cada proveedor se pide solo cuando lo activas.

SINCRONIZACIÓN CON GITHUB
• Inicia sesión con GitHub (Device Flow) y vincula cada proyecto de Apps Script a un repositorio y una rama.
• Push y pull con diff compacto, selección por archivo y una etiqueta que indica si cada archivo cambió en GAS, en GitHub o en ambos; visor a pantalla completa para resolver conflictos archivo por archivo antes del pull.
• Progreso en vivo y transferencias que se reanudan.
• Usa la API de Apps Script con tu cuenta de Google para leer y escribir los archivos del proyecto.

ACCIONES DEL PROYECTO
• Descarga el proyecto completo en un ZIP.
• Elimina varios archivos a la vez.

TEMAS Y SNIPPETS
• Más de 50 temas del editor incluidos y un editor para duplicarlos o crear los tuyos.
• Catálogo de snippets para los servicios de Apps Script y tus propios snippets con autocompletado.

IDIOMAS
• Interfaz en inglés y español, a elegir desde el popup.

PRIVACIDAD
La extensión no tiene servidor ni analítica. Ajustes, snippets y temas se quedan en tu navegador. Las claves de API de IA, el token de GitHub y el historial del chat se guardan solo en este dispositivo. Los datos salen del navegador solo cuando usas una función que los necesita, y van directo a ese servicio: tu proveedor de IA, GitHub o la API de Apps Script de Google.

Código abierto con licencia MIT.
```

**Categoría**: `Herramientas para desarrolladores` (*Developer Tools*).

**Idioma**: `Inglés` (predeterminado) y `Español`.

### Recursos gráficos

| Campo | Archivo | Requisito de la tienda |
|---|---|---|
| Icono de la tienda | `icon-128.png` | 128 × 128 PNG |
| Vídeo promocional global | — (opcional) | URL de YouTube |
| Capturas de pantalla (subir en orden) | `screenshots/01…05-*.png` | 1280 × 800, JPEG o PNG de 24 bits sin alfa, de 1 a 5 |
| Mosaico promocional pequeño | `promo/small-440x280.png` | 440 × 280, PNG de 24 bits sin alfa |
| Mosaico promocional con desplazamiento | `promo/marquee-1400x560.png` | 1400 × 560, PNG de 24 bits sin alfa |

Estado al 18/10/2026: hay **4 capturas del popup** (`01-themes`, `02-ai`, `03-editor-options`, `04-snippets`). Las del editor (chat con IA, GitHub y editor con carpetas y errores) necesitan una sesión de Google, así que faltan las capturas manuales de `source/` (ver §5). Con ellas el generador deja 5 capturas: 3 del editor y 2 del popup.

### Campos adicionales

| Campo | Valor |
|---|---|
| URL oficial | `Ninguna`, salvo que se verifique un dominio propio en Google Search Console con la cuenta que publica. |
| URL de la página principal | **Pendiente**: la URL donde se publique `pages/index.html` (por ejemplo GitHub Pages). Mientras tanto, `https://github.com/rubendariosanchez`. |
| URL de asistencia | **Pendiente**: el issue tracker público del repositorio (el README lo menciona, pero no cita la URL exacta). |
| Contenido para adultos | No |

---

## 2. Prácticas de privacidad

### 2.1 Descripción de la finalidad única

```
Add IDE features to the Google Apps Script editor (script.google.com): folders, live errors, multi-file search, themes, snippets, an AI coding assistant with the user's own provider key, and GitHub sync of Apps Script projects.
```

### 2.2 Justificación de permisos

**declarativeContent**

```
Shows the extension's toolbar action as enabled only on Apps Script editor pages (script.google.com/home/projects/*/edit), where its settings apply. It does not read page content.
```

**storage**

```
Stores the user's settings, active theme, AI provider and model, AI instructions and per-project GitHub repository links (chrome.storage.sync), and, only on this device, AI API keys, the GitHub access token and the AI chat history per project (chrome.storage.local). Nothing is sent to a server of ours.
```

**sidePanel**

```
Opens the AI chat in Chrome's side panel, per tab, when the user clicks the AI button in the editor toolbar or presses Alt+Shift+C.
```

**identity**

```
Gets a Google OAuth token with chrome.identity.getAuthToken, only after the user clicks "Sign in with Google" in the GitHub or Actions panel. The token is used to call the Apps Script API on the user's own projects (read and write project files for GitHub sync, create files proposed by the AI, delete several files at once) and to show the signed-in account's email and avatar. Chrome manages the token; the extension does not store it.
```

**alarms**

```
Keeps the GitHub sign-in (OAuth Device Flow) polling alive: while the user authorizes the device code on github.com, an alarm wakes the service worker to check the authorization at the interval GitHub requires. The alarm is cleared when sign-in finishes or is cancelled.
```

**Permisos de host** (un bloque para el campo de host)

```
script.google.com: the content script adds the toolbar buttons, panels, folders, search and themes to the Apps Script editor, and the background downloads the project as a ZIP (feeds/download/export) when the user asks for it.
script.googleapis.com and www.googleapis.com: Apps Script API (project content) and userinfo (email and avatar of the signed-in Google account), only after Google sign-in.
oauth2.googleapis.com: revokes the Google token when the user signs out.
api.github.com and github.com/login: GitHub Device Flow sign-in and repository read/write for push and pull, only after GitHub sign-in.
*.googleusercontent.com and accounts.google.com: Google-hosted redirects and assets used by the editor and the project download.
AI providers (api.openai.com, api.anthropic.com, generativelanguage.googleapis.com, openrouter.ai, apps.abacus.ai, integrate.api.nvidia.com, localhost, 127.0.0.1) are optional host permissions, requested one by one only when the user enables that provider in the popup.
```

> **Revisar antes de enviar**: en el código no hay ninguna referencia a `*.googleusercontent.com` ni a `accounts.google.com` (18/10/2026). Si la descarga del proyecto no las necesita (probar "Download ZIP" sin esos hosts), quítalas del `manifest.json` y de este bloque: menos hosts = revisión más rápida y menos avisos. Ver hallazgos en §6.

### 2.3 Código remoto

`No, no uso código remoto.` Todo el JavaScript va dentro del paquete (incluidas las librerías de `src/vendor/`). Las respuestas de la IA, GitHub y la API de Apps Script son datos: el texto se muestra como Markdown sanitizado y el código propuesto solo se inserta en el editor como texto tras la aprobación del usuario; nunca se ejecuta. La única descarga externa es la hoja de estilos de Google Fonts de la fuente de código que elija el usuario (CSS, no código).

### 2.4 Uso de datos

**¿Qué datos de usuario recoges o recogerás?** Marcar:

- [x] **Información de identificación personal**: nombre, email y avatar de la cuenta de Google con la que el usuario inicia sesión (para mostrarlos en el panel; se guardan en `chrome.storage.sync`).
- [x] **Información de autenticación**: claves de API de IA y token de GitHub que introduce el usuario (solo en `chrome.storage.local`); token de Google gestionado por Chrome.
- [x] **Contenido del sitio web**: el código de los proyectos de Apps Script que el usuario envía a su proveedor de IA o sincroniza con GitHub, y el historial del chat por proyecto (solo en `chrome.storage.local`).

No marcar: información de salud, información financiera y de pagos, comunicaciones personales, ubicación, historial web ni actividad del usuario.

**Certificaciones** (marcar las tres):

- [x] No vendo ni transfiero datos de usuario a terceros, fuera de los casos de uso aprobados.
- [x] No uso ni transfiero datos de usuario con fines no relacionados con la finalidad única de mi elemento.
- [x] No uso ni transfiero datos de usuario para determinar la solvencia o con fines de préstamo.

> Las transferencias al proveedor de IA, a GitHub y a la API de Apps Script ocurren solo por acción del usuario y son parte de la finalidad única, así que son "casos de uso aprobados".

### 2.5 Política de privacidad

`privacy-policy.html` es una página completa en inglés, sin dependencias externas, coherente con §2.2 y §2.4. **Pendiente**: publicarla en una URL pública, por ejemplo:

- GitHub Pages del repositorio (`https://<usuario>.github.io/<repo>/privacy-policy.html`), o
- la misma web donde se publique `pages/` (sustituye a `pages/privacy-policy.html`, que depende de `general-styles.css`).

Después, pegar la URL en el campo **URL de la política de privacidad**. Como la extensión pide el scope `script.projects`, la misma URL se usa en la pantalla de consentimiento de OAuth (ver §4.3).

---

## 3. Distribución

| Campo | Recomendación |
|---|---|
| Visibilidad | **Público** (ya está publicada con este ID). |
| Regiones | Todas las regiones. |
| Pago | Gratis. |

---

## 4. Paquete

### 4.1 Generar y subir

1. **Cambiar el `client_id` de `oauth2` en `manifest.json` al de producción** (ver §4.3). Hoy el manifest lleva el de desarrollo local.
2. Ejecutar `createZipFile.bat` en la raíz → `gas-tools.zip`.
3. Pestaña **Paquete** › **Subir paquete nuevo**.
4. La versión del `manifest.json` debe ser mayor que la publicada: la actual es `0.1.0`; el último commit (`60de15e`) tenía `0.0.3`. **Pendiente**: confirmar en la consola qué versión está publicada.
5. **Enviar para revisión**. Al ser una actualización del mismo elemento, conserva el ID y los usuarios la reciben sin reinstalar.

### 4.2 Cambio de permisos frente a `0.0.3`

| Tipo | `0.0.3` | `0.1.0` |
|---|---|---|
| `permissions` | `declarativeContent`, `storage`, `sidePanel`, `identity`, `alarms` | Igual |
| Hosts de proveedores de IA y `localhost`/`127.0.0.1` | En `host_permissions` (se concedían al instalar) | Movidos a `optional_host_permissions` (se piden al activar cada proveedor) |

Mover hosts a opcionales **reduce** los avisos: Chrome no desactiva la extensión al actualizar. Los usuarios que ya usaban la IA tendrán que conceder el acceso a su proveedor una vez desde el popup (pestaña AI › Provider access); el chat lo avisa con el botón para concederlo.

### 4.3 OAuth de Google (scope `script.projects`)

- `INFO.md` (fuera del paquete) guarda dos `client_id`: **Local** (el que está ahora en `manifest.json`) y **Prod**. El de producción debe ser un cliente OAuth de tipo *Extensión de Chrome* ligado al ID `iigobcdpmngdgiacebgenbccmdacnjhp`; con el de local, "Sign in with Google" falla en la versión publicada.
- Scopes: `script.projects` (sensible), `userinfo.email` y `userinfo.profile`. Si la app de OAuth está en producción y no está verificada, los usuarios ven el aviso "Google no ha verificado esta aplicación". **Pendiente**: comprobar en Google Cloud Console › Pantalla de consentimiento que la app está verificada o pedir la verificación (requiere la URL de la política de §2.5, la página principal y un vídeo del uso del scope).

---

## 5. Volver a generar las imágenes

```
node general_resources/tools/generate-store-assets.mjs
```

- Carga la extensión real en Microsoft Edge sin ventana (perfil temporal, sin sincronización; Chrome estable ya no admite `--load-extension`).
- Abre el popup real a 400 × 580 y escala 2x. El popup solo muestra sus pestañas dentro del editor, así que el script responde a `chrome.tabs.query` con una URL de editor; la interfaz es la real.
- Compone cada escena a 1280 × 800 con el icono, un título y tres puntos, y genera los dos mosaicos con la pestaña Editor del popup.
- Reescribe `screenshots/`, `promo/` e `icon-128.png` en PNG RGB (sin alfa en capturas y mosaicos).
- Los textos están en `EDITOR_SCENES_` y `POPUP_SCENES_`, al inicio del script. Tarda unos 20 s.

**Capturas manuales del editor** (no se pueden generar sin una sesión de Google). Guardarlas en `source/` con estos nombres; el script las usa si existen y completa hasta 5 con escenas del popup:

| Archivo | Qué mostrar | Cómo |
|---|---|---|
| `source/editor.png` | Editor con carpetas plegadas, un error de Error Lens en línea y modo oscuro | Ventana de Chrome a 1440 × 900, proyecto de demostración sin datos reales, captura del área de la página |
| `source/ai-chat.png` | Editor + panel lateral con una respuesta del chat en modo Agent y la tarjeta de cambios | Igual; panel lateral abierto con Alt+Shift+C |
| `source/github.png` | Panel de GitHub en la pestaña de cambios o de diff | Igual; repositorio de demostración |

Se muestran a 900 px de ancho dentro del lienzo, así que conviene que tengan proporción 16:10 y al menos 1440 px de ancho. No deben verse correos, nombres de proyectos de clientes ni claves.

---

## 6. Hallazgos al revisar el código (18/10/2026)

| # | Hallazgo | Impacto | Acción sugerida |
|---|---|---|---|
| 1 | `manifest.json` usa el `client_id` de OAuth **Local** (`…6hdb0u6…`), no el de **Prod** (`…ld3pd7p…`, en `INFO.md`). `createZipFile.bat` copia el manifest tal cual. | Google sign-in roto en la versión publicada (GitHub sync, crear y borrar archivos). | Cambiar al de producción antes de empaquetar, o hacer que el script de ZIP lo sustituya. |
| 2 | `host_permissions` incluye `https://*.googleusercontent.com/*` y `https://accounts.google.com/*`, sin uso en el código. | Permisos amplios sin justificación verificable; pueden alargar la revisión. | Probar la descarga del ZIP sin ellos y quitarlos si funciona. |
| 3 | El chat lista **Kimi** como proveedor (`gas-chat-panel.js`) y el README del repo también, pero no está en `AI_PROVIDER_ORIGINS` ni en el manifest. | Elegir Kimi falla siempre (el background rechaza el proveedor). | Quitar Kimi del chat y del README, o añadirlo de punta a punta (origen opcional, ruta en el background). La ficha no lo menciona. |
| 4 | ~~La CSP de `extension_pages` permitía `'wasm-unsafe-eval'`.~~ **Resuelto (19/10/2026):** la CSP es `script-src 'self'; object-src 'self'`. | — | Probar el popup (CodeMirror) y el side panel (chat con markdown-it) cargando la extensión sin empaquetar. |
