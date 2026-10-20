# Graph Report - gas-tools  (2026-10-18)

## Corpus Check
- 107 files · ~348,440 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 5 file(s) not represented in the graph (top: .css 3, (none) 1, .bat 1)

## Summary
- 1474 nodes · 3217 edges · 82 communities (39 shown, 43 thin omitted)
- Extraction: 98% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 47 edges (avg confidence: 0.9)
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
- OptionColor
- Carpetas personalizadas
- Manifest de la extensión
- Panel de GitHub (núcleo)
- Indicador de archivo actual
- Vista previa de diff en editor
- ref_node_test
- Popup: snippets
- tr
- Editor remoto (side panel)
- Utilidades DOM
- Content script (bridge)
- llm-providers.js
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
- github-api.js
- Tests del agente
- Tests de Error Lens
- Tests del side panel
- Variables.js
- Tests de markdown
- Funciones del popup
- Side panel y prefijo qc__
- app.js
- Privacidad y landing
- Componente OptionSelect
- popup-security.test.js
- Ficha de Chrome Web Store — Google Apps Script Tools
- package.json (tests)
- Almacenamiento IndexedDB
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
- i18n.test.js
- edit-applier.js
- settings-propagation.test.js
- INFO.md
- ext-qa.md
- google-api.js
- ref_node_fs
- ref_node_assert
- edit-applier-large.test.js
- gas-tools-apply.test.js
- line-diff.test.js
- _runDeviceFlow
- SnippetModal

## God Nodes (most connected - your core abstractions)
1. `GasChatPanel` - 182 edges
2. `GasCustomEditor` - 86 edges
3. `GasActionsPanel` - 57 edges
4. `GasErrorLens` - 57 edges
5. `GasAiAutocomplete` - 53 edges
6. `GasNativeSearch` - 53 edges
7. `tr()` - 53 edges
8. `GasGithubPanel` - 34 edges
9. `GasFolders` - 32 edges
10. `GasDiffPreview` - 30 edges

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

## Communities (82 total, 43 thin omitted)

### Community 1 - "background.js"
Cohesion: 0.08
Nodes (24): AI_LANGUAGE_NAMES, _applyResponseLanguage(), _assertProviderPermission(), _broadcastLlmConfigUpdated(), EDITOR_URL_FALLBACK, _editorUrlPatterns(), G_EDITOR_I18N_CACHE, G_LLM_INFLIGHT (+16 more)

### Community 9 - "Manifest de la extensión"
Cohesion: 0.06
Nodes (33): action, default_icon, default_popup, default_title, show_matches, author, background, service_worker (+25 more)

### Community 13 - "ref_node_test"
Cohesion: 0.13
Nodes (8): ctx, src, GasEditBlocks, ORIGINAL, SINGLE, manifest, src, WAR

### Community 14 - "Popup: snippets"
Cohesion: 0.13
Nodes (9): G_MONACO_STYLES, SnippetCard, G_MONACO_STYLES, CSS_ICONS, fillIcon_(), gasUi_(), hydrateIcons(), icon() (+1 more)

### Community 15 - "tr"
Cohesion: 0.16
Nodes (19): OPTION_BASE_CSS, changeLanguage_(), initLanguageModule(), showPendingNotice_(), syncWithDatabase_(), saveSingleOption_(), renderVersion_(), applyI18n() (+11 more)

### Community 18 - "Utilidades DOM"
Cohesion: 0.06
Nodes (16): Antes de nada, Arquitectura real (5 capas, sin build step), Entregable (en español), Reglas de diseño que debes respetar, Trampas conocidas (diséñalas fuera), Al terminar, Antes de tocar código, Convenciones obligatorias (+8 more)

### Community 20 - "Content script (bridge)"
Cohesion: 0.13
Nodes (25): Antes de nada, Cumplimiento, Empaquetado (sin bundler), Entregable (en español), Textos para la revisión de Google (inglés por defecto), assetsBaseUrl_(), createNavigationDetector(), dispatchGAS() (+17 more)

