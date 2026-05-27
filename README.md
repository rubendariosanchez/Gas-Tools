<div align="center">

<img src="resources/icons/icon128.png" alt="Google Apps Script Tools" width="96" height="96">

# Google Apps Script Tools

**Turn the Google Apps Script editor into a modern IDE.**
AI suggestions, in-line errors, multi-file search, GitHub sync, folders, snippets and 50+ themes — without leaving your browser.

[**Install from the Chrome Web Store →**](https://chromewebstore.google.com/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp)

<br>

<img src="resources/screenshots/mode-dark.png" alt="Apps Script editor with the extension active in dark mode" width="720">

</div>

---

## Why use it

Apps Script is a great runtime, but its editor is missing most of the things you have in VS Code, Cursor or any other modern IDE. This extension fills that gap on top of the tab you already have open.

- **AI suggestions** as you type, with context from your project.
- **AI chat** with eight providers — bring your own key.
- **Live errors** highlighted right at the line, no save required.
- **GitHub sync** with visual diff, per-file selection and resumable transfers.
- **Folders** in the file tree, with collapsible groups and color icons.
- **Multi-file search** across the whole project.
- **50+ themes** plus a built-in theme editor.
- **Snippets** with a built-in catalog and a custom editor.

Everything is free and works on top of the editor you already use.

---

## Table of contents

1. [Installation](#installation)
2. [Configuration (popup)](#configuration-popup)
   - [Editor options](#editor-options)
   - [Snippets](#snippets)
   - [Themes](#themes)
   - [AI](#ai)
   - [About](#about)
3. [The editor panels](#the-editor-panels)
   - [Active file](#active-file)
   - [Multi-file search](#multi-file-search)
   - [AI chat](#ai-chat)
   - [GitHub sync](#github-sync)
   - [Project actions](#project-actions)
   - [Live errors](#live-errors)
4. [Keyboard shortcuts](#keyboard-shortcuts)
5. [Privacy](#privacy)
6. [FAQ](#faq)
7. [Credits](#credits)
8. [Local development](#local-development)

---

## Installation

Install in one click from the [Chrome Web Store](https://chromewebstore.google.com/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp). After install, open any Apps Script project — the toolbar will gain new buttons (search, AI, current file, actions, GitHub).

Click the extension icon in Chrome to open the popup with all settings.

---

## Configuration (popup)

The popup has five tabs: **Options**, **Snippets**, **Themes**, **AI** and **About**. Settings are saved automatically and apply live to any open Apps Script tab.

### Editor options

<div align="center">
  <img src="resources/screenshots/popup-options.png" alt="Popup Options tab with editor settings" width="600">
</div>

#### Extension

| Option              | What it does                                                                  | Default       |
| ------------------- | ----------------------------------------------------------------------------- | ------------- |
| Enable extension    | Master switch. Pauses every feature without uninstalling.                     | On            |
| AI Autocomplete ⚗️  | Inline ghost-text suggestions while you type. Press `Tab` to accept. *(Experimental.)* | Off           |
| Custom folders      | Treats `/` in file names as folders in the file tree (e.g. `utils/email.gs`). | On            |
| Folder color        | Color used for folder icons in the file tree.                                 | Neutral grey  |
| `.gs` file color    | Color of the icon for Apps Script files.                                      | Google blue   |
| `.html` file color  | Color of the icon for HTML files.                                             | Google red    |
| `.json` file color  | Color of the icon for JSON files.                                             | Google green  |
| Error lens          | Shows inline diagnostics (errors, warnings, hints) at the offending line.     | On            |

#### Font

| Option       | What it does                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Font family  | Pick the editor monospace font: JetBrains Mono, Fira Code, Roboto Mono, Source Code Pro, Geist Mono, IBM Plex Mono and more (auto-loaded from Google Fonts). |
| Font size    | Editor font size in pixels (`10`–`48`). Default `13`.                                                      |
| Line height  | Vertical line spacing in pixels (`12`–`48`). Default `19`.                                                 |

#### Visuals & Layout

| Option                | What it does                                                                              | Default |
| --------------------- | ----------------------------------------------------------------------------------------- | ------- |
| IDE Dark Mode         | Applies a dark theme to the entire Apps Script interface, not just the editor pane.       | Off     |
| Show minimap          | Shows the high-level code overview on the right side of the editor.                       | On      |
| Line numbers          | Shows line numbers on the left margin.                                                    | On      |
| Word wrap             | Wraps long lines so they fit within the editor width.                                     | Off     |
| Line highlight        | Highlights the line where the cursor is.                                                  | On      |
| Rulers                | Shows vertical rulers at column 80 and 120.                                               | Off     |
| Occurrences highlight | Highlights every occurrence of the word under the cursor.                                 | On      |
| Show whitespace       | Renders spaces, tabs and other invisible whitespace characters.                           | Off     |

#### Code Assistance

| Option                     | What it does                                                            | Default |
| -------------------------- | ----------------------------------------------------------------------- | ------- |
| Bracket pair colorization  | Paints matching brackets with unique colors so they are easy to follow. | On      |
| Quick suggestions          | Shows the editor's autocomplete list while typing.                      | On      |
| Auto closing brackets      | Closes brackets, quotes and tags as you type.                           | On      |
| Indentation guides         | Vertical lines at each indentation level.                               | On      |

#### Navigation, Scrolling and Editor Behavior

| Option                  | What it does                                                                  | Default |
| ----------------------- | ----------------------------------------------------------------------------- | ------- |
| Code folding            | Adds the gutter to collapse code blocks (functions, objects, regions).        | On      |
| Smooth scrolling        | Animates scroll motion for a more fluid feel.                                 | On      |
| Scroll beyond last line | Lets you scroll past the final line so the cursor can stay vertically centered. | Off     |
| Tab size                | Indentation width: `2`, `4`, `6` or `8`.                                      | `2`     |
| Cursor style            | `Line`, `Block`, `Underline` and the thin variants of each.                   | `Line`  |
| Cursor blinking         | `Blink`, `Smooth`, `Phase`, `Expand` or `Solid`.                              | `Blink` |

> **Tip:** every option applies live. Open an Apps Script tab in another window to see the effect as you toggle.

---

### Snippets

A built-in catalog of useful snippets for JavaScript and HTML / GAS, plus a visual editor to add your own. Snippets are triggered by their **prefix** in Monaco's autocomplete: type the prefix, press `Tab` and the body expands with placeholders you can jump through.

<div align="center">
  <img src="resources/screenshots/popup-snippets.png" alt="Popup Snippets tab with built-in and custom snippets" width="600">
</div>

#### What you can do here

- **Add** a new snippet with title, prefix, language (`javascript` / `html`) and body.
- **Duplicate** any snippet to start from a working template.
- **Edit** any of your custom snippets in a visual form.
- **Delete** custom snippets. Built-in ones are protected so you can't break them.
- **Search** by title or prefix to find a snippet fast.

#### Built-in catalog

**JavaScript**

| Prefix    | Snippet                                                |
| --------- | ------------------------------------------------------ |
| `clog`    | `console.log(variable)`                                |
| `log`     | `Logger.log(message)` (Apps Script logger)             |
| `gss`     | Get active spreadsheet and a sheet by name             |
| `getval`  | Get values from a range (`A2:C`)                       |
| `alert`   | `SpreadsheetApp.getUi().alert(...)`                    |
| `for`     | Classic `for` loop with `i++`                          |
| `forof`   | Modern `for…of` loop                                   |
| `fe`      | `array.forEach(item => { … })`                         |
| `ife`     | `if … else` block                                      |
| `try`     | `try … catch` with `Logger.log` on error               |
| `map`     | `array.map(item => …)`                                 |
| `filter`  | `array.filter(item => …)`                              |
| `doc`     | JSDoc comment block with `@param` and `@return`        |
| `todo`    | `// TODO: …` comment with current date                 |

**HTML / GAS**

| Prefix    | Snippet                                                          |
| --------- | ---------------------------------------------------------------- |
| `htmlgas` | Boilerplate `index.html` for HtmlService, with normalize.css     |
| `field`   | Input wrapped in a label with a placeholder                      |
| `btn`     | Styled button with id and class                                  |
| `select`  | Select dropdown with two options                                 |
| `divc`    | `<div class="container">` block                                  |
| `table`   | Table with `<thead>` and `<tbody>` and two columns               |
| `incjs`   | `<?!= include("JavaScript"); ?>` for HtmlService                 |
| `incss`   | `<?!= include("Stylesheet"); ?>` for HtmlService                 |
| `loader`  | Loading spinner skeleton                                         |

> **Tip:** snippets support placeholders (`${1:name}`) and tab navigation. Type a prefix, press `Tab`, fill the first slot, press `Tab` again to jump to the next.

---

### Themes

Apply any theme with one click. Duplicate any built-in theme to start from a template, edit every color token in the visual editor, or build a new theme from scratch.

<div align="center">
  <img src="resources/screenshots/popup-themes.png" alt="Popup Themes tab with built-in and custom themes" width="600">
</div>

#### What you can do here

- **Apply** a theme: click any card and it applies live in every open Apps Script tab.
- **Search** themes by name.
- **Duplicate** any theme to base your own design on it.
- **Edit** any custom theme in a visual editor for every token (background, foreground, comments, keywords, strings, types, etc.).
- **Delete** custom themes. Built-in ones are protected.

#### Built-in catalog (51 themes)

| Family            | Themes                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Modern dark       | Dracula, Night Owl, Monokai, Monokai Bright, One you build (start from any), Oceanic Next, Twilight, Vibrant Ink, Sunburst, Upstream Sunburst   |
| Modern light      | GitHub, Solarized-light, Tomorrow, Dawn, Clouds, iPlastic, Chrome DevTools                                                                      |
| Classic VS / IDE  | Xcode_default, Eiffel, Dreamweaver, IDLE, idleFingers, Textmate (Mac Classic), MagicWB (Amiga), monoindustrial                                  |
| Solarized & low   | Solarized-dark, Solarized-light, Zenburnesque, Pastels on Dark                                                                                  |
| Tomorrow set      | Tomorrow, Tomorrow-Night, Tomorrow-Night-Blue, Tomorrow-Night-Bright, Tomorrow-Night-Eighties                                                   |
| Bright / vivid    | Cobalt, Espresso Libre, Birds of Paradise, Amy, Brilliance Black, Brilliance Dull, Active4D, All Hallows Eve, Blackboard                        |
| Designer / warm   | LAZY, krTheme, Kuroir Theme, Katzenmilch, Slush and Poppies, SpaceCadet, Dominion Day, Merbivore, Merbivore Soft, Clouds Midnight               |
| Kiro              | Kiro dark, Kiro light                                                                                                                           |

---

### AI <kbd>⚗️ Experimental</kbd>

Choose a provider, paste your key, optionally tweak the model and the system prompt. The extension keeps the credentials per-provider so you can switch with a click. Each provider knows its own list of models so you don't have to guess.

> **Heads-up.** AI features (chat, autocomplete and the active-file panel that surfaces AI hints) are still **experimental**. They work well in most cases but may behave inconsistently with very large projects, unusual file structures or specific provider models. Disable them from the popup if you hit issues, and feel free to report what didn't work to **rubencho.dev@gmail.com**.

<div align="center">
  <img src="resources/screenshots/popup-ai.png" alt="Popup AI tab with provider, key and model selector" width="600">
</div>

#### Supported providers

| Provider        | Where to get a key                                         |
| --------------- | ---------------------------------------------------------- |
| OpenAI          | [platform.openai.com](https://platform.openai.com)         |
| Anthropic       | [console.anthropic.com](https://console.anthropic.com)     |
| Google Gemini   | [aistudio.google.com](https://aistudio.google.com)         |
| DeepSeek        | [platform.deepseek.com](https://platform.deepseek.com)     |
| Kimi (Moonshot) | [platform.moonshot.cn](https://platform.moonshot.cn)       |
| Nvidia Build    | [build.nvidia.com](https://build.nvidia.com)               |
| ChatLLM         | [apps.abacus.ai](https://apps.abacus.ai)                   |
| OpenRouter      | [openrouter.ai](https://openrouter.ai)                     |
| **Custom (local)** | LM Studio, Ollama or any OpenAI-compatible endpoint     |

#### What you can do here

- **Pick a provider** and a default model (the list updates per provider).
- **Save your API key** for each provider; switch instantly without re-typing.
- **Edit the system prompt** that travels with every chat request.
- **Edit the AI Context**: a free-text block with project conventions you want the AI to keep in mind (style guide, naming, common helpers).
- **Test the connection** with a single click to confirm the key works.

#### Use a local model (LM Studio or Ollama)

If you don't want to rely on a paid API, you can run a model on your own machine and connect the extension to it. Pick **Custom** in the provider list and paste the local endpoint URL. The extension talks to any server that exposes an **OpenAI-compatible** chat endpoint, which is the case for both LM Studio and Ollama.

**LM Studio**

1. Download [LM Studio](https://lmstudio.ai) and install it.
2. Open the **Discover** tab, search for `Qwen2.5 Coder 3B Instruct` (recommended) and download it. Any of the models in the table below also works.
3. Go to the **Developer** tab (or **Local Server** in older versions) and click **Start Server**. Default port is `1234`.
4. In the extension popup, AI tab, set:
   - **Provider:** `Custom`
   - **Endpoint URL:** `http://localhost:1234/v1/chat/completions`
   - **Model:** the exact model id shown in LM Studio (copy from the server panel).
   - **API Key:** leave it empty (LM Studio doesn't require one).

**Ollama**

1. Install [Ollama](https://ollama.com).
2. From a terminal, pull the recommended model:
   ```bash
   ollama pull qwen2.5-coder:3b-instruct
   ```
   Other good options: `stable-code:3b-instruct`, `qwen2.5-coder:7b-instruct`, `llama3.1:8b-instruct`, `deepseek-coder-v2:lite-instruct`. See the table below for trade-offs.
3. Make sure the Ollama service is running (it starts automatically after install on Windows / macOS; on Linux you can run `ollama serve`). Default port is `11434`.
4. In the extension popup, AI tab, set:
   - **Provider:** `Custom`
   - **Endpoint URL:** `http://localhost:11434/v1/chat/completions`
   - **Model:** the exact model name you pulled (e.g. `qwen2.5-coder:3b-instruct`).
   - **API Key:** leave it empty.

> **Tip:** for code completions a 7B-class instruct model is usually fast enough on a modern laptop and gives decent quality. For chat or refactors, prefer 14B-class if your machine has at least 16 GB of RAM.

#### Recommended local models for Apps Script / JavaScript / HTML / CSS

The author's pick: **`qwen2.5-coder-3b-instruct`**. It is fast even on regular laptops, understands `.gs`, `.html`, `.css` and `.json` well, and is small enough to keep loaded next to your editor. Below are five solid options, ordered from lightest to most capable.

| # | Model                                     | Size  | Strengths                                                       | LM Studio search                | Ollama tag                              |
| - | ----------------------------------------- | ----- | --------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| 1 | **Qwen2.5 Coder 3B Instruct** *(recommended)* | ~3 B  | Very fast, great quality for its size, strong on JS / HTML / CSS / SQL. | `Qwen2.5 Coder 3B Instruct`     | `qwen2.5-coder:3b-instruct`             |
| 2 | **Stable Code 3B Instruct**               | ~3 B  | Tuned for code completion. Excellent latency for inline ghost-text. | `Stable Code 3B Instruct`     | `stable-code:3b-instruct`               |
| 3 | **Qwen2.5 Coder 7B Instruct**             | ~7 B  | Bigger steps, longer responses, better on tricky refactors.     | `Qwen2.5 Coder 7B Instruct`     | `qwen2.5-coder:7b-instruct`             |
| 4 | **Llama 3.1 8B Instruct**                 | ~8 B  | Strong general-purpose model that also handles JS / HTML well. Use it for chat and explanations. | `Llama 3.1 8B Instruct`         | `llama3.1:8b-instruct`                  |
| 5 | **DeepSeek Coder V2 Lite Instruct**       | ~16 B (MoE) | Best quality of the list. MoE design keeps it fast despite the size; needs ~12 GB of RAM. | `DeepSeek Coder V2 Lite Instruct` | `deepseek-coder-v2:lite-instruct`       |

**How to pick:**

- **Have 8 GB of RAM and want speed?** `qwen2.5-coder:3b-instruct` or `stable-code:3b-instruct`.
- **Have 16 GB and want better answers?** `qwen2.5-coder:7b-instruct` or `llama3.1:8b-instruct`.
- **Have 24 GB+ and want close-to-cloud quality?** `deepseek-coder-v2:lite-instruct`.

> **Note on quantization:** quantized variants like `q4_K_M` are noticeably faster with very little quality loss for code. In LM Studio pick a `Q4_K_M` build of any of the models above; in Ollama the default tag already maps to a sensible quantization.

> **Privacy bonus:** with a local model nothing leaves your machine. The extension talks to `localhost`, the model is on your disk, and there is no cloud call involved.

#### AI Context — short prompts that work

The **AI Context** is a small block of text added to every conversation. Keep it short and specific. Two examples that work well in real Apps Script projects:

```text
This project is a Google Apps Script web app for {YOUR USE CASE}.
- Use modern JavaScript (let / const, arrow functions, async / await).
- Prefer Logger.log over console.log for runtime traces.
- Wrap risky calls in try / catch and log errors with the function name.
- Date format: dd/MM/yyyy. Currency format: 1,234.56 (en-US).
- Keep functions under 40 lines. Comment intent, not syntax.
```

```text
You are pair-programming on Apps Script HTML Service.
- Use <?!= include('Name'); ?> to embed templates.
- Avoid inline event handlers; bind events with addEventListener.
- For Spreadsheet calls, batch reads / writes (getValues / setValues).
- Don't suggest libraries that need npm; only what runs natively in GAS.
```

> **Privacy:** the API key never leaves your browser. The extension talks to the provider directly — no proxy, no telemetry.

---

### About

A summary screen with the version, links to the privacy policy, terms of use and the contact email. The **Master switch** lives here too: pause every feature with one click without having to uninstall.

<div align="center">
  <img src="resources/screenshots/about.png" alt="Popup About screen with version and master switch" width="600">
</div>

---

## The editor panels

These are the panels you get inside the Apps Script editor itself, right above the file tree.

### Active file <kbd>⚗️ Experimental</kbd>

A toolbar button that always shows the active file's name — even when the Apps Script tree highlight doesn't reflect it. Click it to open a popover with details.

<div align="center">
  <img src="resources/screenshots/current-file-panel.png" alt="Active file popover with language, size and diagnostics" width="380">
</div>

What you can see and do here:

- **File name** (full path including the virtual folder).
- **Language detected** (Apps Script, HTML, JSON, CSS).
- **Line count** and **size in bytes**.
- **Live counts** of errors, warnings, infos and hints from the linter.
- **Click any error count** to jump to the offending line.

---

### Multi-file search

The native `Ctrl+F` find widget gets a richer toolbar that knows about
the whole project: a badge shows the file you're standing on and the
position across all files, two chevrons jump to the previous/next file
with matches, and a popover lets you pick any file or any match
directly without stepping through them one by one.

<div align="center">
  <img src="resources/screenshots/search-panel.png" alt="Native find widget extended with cross-file navigation" width="600">
</div>

What you can do here:

- **Press `Ctrl+F`** to open Monaco's native find widget — it works exactly as before.
- **See the active file and position** in the badge below the inputs (e.g. `Code.gs · 2/5 files`).
- **Click the file name** to open a popover with every file that has matches; filter and click to jump.
- **Click the list icon** to see every match in the current file with its line snippet, and click to jump straight to it.
- **Use `Ctrl+Alt+F` / `Ctrl+Shift+F`** to jump to the next / previous file with matches without leaving the keyboard.
- **All native flags work** — case sensitivity, whole word, and regex.

---

### AI chat <kbd>⚗️ Experimental</kbd>

A side panel to chat with your model without leaving Apps Script. Open it with `Alt+Shift+C` or the **AI** button in the toolbar.

<div align="center">
  <img src="resources/screenshots/chat-panel.png" alt="AI chat panel with provider selector and code blocks" width="600">
</div>

What you can do here:

- **Talk to the AI** with full chat history kept inside the panel for the session.
- **Switch provider on the fly** from the dropdown at the top.
- **Send context with `@` commands:**
  - `@selection` → send the current selection.
  - `@file` → send the whole file.
  - `@project` → send every file in the project.
- **Code blocks** in responses get three quick actions:
  - Copy to clipboard.
  - Insert at cursor position.
  - Replace the current selection.
- **Edit settings** without leaving the panel: gear icon → provider, key, model, system prompt and AI context.

---

### GitHub sync

Connect your GitHub account once and the editor gets a sync panel. Sign in with Google so the extension can read and write your project files via the Apps Script API, then sign in with GitHub via Device Flow. Pick a repo and a branch and you are ready.

<div align="center">
  <img src="resources/screenshots/github-login-panel.png" alt="GitHub two-step sign-in: Google then GitHub" width="380">
  <br><br>
  <img src="resources/screenshots/github-main-panel.png" alt="GitHub main panel with Changes, Diff, Pull and Push" width="600">
</div>

#### Changes tab — what you can do

- **Browse all pending files** with their status badge (`+` new, `~` modified, `-` only in remote).
- **Select / deselect** files individually or with the master checkbox.
- **Write a commit message** in the inline editor.
- **Push selected files** to the connected branch in a single commit.
- **Pull remote changes** with a confirmation modal that previews the files coming in.

#### Diff tab — what you can do

- **See the diff per file** in a collapsible card per file.
- **Line-by-line view** with green additions, red deletions and unchanged context lines like GitHub.
- **Direction badge** (`Remote → GAS` / `GAS → Remote`) so you don't get confused.

#### Repository controls

- **Repo selector** with search; create a new repo from inside the panel.
- **Branch selector** with search; create a new branch from inside the panel.
- **Subfolder** field to map the project to a specific subdirectory of the repo.
- **Open repo on GitHub** with the external-link button.

#### Live progress and resumable transfers

Push and pull both show a progress panel anchored at the bottom. You see each file as it goes through:

- **Push:** Reading project snapshot → Uploading file blobs → Building Git tree → Creating commit → Updating branch ref. Each file is checked off in real time with a number.
- **Pull:** Reading remote tree → Downloading file blobs → Merging into project snapshot → Writing back via Apps Script API. Each file is marked as it merges.
- **If something fails halfway** — for example GitHub's secondary rate limit — the panel keeps a record of the files already done. **Retry resumes from there**, marking the reused files with a cache icon, so you don't waste cuota or hit the rate limit twice.
- **The panel cannot be closed and the tab cannot be switched off accidentally** while a sync is in progress: the close button is disabled and the browser shows the native "Leave site?" warning. Once the operation finishes (or fails cleanly), everything goes back to normal.

> **Privacy:** GitHub tokens stay in the browser. Apps Script API tokens are managed by Chrome's identity service. Your code never touches a server we control.

---

### Project actions

A toolbar button that gathers small but useful project tools in one place. Designed to save clicks.

<div align="center">
  <img src="resources/screenshots/actions-panel.png" alt="Actions panel with project shortcuts" width="380">
</div>

What you can do here:

- **Download the entire project** as a ZIP for backup or local edition.
- **Open the project in another tab** without losing the current state.
- **Refresh the file tree** when Apps Script doesn't update on its own.
- **Jump to project settings** in one click.

---

### Live errors

The active file lights up the moment you stop typing. A pulsing dot in the toolbar tells you when there are issues. Click any error to see the message at the offending line — no need to save and run.

The linter detects, among other things:

- Unclosed parentheses, braces or brackets.
- Unterminated strings.
- `==` / `!=` (suggests `===` / `!==`).
- Reassigning a constant declared with `const`.
- Duplicate function parameters.
- Assignments inside `if` / `while` (probable typos).
- Unreachable code after `return` / `throw`.
- Missing semicolons.
- Comparing with `NaN` instead of `Number.isNaN()`.

> **False-positive friendly.** The linter ignores jQuery wildcards (`$('.foo')`), regex literals, template strings and object literals, so you don't get noise on common patterns.

---

## Keyboard shortcuts

| Shortcut         | Action                              |
| ---------------- | ----------------------------------- |
| `Tab`            | Accept the current AI suggestion.   |
| `Ctrl+F`         | Open the native find widget (extended with cross-file navigation). |
| `Ctrl+Alt+F`     | Jump to the next file with matches. |
| `Ctrl+Shift+F`   | Jump to the previous file with matches. |
| `Alt+Shift+C`    | Open the AI chat panel.             |
| `Esc`            | Close the active panel.             |

---

## Privacy

The extension does not have a server. There is no account to create. Your code, your AI keys and your GitHub token live on your machine.

- No analytics, no tracking, no telemetry.
- AI requests go from your browser straight to the provider you chose.
- GitHub sync goes from your browser straight to GitHub.
- Project sync goes from your browser straight to Google's Apps Script API.
- Settings are stored in Chrome — they sync with your Google account if you have Chrome sync on.
- Open source under the MIT license.

For details, see the [privacy policy](pages/privacy-policy.html) and the [terms of use](pages/terms.html).

---

## FAQ

<details>
<summary><b>Is it really free?</b></summary>

Yes. The extension is free and open source under MIT. The only thing that costs money is the AI itself: you bring your own provider key (OpenAI, Claude, Gemini, etc.) and pay them directly for the usage. We never charge a cent.
</details>

<details>
<summary><b>Do I need to know how to code?</b></summary>

You should be familiar with Apps Script. The extension makes things faster and more pleasant for people already writing scripts. The AI chat helps a lot when you're stuck.
</details>

<details>
<summary><b>Does it slow down the editor?</b></summary>

No. The extension only activates inside the Apps Script editor and runs only the features you turn on. There is a master switch in the popup About screen to pause everything if you ever need to.
</details>

<details>
<summary><b>Will my code be sent to a server you control?</b></summary>

Never. AI requests go from your browser straight to the provider you chose. GitHub sync goes from your browser straight to GitHub. Apps Script sync goes from your browser straight to Google's API. We do not have a server in the middle.
</details>

<details>
<summary><b>Can I use it on a corporate Google account?</b></summary>

Yes, as long as your organization allows installing extensions from the Chrome Web Store. Some admins block extensions by policy — in that case ask IT to allow this one.
</details>

<details>
<summary><b>Does it work outside Chrome?</b></summary>

Today only on Chromium-based browsers (Chrome, Edge, Brave). The Apps Script editor itself runs there, so that is what we focus on.
</details>

<details>
<summary><b>What happens if a push or pull is interrupted?</b></summary>

The panel keeps track of the files that already finished. When you retry, those files are reused without re-uploading or re-downloading, so you don't waste time or hit GitHub's rate limits twice.
</details>

<details>
<summary><b>How do I create my own snippet or theme?</b></summary>

Open the popup, go to Snippets or Themes, click the **+** button. You'll get a visual editor with a preview while you type. Save and the new item appears in the editor immediately.
</details>

---

## Credits

- **File tree handling:** the idea and approach for the editor's file tree are based on [JeanRemiDelteil / appsScriptColor](https://github.com/JeanRemiDelteil/appsScriptColor).
- **Live linter (Error Lens):** the idea of showing diagnostics at the end of the line is inspired by [usernamehw / vscode-error-lens](https://github.com/usernamehw/vscode-error-lens).
- **GitHub sync via Apps Script API:** the approach for reading and writing the project content from outside the editor is inspired by [leonhartX / gas-github](https://github.com/leonhartX/gas-github/blob/master/src/gas/script-api.js).
- **Native find widget extension:** the idea of extending Monaco's native find widget with cross-file navigation is based on [Black edition for google apps script ide](https://www.swroot.com/black-script).

---

## Contact

Questions, feedback or bug reports: **rubencho.dev@gmail.com**.

The repo also has a public issue tracker on [GitHub](https://github.com/rubendariosanchez).

---

## License

MIT — built by [Rubén Darío Sánchez](https://github.com/rubendariosanchez).

---

## Local development

<details>
<summary><b>Loading the extension unpacked from this repo</b></summary>

If you want to load the extension unpacked (instead of installing from the Chrome Web Store), there is one extra step for the GitHub sync panel.

The GitHub sync uses the Apps Script API to read and write your project's files. That requires a Google sign-in via `chrome.identity.getAuthToken`, which only works when the extension was packaged with an OAuth Client tied to its stable extension ID.

1. In Google Cloud Console, create an OAuth 2.0 Client of type **Chrome App** and enable the **Apps Script API** on the same project.
2. Use a stable extension ID. The simplest path is generating a key locally with OpenSSL:
   ```bash
   openssl genrsa 2048 | openssl rsa -pubout -outform DER | openssl base64 -A
   ```
   Add the resulting string as `"key"` in `manifest.json`. Reload the extension, copy the ID Chrome assigns, and use that ID when registering the OAuth Client in Cloud Console.
3. Replace `manifest.oauth2.client_id` with the Client ID you just got. The scopes (`script.projects`, `userinfo.email`, `userinfo.profile`) are already set.
4. Reload the extension and click **Sign in with Google** in the GitHub panel. The first time you'll see the Google consent screen.

Tokens are managed by Chrome's identity service. They are not persisted by this extension and never travel to the MAIN world.
</details>
