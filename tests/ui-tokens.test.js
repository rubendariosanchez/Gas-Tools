// Tests de la fuente de diseño compartida (fases 3a/3b): tokens --gt-*
// definidos para todo lo que usan los paneles (sin alias --gc-*), hoja base
// adoptada una sola vez, registro de iconos que cubre todos los paneles,
// orden de carga de gas-ui.js y recursos web-accesibles mínimos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir))
  .filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
/** Todos los .js de `dir` (recursivo). */
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (
  e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []
));

/** Hoja construible mínima (sustituye a CSSStyleSheet fuera del navegador). */
class FakeSheet { replaceSync(css) { this.css = css; } }

/** Carga gas-ui.js en un contexto aislado y devuelve `GasUi`. */
function loadGasUi(extra = {}) {
  const ctx = { window: { ...extra } };
  vm.runInNewContext(read('extension/js/shared/gas-ui.js'), ctx);
  return ctx.window.GasUi;
}

// Archivos de UI que consumen tokens (componentes, servicios, shared, side panel, CSS y orquestador).
const UI_FILES = [
  ...list('extension/js/components', '.js'),
  ...list('extension/js/services', '.js'),
  ...list('extension/js/shared', '.js'),
  ...list('extension/js/sidepanel', '.js'),
  ...list('extension/css', '.css'),
  'extension/js/gas-tools.js',
];