### Community 22 - "llm-providers.js"
Cohesion: 0.13
Nodes (29): _callAnthropic(), _callGemini(), callLlmProvider(), _callOpenAICompatible(), EXCLUDED_MODEL_PATTERNS, _fetch_(), fetchProviderModels(), geminiAuthHeaders_() (+21 more)

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
Cohesion: 0.26
Nodes (10): adopt(), confirm(), el(), icon(), iconData(), iconNode(), pageToastRoot(), sheetFor() (+2 more)

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

### Community 35 - "github-api.js"
Cohesion: 0.31
Nodes (20): callGithubApi(), createBranch(), createRepo(), fetchRepoFiles(), _fromBase64(), getAuthenticatedUser(), _getBlobContent(), _getBranchCommitSha() (+12 more)

### Community 36 - "Tests del agente"
Cohesion: 0.17
Nodes (6): GasAgentTools, GasChatStore, GasEditApplier, GasEditBlocks, GasLineDiff, GasProjectFiles

### Community 37 - "Tests de Error Lens"
Cohesion: 0.22
Nodes (5): codes(), here, { lens, GasErrorLens }, lint(), source

### Community 39 - "Variables.js"
Cohesion: 0.07
Nodes (41): _migrateSettingsSchema(), CONTROL_EVENTS_, G_SETTINGS_WRITE_QUEUE, initActionButtons_(), initAiContextAutoSave_(), initAiContextModule(), initAutoSave_(), initSettingsModule() (+33 more)

### Community 40 - "Tests de markdown"
Cohesion: 0.22
Nodes (6): legacyContext, mainContext, source, SOURCE_URL, vendor, VENDOR_URL

### Community 41 - "Funciones del popup"
Cohesion: 0.29
Nodes (8): Popup UI layer (src/html/index.html, src/js/app.js), JeanRemiDelteil/appsScriptColor (themes + file tree), Custom folders (/ in file names as folders), Master switch (global enable), Snippets catalog + custom snippet editor, Themes catalog (51 built-in) + theme editor, Popup option controls (option-toggle/option-select/option-color ids), Popup settings page (src/html/index.html)

