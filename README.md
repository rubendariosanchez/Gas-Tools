# Google Apps Script Tools

A free Chrome extension that turns the Google Apps Script editor into a modern IDE: AI suggestions, in-line errors, multi-file search, GitHub sync, folders, snippets and 50+ themes.

[**Install from the Chrome Web Store →**](https://chromewebstore.google.com/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp)

---

## Why use it

Apps Script is a great runtime, but its editor is missing most of the things you have in VS Code, Cursor or any other modern IDE. This extension fills that gap without leaving the browser tab you already have open.

- **AI suggestions** as you type, with context from your project.
- **AI chat** inside the editor, supporting eight providers — bring your own key.
- **Live errors** highlighted at the offending line, no save required.
- **GitHub sync** for push and pull, with visual diff per file.
- **Folders** in the file tree, with collapsible groups and color icons.
- **Multi-file search** across the whole project (`Alt+Shift+F`).
- **50+ themes** plus a built-in theme editor.
- **Snippets** with a built-in catalog and a custom editor.

Everything is free and works on top of the editor you already use.

---

## Features

### AI suggestions
Inline ghost-text completions, like Cursor or GitHub Copilot. Press `Tab` to accept.

- Reads context before and after the cursor for accurate suggestions.
- Suggests the next few lines, not just one word.
- Works in `.gs`, `.html`, `.json` and `.css` files.
- Comment-to-code generation: write what you need, the AI implements it.

### AI chat
A side panel to chat with your model without leaving Apps Script.

- **Supported providers:** OpenAI, Anthropic (Claude), Google Gemini, DeepSeek, Kimi (Moonshot), Nvidia Build, ChatLLM and OpenRouter.
- **`@` commands to send context:**
  - `@selection` → currently selected text.
  - `@file` → the whole open file.
  - `@project` → all files in the project.
- **Quick actions on every code block in the response:** copy, insert at cursor or replace selection.
- API keys live in your browser. Requests go from your machine straight to the provider.

### Live errors (Error Lens)
Errors and warnings shown inline at the offending line the moment you stop typing. A pulsing red dot in the toolbar tells you when the active file has issues.

Detects, among other things:

- Unclosed parentheses, braces or brackets.
- Unterminated strings.
- `==` / `!=` (suggests `===` / `!==`).
- Reassignment of a constant.
- Duplicate parameters.
- Assignments inside `if` / `while`.
- Unreachable code after `return` / `throw`.
- Missing semicolons.
- Comparison with `NaN`.

### GitHub sync
Connect your GitHub account once and the editor gets a sync panel. The first time you sign in with Google so we can use the Apps Script API as the source of truth for your project files.

- Visual diff per file with line-by-line changes.
- Pick exactly which files to push, file by file.
- Pull creates new files automatically — no manual steps in the GAS sidebar.
- One mapping per project (script ID), remembers your repo and branch.
- Tokens stay in the browser. Your code never goes through a server we control.

### Folders in the file tree
Apps Script lists files flat. Name a file `utils/email.gs` and the file tree turns into a real folder structure with collapsible groups and color icons by file type.

- Collapsible folders, persistent state.
- Different color per file type (`.gs`, `.html`, `.json`, generic).
- Customize the colors from the popup.
- Files keep working exactly the same in Apps Script.

### Multi-file search
Press `Alt+Shift+F` to search across every file in the project at once.

- Results grouped by file.
- Keyboard navigation (`↑ / ↓ / Enter`).
- Click any match to jump straight to it.

### Active file indicator
A toolbar button that always shows the open file's name, even when the Apps Script tree doesn't reflect it. Click it for a popover with:

- Full file name.
- Detected language.
- Line count and size in bytes.
- Number of errors, warnings, infos and hints.

### 50+ editor themes
Classics from the VS Code world: Dracula, Monokai, Solarized, Tomorrow Night, Night Owl, One Dark, GitHub, Cobalt, Twilight, Xcode, Material Dark and many more.

- Apply with one click.
- Duplicate any theme and customize every color token.
- Create new themes from scratch.

### Code snippets
- Predefined catalog for JavaScript and HTML/GAS (`clog`, `gss`, `htmlgas`, …).
- Built-in editor to create, edit and delete your own snippets.
- Triggered by prefix in Monaco's autocomplete.

---

## Keyboard shortcuts

| Shortcut         | Action                              |
| ---------------- | ----------------------------------- |
| `Alt+Shift+F`    | Open multi-file search.             |
| `Alt+Shift+C`    | Open the AI chat panel.             |

---

## What you can configure

From the extension popup (click the icon in Chrome):

**Appearance**
- Active editor theme.
- Font (includes JetBrains Mono, Fira Code, Roboto Mono and more via Google Fonts).
- Font size.
- Line height.

**Editor behavior**
- Minimap on / off.
- Line numbers.
- Word wrap.
- Current line highlight.
- Vertical rulers at 80 / 120 columns.
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
- Toggle AI suggestions.
- Toggle the live linter.
- Toggle folders in the file tree.
- Customize file-tree icon colors per extension.
- Master switch — pause everything in one click without uninstalling.

**Snippets and themes**
- Create, duplicate, edit and delete snippets.
- Create, duplicate, edit and delete themes.

---

## Installation

Install in one click from the [Chrome Web Store](https://chromewebstore.google.com/detail/google-apps-script-tools/iigobcdpmngdgiacebgenbccmdacnjhp).

After install, open any Apps Script project and the toolbar gets the new buttons (AI, search, current file, GitHub).

### Configure your AI

1. Open the Apps Script editor.
2. Click the **AI** button in the toolbar (or press `Alt+Shift+C`).
3. Click the **Settings** (⚙️) icon inside the panel.
4. Pick a provider, paste your API key and optionally tweak the model and system prompt.

API keys are stored locally in Chrome. They are only used when you make a request to the provider you configured.

### Connect GitHub (optional)

1. Open any Apps Script project.
2. Click the **GitHub** button in the toolbar.
3. Sign in with Google (used to read and write your project content via the Apps Script API).
4. Sign in with GitHub (Device Flow — your token never leaves the browser).
5. Pick a repo and a branch. The panel shows the diff per file, lets you push selected files with a commit message, or pull updates from the repo.

---

## Privacy

The extension does not have a server. There is no account to create. Your code, your AI keys and your GitHub token live on your machine.

- No analytics, no tracking, no telemetry.
- AI requests go from your browser straight to the provider you chose.
- GitHub sync goes from your browser straight to GitHub.
- Settings are stored in Chrome — they sync with your Google account if you have Chrome sync on.
- Open source under the MIT license.

For details, see the [privacy policy](pages/privacy-policy.html) and [terms of use](pages/terms.html).

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

No. The extension only activates inside the Apps Script editor and runs only the features you turn on. There's a master switch to pause everything if you ever need to.
</details>

<details>
<summary><b>Will my code be sent to a server you control?</b></summary>

Never. AI requests go from your browser straight to the provider you chose. GitHub sync goes from your browser straight to GitHub. Apps Script sync goes from your browser straight to Google's API. We don't have a server in the middle.
</details>

<details>
<summary><b>Can I use it on a corporate Google account?</b></summary>

Yes, as long as your organization allows installing extensions from the Chrome Web Store. Some admins block extensions by policy — in that case ask IT to allow this one.
</details>

<details>
<summary><b>Does it work outside Chrome?</b></summary>

Today only on Chromium-based browsers (Chrome, Edge, Brave). The Apps Script editor itself runs there, so we focus on that environment.
</details>

---

## Local development

If you want to load the extension unpacked from this repo (instead of installing from the Chrome Web Store), there is one extra step for the GitHub sync panel.

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

---

## Credits

- **File tree handling:** the idea and approach for handling the editor's file tree are based on [JeanRemiDelteil / appsScriptColor](https://github.com/JeanRemiDelteil/appsScriptColor/tree/master). We used that project as a guide to understand how to work with the Apps Script editor's file structure.
- **Live linter (Error Lens):** the idea of showing diagnostics at the end of the line is inspired by [usernamehw / vscode-error-lens](https://github.com/usernamehw/vscode-error-lens/tree/master). We based the integration of this feature on top of Monaco inside the Apps Script editor on that project.
- **GitHub sync via Apps Script API:** the approach for reading and writing the project content from outside the editor is inspired by [leonhartX / gas-github](https://github.com/leonhartX/gas-github/blob/master/src/gas/script-api.js).

---

## Contact

Questions, feedback or bug reports: **rubencho.dev@gmail.com**.

The repo also has a public issue tracker on [GitHub](https://github.com/rubendariosanchez).

---

## License

MIT — built by [Rubén Darío Sánchez](https://github.com/rubendariosanchez).