test('todo var(--gt-*) usado en la UI está definido en TOKENS_CSS o BASE_CSS', () => {
  const { TOKENS_CSS, BASE_CSS } = loadGasUi();
  const defined = new Set(
    [...(TOKENS_CSS + BASE_CSS).matchAll(/(--gt-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  const missing = [];
  for (const file of UI_FILES) {
    for (const m of read(file).matchAll(/var\(\s*(--gt-[a-z0-9-]+)/g)) {
      if (!defined.has(m[1])) missing.push(`${file}: ${m[1]}`);
    }
  }
  for (const m of BASE_CSS.matchAll(/var\(\s*(--gt-[a-z0-9-]+)/g)) {
    if (!defined.has(m[1])) missing.push(`BASE_CSS: ${m[1]}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('sin alias --gc-* ni paletas paralelas (--gc__root-*, --qc-tree-line)', () => {
  const offenders = [];
  for (const file of [...walk('extension'), ...list('extension/css', '.css')]) {
    const src = read(file);
    for (const re of [/--gc-[a-z]/, /--gc__root-/, /--qc-tree-line/]) {
      if (re.test(src)) offenders.push(`${file}: ${re}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('los paneles heredan el tema: sin helpers de tema duplicados, atributo theme ni Material Icons', () => {
  const dom = read('extension/js/services/dom-utils.js');
  assert.ok(!/themeTokensCss|syncHostTheme/.test(dom), 'DomUtils sin helpers obsoletos');
  const offenders = [];
  for (const file of walk('extension/js')) {
    const src = read(file);
    if (/themeTokensCss|syncHostTheme|_isDarkMode_|_isEditorDark_|_syncFloatingPanelsTheme_/.test(src)) offenders.push(`${file}: helper de tema`);
    if (/setAttribute\('theme'|:host\(\[theme=/.test(src)) offenders.push(`${file}: atributo theme`);
    if (/classList\.contains\('ide-dark-mode'\)|body\.ide-dark-mode/.test(src)) offenders.push(`${file}: clase ide-dark-mode`);
    if (/material-icons/.test(src)) offenders.push(`${file}: fuente Material Icons`);
    if (/_escape_\(|_escapeHtml_\(|_escapeAttr_\(/.test(src)) offenders.push(`${file}: alias de escape`);
  }
  assert.deepEqual(offenders, []);
  const chat = read('extension/js/components/gas-chat-panel.js');
  assert.deepEqual(chat.match(/^\s*--gt-[a-z0-9-]+\s*:/gm) || [], [], 'el chat no redefine tokens');
  assert.ok(!/<style>\$\{this\._styles_\(\)\}/.test(chat), 'el CSS del chat se adopta, no se re-parsea');
  assert.ok(!read('extension/css/sidepanel.css').includes('--qc-side-'));
});

test('los paneles migrados adoptan GasUi y usan sus primitivas', () => {
  const cf = read('extension/js/components/gas-current-file.js');
  const act = read('extension/js/components/gas-actions-panel.js');
  const gh = read('extension/js/components/gas-github-panel.js');
  const ghm = read('extension/js/components/gas-github-panel-modals.js');
  for (const [name, src] of [['current-file', cf], ['actions', act], ['github', gh]]) {
    assert.match(src, /GasUi\.adopt\(this\.shadowRoot/, `${name} adopta la hoja base`);
    assert.ok(!/<style>[\s\S]*?<\/style>/.test(src), `${name} sin <style> inline`);
  }
  assert.match(cf, /GasUi\.positionPopover\(/);
  assert.match(act, /GasUi\.positionPopover\(/);
  assert.match(act, /GasUi\.liveAnchor\(/, 'actions re-resuelve el ancla tras reinyectar la toolbar');
  assert.match(act, /GasUi\.toast\(/);
  assert.match(act, /GasUi\.confirm\(/);
  assert.equal((act.match(/addEventListener\('keydown'/g) || []).length, 1, 'un único gestor de Escape');
  assert.match(gh, /GasUi\.positionPopover\(this/);
  assert.ok(!/background:#34a853/.test(gh), 'badge sin estilos inline');
  assert.match(ghm, /GasUi\.confirm\(/);
  assert.match(ghm, /GasUi\.toast\(/);
  assert.ok(!/chrome\.runtime\.getURL\(/.test(read('extension/js/components/gas-github-panel-sync.js')), 'sin chrome.runtime en el MAIN world');
});

test('adopt usa una única CSSStyleSheet cacheada y es idempotente', () => {
  const GasUi = loadGasUi({ CSSStyleSheet: FakeSheet });
  const a = { adoptedStyleSheets: [] };
  const b = { adoptedStyleSheets: [] };
  assert.equal(GasUi.adopt(a, '.x{}'), true);
  assert.equal(GasUi.adopt(a, '.x{}'), true);
  GasUi.adopt(b, '.x{}');
  assert.equal(a.adoptedStyleSheets.length, 2);
  assert.equal(a.adoptedStyleSheets[0].css, GasUi.BASE_CSS);
  assert.equal(a.adoptedStyleSheets[0], b.adoptedStyleSheets[0], 'hoja base compartida');
  assert.equal(a.adoptedStyleSheets[1], b.adoptedStyleSheets[1], 'hoja del componente compartida');
  assert.equal(GasUi.adopt(null), false);
});

test('adopt sin adoptedStyleSheets cae a <style> una sola vez y en orden', () => {
  const GasUi = loadGasUi();
  const nodes = [];
  const make = () => {
    const node = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    node.after = (n) => nodes.splice(nodes.indexOf(node) + 1, 0, n);
    return node;
  };
  const target = {
    ownerDocument: { createElement: make },
    querySelector: (sel) => nodes.find((n) => sel.includes(`"${n.attrs['data-gt-sheet']}"`)) || null,
    prepend: (n) => nodes.unshift(n),
  };
  GasUi.adopt(target, '.y{}');
  GasUi.adopt(target, '.y{}');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].textContent, GasUi.BASE_CSS);
  assert.equal(nodes[1].textContent, '.y{}');
});

test('icon() cubre todos los iconos que usan el chat y los bloques de código', () => {
  const GasUi = loadGasUi();
  const chat = read('extension/js/components/gas-chat-panel.js');
  const names = new Set(['info', 'warn', 'error', 'success', 'copy', 'insert', 'replace', 'apply']);
  for (const m of chat.matchAll(/_icon_\(([^)]*)\)/g)) {
    for (const lit of m[1].matchAll(/'([A-Za-z]+)'/g)) names.add(lit[1]);
  }
  for (const m of chat.matchAll(/\bicon\s*[:=]\s*'([A-Za-z]+)'/g)) names.add(m[1]);
  assert.ok(names.size > 30, `se esperaban >30 iconos, hay ${names.size}`);
  const missing = [...names].filter((n) => !GasUi.ICON_NAMES.includes(n) || !GasUi.icon(n).startsWith('<svg'));
  assert.deepEqual(missing, []);
  assert.equal(GasUi.icon('nope'), '');
  assert.equal(GasUi.icon('constructor'), '', 'no expone claves del prototipo');
  assert.match(GasUi.icon('close', 20), /width="20" height="20"/);
});

test('icon() cubre los iconos de los paneles migrados (acciones, archivo actual, GitHub)', () => {
  const GasUi = loadGasUi();
  const names = new Set();
  const files = [
    'extension/js/components/gas-current-file.js',
    'extension/js/components/gas-actions-panel.js',
    ...list('extension/js/components', '.js').filter((f) => f.includes('gas-github-panel')),
  ];
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/(?:GasUi\.icon|_ico_|_icoNode_)\(([^)]*)\)/g)) {
      for (const lit of m[1].matchAll(/'([A-Za-z]+)'/g)) names.add(lit[1]);
    }
    for (const m of src.matchAll(/GasUi\.iconNode\(document,\s*'([A-Za-z]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/\bicon:\s*'([A-Za-z]+)'/g)) names.add(m[1]);
    for (const m of src.matchAll(/iconByStatus = \{([\s\S]*?)\}/g)) {
      for (const lit of m[1].matchAll(/'([A-Za-z]+)'/g)) names.add(lit[1]);
    }
    for (const m of src.matchAll(/_(?:phase|file)IconName_\([^)]*\)\s*\{([\s\S]*?)\n {2}\},/g)) {
      for (const lit of m[1].matchAll(/return (?:p\.icon \|\| )?'([A-Za-z]+)'/g)) names.add(lit[1]);
    }
  }
  assert.ok(names.size > 30, `se esperaban >30 iconos, hay ${names.size}`);
  const missing = [...names].filter((n) => !GasUi.ICON_NAMES.includes(n));
  assert.deepEqual(missing, []);
});

test('liveAnchor re-resuelve un ancla desconectada y confirm respeta signal', async () => {
  const visible = { isConnected: true, getBoundingClientRect: () => ({ width: 30, height: 30 }) };
  const hidden = { isConnected: true, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const GasUi = loadGasUi({ document: { querySelectorAll: () => [hidden, visible] } });
  assert.equal(GasUi.liveAnchor(visible, '#x'), visible);
  assert.equal(GasUi.liveAnchor({ isConnected: false }, '#x'), visible);
  assert.equal(GasUi.liveAnchor(null, '#x'), visible);
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal(await GasUi.confirm({ ownerDocument: {} }, { title: 't', signal: ctrl.signal }), false);
});

test('DomUtils.assetUrl solo acepta bases chrome-extension://', () => {
  const ctx = { window: {} };
  vm.runInNewContext(`${read('extension/js/services/dom-utils.js')}\nthis.D = DomUtils;`, ctx);
  const D = ctx.D;
  assert.equal(D.assetUrl('a.css'), '');
  D.setAssetsBaseUrl('https://evil.example/');
  assert.equal(D.assetUrl('a.css'), '');
  D.setAssetsBaseUrl('chrome-extension://0f6c1a2b-aaaa-bbbb-cccc-1234567890ab/');
  assert.equal(D.assetUrl('/src/vendor/x.css'), 'chrome-extension://0f6c1a2b-aaaa-bbbb-cccc-1234567890ab/src/vendor/x.css');
});

test('positionPopover hace flip arriba sin espacio y devuelve false sin ancla', () => {
  const GasUi = loadGasUi();
  const props = {};
  const pop = {
    style: { setProperty: (k, v) => { props[k] = v; } },
    dataset: {},
    ownerDocument: { defaultView: { innerWidth: 400, innerHeight: 300 } },
    getBoundingClientRect: () => ({ width: 100, height: 120 }),
  };
  const anchor = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 50, right: 90, top: 250, bottom: 270, width: 40, height: 20 }),
  };
  assert.equal(GasUi.positionPopover(pop, () => anchor, { gap: 8 }), true);
  assert.equal(pop.dataset.placement, 'top');
  assert.equal(pop.style.top, '122px');
  assert.equal(pop.style.left, '50px');
  assert.equal(props['--gt-arrow-x'], '20px');
  assert.equal(GasUi.positionPopover(pop, () => null), false);
  assert.equal(GasUi.positionPopover(pop, { isConnected: false }), false);
});

test('gas-ui.js se carga antes de los componentes en el IDE y en el Side Panel', () => {
  const inject = read('extension/js/main-functions.js');
  const dom = inject.indexOf("'extension/js/services/dom-utils.js'");
  const ui = inject.indexOf("'extension/js/shared/gas-ui.js'");
  assert.ok(dom >= 0 && ui > dom, 'gas-ui.js tras dom-utils.js');
  assert.ok(ui < inject.indexOf("'extension/js/components/"), 'gas-ui.js antes de los componentes');
  assert.ok(!inject.slice(dom, ui).includes("'extension/js/", 1), 'justo después de dom-utils.js');

  const html = read('extension/html/sidepanel.html');
  const at = html.indexOf('../js/shared/gas-ui.js');
  assert.ok(at > 0 && at < html.indexOf('../js/components/gas-chat-panel.js'));
});

/** Convierte un patrón de web_accessible_resources en RegExp. */
const warPattern = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

test('web_accessible_resources cubre exactamente lo que se carga desde la página', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const entries = manifest.web_accessible_resources;
  assert.equal(entries.length, 1);
  const [war] = entries;
  assert.deepEqual(war.matches, ['https://script.google.com/*']);
  assert.equal(war.use_dynamic_url, true, 'ids dinámicos: la página no puede sondear el id estático');
  const patterns = war.resources.map(warPattern);
  const exposed = (file) => patterns.some((re) => re.test(file));

  const inject = read('extension/js/main-functions.js');
  const listStart = inject.indexOf('const scriptPaths');
  const scripts = [...inject.slice(listStart, inject.indexOf('];', listStart)).matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  const htmls = [...inject.slice(inject.indexOf('async function loadResources'), inject.indexOf('async function injectScripts'))
    .matchAll(/'(extension\/html\/[^']+\.html)'/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 20 && htmls.length === 4, `scripts=${scripts.length} html=${htmls.length}`);
  const needed = [...scripts, ...htmls];
  for (const file of needed) {
    assert.ok(exposed(file), `${file} debe ser web-accesible`);
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} existe`);
  }
  // assetsBaseUrl se deriva de un recurso web-accesible (id dinámico).
  assert.match(inject, /const probe = 'extension\/js\/gas-tools-main\.js'/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/vendor/diff2html')), 'Diff2Html eliminado (no funcionaba con Trusted Types)');

  // Menor privilegio: sin comodines ni recursos que la página no carga.
  for (const res of war.resources) {
    assert.ok(!res.includes('*'), `sin comodines: ${res}`);
    assert.ok(needed.includes(res), `recurso no usado por la página: ${res}`);
  }
  for (const priv of ['extension/background.js', 'extension/js/main-functions.js', 'extension/js/shared/llm-bridge.js',
    'extension/js/services/github-api.js', 'extension/js/services/google-api.js', 'extension/html/sidepanel.html']) {
    assert.ok(!exposed(priv), `${priv} no debe ser web-accesible`);
  }
});