### Community 42 - "Side panel y prefijo qc__"
Cohesion: 0.25
Nodes (7): Current file toolbar button template (#rsBtnCurrentFile, qcCfnDot/qcCfnName), Chrome side panel page (AI chat in sidepanel mode), Side panel context bar (#sideContext, active GAS editor file), Active file indicator popover (language, size, diagnostics counts), Live errors / Error Lens linter, markdown-it 14.1.0 (vendored), usernamehw/vscode-error-lens

### Community 44 - "app.js"
Cohesion: 0.14
Nodes (28): handleProviderToggle_(), initProviderAccessModule(), refreshProviderStates_(), renderProviderToggles_(), setToggleState_(), applySettingValues(), createControl_(), createSection_() (+20 more)

### Community 45 - "Privacidad y landing"
Cohesion: 0.32
Nodes (7): Landing page (pages/index.html), Google API Services User Data Policy (Limited Use), Claim: all data stored in chrome.storage.local / localStorage, Privacy Policy (GAS Tools), Terms of Service (GAS Tools), Black edition for Google Apps Script IDE (swroot), Multi-file search (extended native find widget, Ctrl+Alt+F / Ctrl+Shift+F)

### Community 47 - "popup-security.test.js"
Cohesion: 0.17
Nodes (6): ThemeCard, handleSelectTheme_(), escapeHtml(), HTML_ESCAPES, safeColor(), safeColorList()

### Community 48 - "Ficha de Chrome Web Store — Google Apps Script Tools"
Cohesion: 0.11
Nodes (18): 1. Ficha de Play Store, 2.1 Descripción de la finalidad única, 2.2 Justificación de permisos, 2.3 Código remoto, 2.4 Uso de datos, 2.5 Política de privacidad, 2. Prácticas de privacidad, 3. Distribución (+10 more)

### Community 51 - "package.json (tests)"
Cohesion: 0.29
Nodes (6): description, name, private, scripts, test, type

### Community 53 - "Almacenamiento IndexedDB"
Cohesion: 0.18
Nodes (6): fetchThemeJson_(), G_THEME_JSON_CACHE, getActiveTheme(), DB, StorageAPI, THEME_LIST

### Community 54 - "Funciones de IA (docs)"
Cohesion: 0.33
Nodes (6): AI chat toolbar button template (#rsBtnChatGas), AI Autocomplete (inline ghost text, experimental), AI chat panel (@selection/@file/@project, Alt+Shift+C), AI Context (project conventions prompt block), Supported LLM providers (OpenAI, Anthropic, Gemini, Kimi, Nvidia, ChatLLM, OpenRouter, Custom), Local model setup (LM Studio / Ollama, OpenAI-compatible endpoint)

### Community 55 - "edit-applier.test.js"
Cohesion: 0.18
Nodes (3): FUZZY_SRC, { GasEditApplier: A, GasLineDiff }, SRC

### Community 70 - "i18n.test.js"
Cohesion: 0.17
Nodes (6): EN, ES, ROOT, walk(), ROOT, walk()

### Community 72 - "settings-propagation.test.js"
Cohesion: 0.33
Nodes (5): bootMain(), bootService(), fakeDocument(), FULL, read()

### Community 74 - "ext-qa.md"
Cohesion: 0.40
Nodes (4): Antes de nada, Entregable (en español), Tests unitarios (sin dependencias nuevas), Verificación visual y de flujos (Chrome headless)

### Community 75 - "google-api.js"
Cohesion: 0.40
Nodes (7): callGoogleApi(), getGoogleUser(), getProjectContent(), putProjectContent(), _readError(), _toFsPath(), readHttpError()

### Community 76 - "ref_node_fs"
Cohesion: 0.33
Nodes (5): ac, ctxFor(), fakeModel(), sandbox, src

### Community 79 - "gas-tools-apply.test.js"
Cohesion: 0.47
Nodes (5): ctx, fakeEditor(), fakeModel(), setup(), window

### Community 81 - "_runDeviceFlow"
Cohesion: 0.67
Nodes (4): _runDeviceFlow(), waitWithAlarm(), _wakeFlow(), pollDeviceToken()

## Ambiguous Edges - Review These
- `Background service worker (chrome.storage + LLM proxy)` → `No-server privacy model (browser talks directly to providers, GitHub, Apps Script API)`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `4-layer architecture (Popup / Background / Content script / Injected MAIN)` → `Chrome side panel page (AI chat in sidepanel mode)`  [AMBIGUOUS]
  extension/html/sidepanel.html · relation: conceptually_related_to
- `Persistence split: IndexedDB (settings/snippets/themes) + chrome.storage.sync (active theme, global toggle, LLM keys)` → `Claim: all data stored in chrome.storage.local / localStorage`  [AMBIGUOUS]
  pages/privacy-policy.html · relation: conceptually_related_to

## Knowledge Gaps
- **7 isolated node(s):** `Resumable push/pull transfers with progress panel`, `Master switch (global enable)`, `Snippets catalog + custom snippet editor`, `markdown-it 14.1.0 (vendored)`, `Multi-file search (extended native find widget, Ctrl+Alt+F / Ctrl+Shift+F)` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 380 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **43 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `tr()` connect `app.js` to `i18n.test.js`, `OptionColor`, `Variables.js`, `Popup: snippets`, `Componente OptionSelect`, `tr`, `popup-security.test.js`, `Utilidades DOM`, `SnippetModal`, `themes.js`, `Modal de temas`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `Resumable push/pull transfers with progress panel`, `Master switch (global enable)`, `Snippets catalog + custom snippet editor` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Orquestador del editor (gas-tools)` be split into smaller, more focused modules?**
  _Cohesion score 0.05640203154236835 - nodes in this community are weakly interconnected._
- **Why does `GasChatPanel` connect `GasChatPanel` to `._appendSystemNotice_`, `GasChatPanel`, `._callAdapter_`, `._sendMessage`, `._icon_`, `Chat: ChangeSet y streaming`, `._closeMenu_`, `._onInputKeyDown`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Should `background.js` be split into smaller, more focused modules?**
  _Cohesion score 0.08108108108108109 - nodes in this community are weakly interconnected._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Background service worker (chrome.storage + LLM proxy)` and `No-server privacy model (browser talks directly to providers, GitHub, Apps Script API)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `4-layer architecture (Popup / Background / Content script / Injected MAIN)` and `Chrome side panel page (AI chat in sidepanel mode)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._