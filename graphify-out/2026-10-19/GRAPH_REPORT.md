# Graph Report - gas-tools  (2026-10-19)

## Corpus Check
- 115 files · ~389,735 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 5 file(s) not represented in the graph (top: .css 3, (none) 1, .bat 1)

## Summary
- 1732 nodes · 3882 edges · 96 communities (45 shown, 51 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 48 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `60de15e5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Orquestador del editor (gas-tools)
- background.js
- Panel de acciones
- Error Lens
- Búsqueda nativa multiarchivo
- Autocompletado IA
- Carpetas personalizadas
- Manifest de la extensión
- Panel de GitHub (núcleo)
- Indicador de archivo actual
- Vista previa de diff en editor
- ref_node_assert
- Popup: snippets
- tr
- Editor remoto (side panel)
- DomUtils
- Content script (bridge)
- generate-store-assets.mjs
- themes.js
- Tests del background
- Modal de temas
- GasChatPanel
- Mapa de archivos
- gas-ui.js
- Bootstrap MAIN world
- ui-tokens.test.js
- Reglas de calidad de UI
- Arquitectura de 4 capas
- Historial de chat
- gas-native-search.test.js
- Tests del agente
- Tests del side panel
- Variables.js
- Tests de markdown
- Funciones del popup
- Side panel y prefijo qc__
- ui.js
- Privacidad y landing
- github-api.js
- popup-security.test.js
- Ficha de Chrome Web Store — Google Apps Script Tools
- llm-tools.js
- package.json (tests)
- Storage.js
- Funciones de IA (docs)
- edit-applier.test.js
- GitHub: mixin de auth
- GitHub: mixin de modales
- GitHub: mixin de progreso
- GitHub: mixin de sync
- Render markdown
- Merge de código (Apply)
- Bloques de edición
- Diff de líneas
- Bridge LLM compartido
- Herramientas del agente
- Creación de archivos (API)
- error-lens.test.js
- edit-applier.js
- settings-propagation.test.js
- INFO.md
- ext-qa.md
- gas-file-tabs.test.js
- GasFileTabs
- icon
- GasDiffViewer
- SnippetModal
- OptionColor
- StorageAPI
- OptionToggle
- llm-providers.js
- google-api.js
- gas-tools-apply.test.js
- llm-providers.test.js
- gas-github-panel-diff.js
- ref_node_fs
- error-lens.test.js
- gas-diff-viewer.test.js
- edit-blocks.test.js

## God Nodes (most connected - your core abstractions)
1. `GasChatPanel` - 182 edges
2. `GasFileTabs` - 123 edges
3. `GasCustomEditor` - 86 edges
4. `GasNativeSearch` - 75 edges
5. `GasActionsPanel` - 57 edges
6. `GasErrorLens` - 57 edges
7. `GasAiAutocomplete` - 53 edges
8. `tr()` - 53 edges
9. `GasGithubPanel` - 34 edges
10. `GasDiffViewer` - 32 edges

## Surprising Connections (you probably didn't know these)
- `Arquitectura real (5 capas, sin build step)` --references--> `GasRemoteEditor`  [INFERRED]
  .claude/agents/ext-architect.md → extension/js/sidepanel/remote-editor.js
- `Reglas de diseño que debes respetar` --references--> `tr()`  [INFERRED]
  .claude/agents/ext-architect.md → src/js/utils/I18n.js
- `Arquitectura real (5 capas, sin build step)` --references--> `notifyEditors()`  [INFERRED]
  .claude/agents/ext-architect.md → src/js/utils/Notify.js
- `Reglas de diseño que debes respetar` --references--> `_isTrustedSender()`  [INFERRED]
  .claude/agents/ext-architect.md → extension/background.js
- `Reglas de la plataforma (aprendidas en este proyecto)` --references--> `_isTrustedSender()`  [INFERRED]
  .claude/agents/ext-fullstack.md → extension/background.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Injected GAS toolbar button templates sharing native wiring** — extension_html_actionsbutton_rsbtnactionsgas, extension_html_chatbutton_rsbtnchatgas, extension_html_currentfilebutton_rsbtncurrentfile, extension_html_githubbutton_rsbtngithubgas, extension_html_toolbar_native_wiring [EXTRACTED 1.00]
- **Popup -> background -> content script -> injected settings pipeline** — agents_popup_ui_layer, agents_background_layer, agents_content_script_layer, agents_injected_main_layer, agents_settings_propagation_flow [EXTRACTED 1.00]
- **Third-party inspirations credited in README and landing page** — readme_appsscriptcolor_credit, readme_vscode_error_lens_credit, readme_black_script_credit, readme_gas_github_credit, readme_markdown_it_vendor [EXTRACTED 1.00]

## Communities (96 total, 51 thin omitted)

### Community 1 - "background.js"
Cohesion: 0.08
Nodes (26): AI_LANGUAGE_NAMES, _applyResponseLanguage(), _assertProviderPermission(), _broadcastLlmConfigUpdated(), _cleanGithubProject(), EDITOR_URL_FALLBACK, _editorUrlPatterns(), G_EDITOR_I18N_CACHE (+18 more)

### Community 9 - "Manifest de la extensión"
Cohesion: 0.06
Nodes (33): action, default_icon, default_popup, default_title, show_matches, author, background, service_worker (+25 more)

### Community 13 - "ref_node_assert"
Cohesion: 0.09
Nodes (9): ctx, FILE, ctx, src, SRC, ctx, manifest, src (+1 more)

### Community 14 - "Popup: snippets"
Cohesion: 0.16
Nodes (3): G_MONACO_STYLES, SnippetCard, G_MONACO_STYLES

### Community 15 - "tr"
Cohesion: 0.11
Nodes (20): OptionSelect, OPTION_BASE_CSS, changeLanguage_(), initLanguageModule(), showPendingNotice_(), syncWithDatabase_(), saveSingleOption_(), renderVersion_() (+12 more)

### Community 18 - "DomUtils"
Cohesion: 0.06
Nodes (16): Antes de nada, Arquitectura real (5 capas, sin build step), Entregable (en español), Reglas de diseño que debes respetar, Trampas conocidas (diséñalas fuera), Al terminar, Antes de tocar código, Convenciones obligatorias (+8 more)

### Community 20 - "Content script (bridge)"
Cohesion: 0.13
Nodes (25): Antes de nada, Cumplimiento, Empaquetado (sin bundler), Entregable (en español), Textos para la revisión de Google (inglés por defecto), assetsBaseUrl_(), createNavigationDetector(), dispatchGAS() (+17 more)

### Community 23 - "generate-store-assets.mjs"
Cohesion: 0.10
Nodes (33): baseCss_(), capture_(), capturePopupTab_(), chunk_(), connect_(), crc32_(), CRC_TABLE_, DASHBOARD_ (+25 more)

### Community 24 - "themes.js"
Cohesion: 0.15
Nodes (27): deleteSnippet_(), initSnippetModal_(), initSnippetModule(), initSnippetNavigation_(), loadSnippets_(), saveSnippet_(), fetchThemeDefinition_(), getActiveThemeData_() (+19 more)

### Community 25 - "Tests del background"
Cohesion: 0.09
Nodes (15): CHAT, createPort(), EDITOR_MATCHES, event(), fetchCalls, grantedOrigins, IDE_SENDER, listeners (+7 more)

### Community 27 - "GasChatPanel"
Cohesion: 0.10
Nodes (3): GAS_LLM_PROVIDERS, GasChatContext, GasChatPanel

### Community 29 - "gas-ui.js"
Cohesion: 0.25
Nodes (11): adopt(), confirm(), el(), icon(), iconData(), iconNode(), pageToastRoot(), sheetFor() (+3 more)

### Community 30 - "Bootstrap MAIN world"
Cohesion: 0.22
Nodes (6): diffSettings(), initializeEditor_(), _listeners, markMonacoReady_(), processTransferData_(), waitForCwiz_()

### Community 31 - "ui-tokens.test.js"
Cohesion: 0.20
Nodes (6): FakeSheet, loadGasUi(), read(), ROOT, UI_FILES, walk()

### Community 32 - "Reglas de calidad de UI"
Cohesion: 0.18
Nodes (9): _injectToolbarButton_ helper (gas-tools.js), Actions toolbar button template (#rsBtnActionsGas), GitHub toolbar button template (#rsBtnGithubGas), GAS native tooltip+ripple wiring (jscontroller rkLvpe/soHxf, data-tt, data-i18n-tt), chrome.identity.getAuthToken Google auth for Apps Script API, leonhartX/gas-github (Apps Script API sync), GitHub sync (Google sign-in + GitHub Device Flow, diff, push/pull), Project actions (ZIP download, refresh tree, bulk delete via Apps Script API) (+1 more)

### Community 33 - "Arquitectura de 4 capas"
Cohesion: 0.22
Nodes (9): Background service worker (chrome.storage + LLM proxy), Content script bridge (main-functions.js: chrome.runtime <-> CustomEvent), DOM CustomEvent contract (GAS_TransferData, GAS_SettingsUpdated, GAS_LLM_*, ...), 4-layer architecture (Popup / Background / Content script / Injected MAIN), Injected MAIN-world layer (gas-tools-main.js, gas-tools.js, Monaco), Pattern for new options (DEFAULT_SETTINGS_OPTIONS -> index.html -> settings.js -> applySettings -> notifyEditors), Persistence split: IndexedDB (settings/snippets/themes) + chrome.storage.sync (active theme, global toggle, LLM keys), chrome.runtime message contract (GET_SETTINGS, NOTIFY_UPDATE, LLM_REQUEST, ...) (+1 more)

### Community 35 - "gas-native-search.test.js"
Cohesion: 0.29
Nodes (8): attached_(), here, load_(), makeDom_(), makeEditor_(), makeModel_(), project_(), source

### Community 36 - "Tests del agente"
Cohesion: 0.17
Nodes (6): GasAgentTools, GasChatStore, GasEditApplier, GasEditBlocks, GasLineDiff, GasProjectFiles

### Community 39 - "Variables.js"
Cohesion: 0.08
Nodes (40): CONTROL_EVENTS_, G_SETTINGS_WRITE_QUEUE, initActionButtons_(), initAiContextAutoSave_(), initAiContextModule(), initAutoSave_(), initSettingsModule(), loadAiContext_() (+32 more)

### Community 40 - "Tests de markdown"
Cohesion: 0.22
Nodes (6): legacyContext, mainContext, source, SOURCE_URL, vendor, VENDOR_URL

### Community 41 - "Funciones del popup"
Cohesion: 0.29
Nodes (8): Popup UI layer (src/html/index.html, src/js/app.js), JeanRemiDelteil/appsScriptColor (themes + file tree), Custom folders (/ in file names as folders), Master switch (global enable), Snippets catalog + custom snippet editor, Themes catalog (51 built-in) + theme editor, Popup option controls (option-toggle/option-select/option-color ids), Popup settings page (src/html/index.html)

### Community 42 - "Side panel y prefijo qc__"
Cohesion: 0.25
Nodes (7): Current file toolbar button template (#rsBtnCurrentFile, qcCfnDot/qcCfnName), Chrome side panel page (AI chat in sidepanel mode), Side panel context bar (#sideContext, active GAS editor file), Active file indicator popover (language, size, diagnostics counts), Live errors / Error Lens linter, markdown-it 14.1.0 (vendored), usernamehw/vscode-error-lens

### Community 44 - "ui.js"
Cohesion: 0.14
Nodes (28): handleProviderToggle_(), initProviderAccessModule(), refreshProviderStates_(), renderProviderToggles_(), setToggleState_(), applySettingValues(), createControl_(), createSection_() (+20 more)

### Community 45 - "Privacidad y landing"
Cohesion: 0.32
Nodes (7): Landing page (pages/index.html), Google API Services User Data Policy (Limited Use), Claim: all data stored in chrome.storage.local / localStorage, Privacy Policy (GAS Tools), Terms of Service (GAS Tools), Black edition for Google Apps Script IDE (swroot), Multi-file search (extended native find widget, Ctrl+Alt+F / Ctrl+Shift+F)

### Community 46 - "github-api.js"
Cohesion: 0.09
Nodes (50): _runDeviceFlow(), waitWithAlarm(), _wakeFlow(), _branchChangedError(), callGithubApi(), createBranch(), createRepo(), _encRef() (+42 more)

### Community 47 - "popup-security.test.js"
Cohesion: 0.17
Nodes (6): ThemeCard, handleSelectTheme_(), escapeHtml(), HTML_ESCAPES, safeColor(), safeColorList()

### Community 48 - "Ficha de Chrome Web Store — Google Apps Script Tools"
Cohesion: 0.11
Nodes (18): 1. Ficha de Play Store, 2.1 Descripción de la finalidad única, 2.2 Justificación de permisos, 2.3 Código remoto, 2.4 Uso de datos, 2.5 Política de privacidad, 2. Prácticas de privacidad, 3. Distribución (+10 more)

### Community 49 - "llm-tools.js"
Cohesion: 0.21
Nodes (14): _normalizeMaxTokens_(), OPENAI_COMPATIBLE_PROVIDERS, callLlmWithTools(), _newCallId_(), _parseArgs_(), toAnthropicMessages_(), toGeminiContents_(), TOOL_CAPABLE_PROVIDERS (+6 more)

### Community 51 - "package.json (tests)"
Cohesion: 0.29
Nodes (6): description, name, private, scripts, test, type

### Community 53 - "Storage.js"
Cohesion: 0.36
Nodes (5): fetchThemeJson_(), G_THEME_JSON_CACHE, getActiveTheme(), DB, THEME_LIST

### Community 54 - "Funciones de IA (docs)"
Cohesion: 0.33
Nodes (6): AI chat toolbar button template (#rsBtnChatGas), AI Autocomplete (inline ghost text, experimental), AI chat panel (@selection/@file/@project, Alt+Shift+C), AI Context (project conventions prompt block), Supported LLM providers (OpenAI, Anthropic, Gemini, Kimi, Nvidia, ChatLLM, OpenRouter, Custom), Local model setup (LM Studio / Ollama, OpenAI-compatible endpoint)

### Community 55 - "edit-applier.test.js"
Cohesion: 0.18
Nodes (3): FUZZY_SRC, { GasEditApplier: A, GasLineDiff }, SRC

### Community 70 - "error-lens.test.js"
Cohesion: 0.17
Nodes (6): EN, ES, ROOT, walk(), ROOT, walk()

### Community 72 - "settings-propagation.test.js"
Cohesion: 0.33
Nodes (5): bootMain(), bootService(), fakeDocument(), FULL, read()

### Community 74 - "ext-qa.md"
Cohesion: 0.40
Nodes (4): Antes de nada, Entregable (en español), Tests unitarios (sin dependencias nuevas), Verificación visual y de flujos (Chrome headless)

### Community 75 - "gas-file-tabs.test.js"
Cohesion: 0.19
Nodes (8): here, makeDom_(), makeEnv_(), gas, makeModel_(), makeTarget_(), openFromTree_(), source

### Community 80 - "icon"
Cohesion: 0.50
Nodes (6): CSS_ICONS, fillIcon_(), gasUi_(), hydrateIcons(), icon(), iconNode()

### Community 88 - "llm-providers.js"
Cohesion: 0.34
Nodes (13): readHttpError(), _callAnthropic(), _callGemini(), callLlmProvider(), _callOpenAICompatible(), EXCLUDED_MODEL_PATTERNS, _fetch_(), fetchProviderModels() (+5 more)

### Community 89 - "google-api.js"
Cohesion: 0.50
Nodes (6): callGoogleApi(), getGoogleUser(), getProjectContent(), putProjectContent(), _readError(), _toFsPath()

### Community 90 - "gas-tools-apply.test.js"
Cohesion: 0.47
Nodes (5): ctx, fakeEditor(), fakeModel(), setup(), window

### Community 91 - "llm-providers.test.js"
Cohesion: 0.40
Nodes (3): MESSAGES, sseResponse(), streamOf()

### Community 93 - "ref_node_fs"
Cohesion: 0.17
Nodes (6): ac, ctxFor(), fakeModel(), sandbox, src, GasLineDiff

### Community 94 - "error-lens.test.js"
Cohesion: 0.22
Nodes (5): codes(), here, { lens, GasErrorLens }, lint(), source

### Community 95 - "gas-diff-viewer.test.js"
Cohesion: 0.28
Nodes (4): fakeModel(), fakeMonaco(), loadViewer(), read()

### Community 97 - "edit-blocks.test.js"
Cohesion: 0.33
Nodes (3): GasEditBlocks, ORIGINAL, SINGLE

## Ambiguous Edges - Review These
- `Background service worker (chrome.storage + LLM proxy)` → `No-server privacy model (browser talks directly to providers, GitHub, Apps Script API)`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `4-layer architecture (Popup / Background / Content script / Injected MAIN)` → `Chrome side panel page (AI chat in sidepanel mode)`  [AMBIGUOUS]
  extension/html/sidepanel.html · relation: conceptually_related_to
- `Persistence split: IndexedDB (settings/snippets/themes) + chrome.storage.sync (active theme, global toggle, LLM keys)` → `Claim: all data stored in chrome.storage.local / localStorage`  [AMBIGUOUS]
  pages/privacy-policy.html · relation: conceptually_related_to

## Knowledge Gaps
- **7 isolated node(s):** `Resumable push/pull transfers with progress panel`, `Master switch (global enable)`, `Snippets catalog + custom snippet editor`, `markdown-it 14.1.0 (vendored)`, `Multi-file search (extended native find widget, Ctrl+Alt+F / Ctrl+Shift+F)` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 422 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **51 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `tr()` connect `ui.js` to `error-lens.test.js`, `Variables.js`, `Popup: snippets`, `tr`, `popup-security.test.js`, `icon`, `DomUtils`, `OptionColor`, `SnippetModal`, `OptionToggle`, `themes.js`, `Modal de temas`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `Resumable push/pull transfers with progress panel`, `Master switch (global enable)`, `Snippets catalog + custom snippet editor` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Orquestador del editor (gas-tools)` be split into smaller, more focused modules?**
  _Cohesion score 0.05640203154236835 - nodes in this community are weakly interconnected._
- **Why does `Arquitectura real (5 capas, sin build step)` connect `DomUtils` to `Editor remoto (side panel)`, `themes.js`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Should `background.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07692307692307693 - nodes in this community are weakly interconnected._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Background service worker (chrome.storage + LLM proxy)` and `No-server privacy model (browser talks directly to providers, GitHub, Apps Script API)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `4-layer architecture (Popup / Background / Content script / Injected MAIN)` and `Chrome side panel page (AI chat in sidepanel mode)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._