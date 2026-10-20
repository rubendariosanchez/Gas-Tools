// Tests del diff del panel de GitHub: SHA de blob de git, origen a tres vías,
// render compacto (hunks, números de línea, escape, intra-línea, aviso de diff
// grande), bloqueo del push, baseSha tras push/pull y descargas mínimas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { callGithubApi, fetchBlobs, fetchRepoTree, parseRepo, pushFiles } from '../extension/js/services/github-api.js';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Carga DomUtils, GasLineDiff, jsdiff y los mixins de sync/diff en un mismo contexto. */
function loadEnv() {
  const ctx = {
    console, TextEncoder, crypto: globalThis.crypto,
    setTimeout: (fn) => { fn(); return 0; },
    requestAnimationFrame: (fn) => fn(),
    document: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const file of [
    'extension/js/services/dom-utils.js',
    'extension/js/shared/line-diff.js',
    'src/vendor/diff/diff.min.js',
    'extension/js/components/gas-github-panel-sync.js',
    'extension/js/components/gas-github-panel-diff.js',
  ]) vm.runInContext(read(file), ctx, { filename: file });
  vm.runInContext('globalThis.__env = { DomUtils, GasLineDiff, GasGithubPanelSyncMixin, GasGithubPanelDiffMixin };', ctx);
  return { ctx, ...ctx.__env };
}

const ENV = loadEnv();
const SHA_P = 'a'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_R = 'b'.repeat(40);

/** Instancia mínima del panel con los mixins reales y el resto de dependencias simuladas. */
function makePanel(overrides = {}) {
  const calls = { api: [], bridge: [], toasts: [] };
  const panel = Object.assign({}, ENV.GasGithubPanelSyncMixin, ENV.GasGithubPanelDiffMixin, {
    _project: { repo: 'me/repo', branch: 'main', basePath: '' },
    _scriptId: 'script1',
    _diffItems: [],
    _selectedFiles: new Set(),
    _diffGen: 0,
    _loadingDiff: false,
    _commitMessage: 'msg',
    _pushBlobCache: null,
    _postPushSnapshot: null,
    _remoteCommitSha: null,
    _expandedDiffPaths: null,
    shadowRoot: { getElementById: () => null },
    _ico_: (name) => `<i data-ico="${name}"></i>`,
    _toast_: (text) => calls.toasts.push(text),
    _log_: () => {},
    _lockTab_: () => {}, _unlockTab_: () => {},
    _refreshFooterButtons_: () => {}, _renderTabBody_: () => {}, _renderConnectedView_: () => {},
    _setBodyBusy_: () => {}, _triggerGasSave_: () => {},
    _openProgress_: () => {}, _setProgressPhase_: () => {}, _finishProgress_: () => {},
    _closeProgress_: () => {}, _markProgressFile_: () => {}, _yieldToUi_: async () => {},
    _handleAuthError_: async () => false,
    _bridgeCall_: async (evt, payload) => { calls.bridge.push({ evt, payload: plain(payload) }); return { ok: true }; },
    _ghApi_: async (action, payload) => { calls.api.push({ action, payload: plain(payload) }); return { ok: false, error: 'not stubbed' }; },
  }, overrides);
  return { panel, calls };
}

const sha = (text) => ENV.GasGithubPanelDiffMixin._gitBlobSha_(text);

// ── SHA de blob ────────────────────────────────────────────────────────

test('_gitBlobSha_ coincide con git hash-object (incluye no ASCII y longitud en bytes UTF-8)', async () => {
  assert.equal(await sha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  const src = 'function myFunction() {\n  Logger.log("¡Hola, año 2026! ñ €");\n}\n';
  // printf '...' | git hash-object --stdin
  assert.equal(await sha(src), '64f22773394c406b9f82500749bfab7d57fa87eb');
  // El contenido de GAS (CRLF, sin salto final) se hashea en la forma que sube el push.
  const { _pushForm_ } = ENV.GasGithubPanelDiffMixin;
  assert.equal(await sha(_pushForm_('function myFunction() {\r\n  Logger.log("¡Hola, año 2026! ñ €");\r\n}')), '64f22773394c406b9f82500749bfab7d57fa87eb');
});

// ── Origen a tres vías ─────────────────────────────────────────────────

/** Escenario con todos los casos de la tabla de origen. */
async function scenario() {
  const B = {
    'a.gs': 'a1', 'b.gs': 'b1', 'c.gs': 'c1', 'd.gs': 'd1', 'e.gs': 'e1', 'h.gs': 'h1', 'i.gs': 'i1',
  };
  const R = {
    'a.gs': 'a1', 'b.gs': 'b2', 'c.gs': 'c3', 'd.gs': 'd1', 'e.gs': 'e2', 'g.gs': 'g1', 'i.gs': 'i1', 'j.gs': 'x\r\ny\r\n',
  };
  const L = {
    'a.gs': 'a2', 'b.gs': 'b1', 'c.gs': 'c2', 'd.gs': 'd1', 'e.gs': 'e2', 'f.gs': 'f1', 'h.gs': 'h1', 'j.gs': 'x\r\ny',
  };
  // Remoto y base guardan la forma que sube el push (LF + salto final), salvo j.gs.
  const form = (s) => (s.endsWith('\n') ? s : `${s}\n`);
  const blobs = new Map();
  const toTree = async (obj) => {
    const m = new Map();
    for (const [p, c] of Object.entries(obj)) {
      const s = await sha(form(c));
      blobs.set(s, form(c));
      m.set(p, { sha: s });
    }
    return m;
  };
  const remote = await toTree(R);
  const base = await toTree(B);
  const local = new Map(Object.entries(L));
  const fetched = [];
  const fetchBlobs = async (shas) => {
    fetched.push([...shas]);
    return new Map(shas.map((s) => [s, blobs.get(s)]));
  };
  return { local, remote, base, fetchBlobs, fetched };
}

test('origen local / remoto / conflicto / sin cambios y descarga solo de lo que difiere', async () => {
  const { panel } = makePanel();
  const s = await scenario();
  const items = await panel._buildDiffItems_(s);
  const by = Object.fromEntries(items.map((i) => [i.path, i]));

  assert.deepEqual(
    Object.fromEntries(items.map((i) => [i.path, [i.status, i.origin]])),
    {
      'a.gs': ['mod', 'local'],
      'b.gs': ['mod', 'remote'],
      'c.gs': ['mod', 'conflict'],
      'd.gs': ['eq', null],
      'e.gs': ['eq', null],         // mismo cambio en los dos lados
      'f.gs': ['add', 'local'],     // nuevo en GAS
      'g.gs': ['del', 'remote'],    // nuevo en GitHub
      'h.gs': ['add', 'remote'],    // borrado en GitHub
      'i.gs': ['del', 'local'],     // borrado en GAS
      'j.gs': ['eq', null],         // solo difieren CRLF y el salto final
    },
  );
  assert.equal(by['c.gs'].base, 'c1', 'el contenido base solo se guarda en conflictos');
  assert.equal(by['a.gs'].base, undefined);
  assert.equal(by['a.gs'].local, 'a2');
  assert.equal(by['a.gs'].remote, 'a1');
  assert.deepEqual([by['a.gs'].plus, by['a.gs'].minus], [1, 1]);

  // 1.ª descarga: blobs remotos cuyo SHA no coincide con el local; 2.ª: base de los conflictos.
  const remoteSha = (p) => s.remote.get(p).sha;
  assert.equal(s.fetched.length, 2);
  assert.deepEqual(s.fetched[0].sort(), ['a.gs', 'b.gs', 'c.gs', 'g.gs', 'i.gs', 'j.gs'].map(remoteSha).sort());
  assert.ok(!s.fetched[0].includes(remoteSha('d.gs')) && !s.fetched[0].includes(remoteSha('e.gs')));
  assert.deepEqual(s.fetched[1], [s.base.get('c.gs').sha]);
});

test('sin baseSha: comparación de dos vías con origen unknown y sin descargar la base', async () => {
  const { panel } = makePanel();
  const s = await scenario();
  const items = await panel._buildDiffItems_({ ...s, base: null });
  const changed = items.filter((i) => i.status !== 'eq');
  assert.ok(changed.length >= 6);
  assert.ok(changed.every((i) => i.origin === 'unknown'));
  assert.equal(s.fetched.length, 1);

  // Criterio heredado: sin base, solo bloquea el push lo que existe solo en GitHub.
  panel._diffItems = items;
  panel._selectedFiles = new Set(['a.gs']);
  assert.equal(panel._pullRequired_(), false);
  panel._selectedFiles.add('g.gs');
  assert.equal(panel._pullRequired_(), true);

  // El aviso aparece en la pestaña.
  assert.match(panel._baseNoticeHtml_(), /No previous sync recorded/);
});

test('un blob remoto no descargable o > 1 MB deja solo ese archivo como no disponible', async () => {
  const { panel } = makePanel();
  const s = await scenario();
  s.remote.set('big.gs', { sha: 'f'.repeat(40), tooLarge: true });
  const failing = s.remote.get('b.gs').sha;
  const items = await panel._buildDiffItems_({
    ...s,
    fetchBlobs: async (shas) => {
      const got = await s.fetchBlobs(shas);
      got.delete(failing);
      return got;
    },
  });
  const by = Object.fromEntries(items.map((i) => [i.path, i]));
  assert.equal(by['b.gs'].unavailable, 'failed');
  assert.equal(by['big.gs'].unavailable, 'tooLarge');
  assert.equal(by['big.gs'].status, 'del');
  assert.equal(by['a.gs'].origin, 'local', 'el resto se clasifica normalmente');
  assert.ok(s.fetched.flat().every((x) => x !== 'f'.repeat(40)), 'no se pide el blob grande');

  // No bloquean el push, no entran en el pull y se explican en la tarjeta.
  assert.equal(panel._pullExclusion_(by['b.gs']), 'unavailable');
  assert.match(panel._renderDiffOriginBadge_(by['big.gs']), /Not available/);
  assert.match(panel._diffBodyHtml_(by['big.gs']), /Larger than 1 MB/);
});

test('_normContent_ quita solo un salto final; el pull escribe el texto remoto sin recortar', async () => {
  const { panel } = makePanel();
  assert.equal(panel._normContent_('a\r\n\n'), 'a\n');
  const remoteRaw = 'line\n';
  const items = await panel._buildDiffItems_({
    local: new Map([['a.gs', 'old']]),
    remote: new Map([['a.gs', { sha: await sha(remoteRaw) }]]),
    base: null,
    fetchBlobs: async (shas) => new Map(shas.map((x) => [x, remoteRaw])),
  });
  assert.equal(items[0].remoteRaw, 'line\n');
  assert.equal(items[0].remote, 'line');
});

test('árbol incompleto: una ausencia no se toma como borrado y no entra en el pull', async () => {
  const { panel } = makePanel();
  const s = await scenario();
  const items = await panel._buildDiffItems_({ ...s, remoteIncomplete: true, baseIncomplete: true });
  const by = Object.fromEntries(items.map((i) => [i.path, i]));
  assert.deepEqual([by['h.gs'].origin, by['h.gs'].uncertain], ['unknown', true], 'h.gs no es "borrado en GitHub"');
  assert.deepEqual([by['g.gs'].origin, by['g.gs'].uncertain], ['unknown', true], 'g.gs no es "nuevo en GitHub"');
  assert.equal(panel._pullExclusion_(by['g.gs']), 'uncertain');
  panel._diffItems = items;
  panel._treeIncomplete = true;
  assert.match(panel._baseNoticeHtml_(), /too large to compare completely/);
});

test('diff aproximado (presupuesto agotado): +x −y con "~"', () => {
  const { panel } = makePanel();
  assert.match(panel._deltaHtml_({ status: 'mod', origin: 'local', plus: 5, minus: 4, approx: true }), /~\+5<\/span> <span class="del">~−4/);
});

// ── Push / pull ────────────────────────────────────────────────────────

test('el push no se bloquea por cambios solo locales', () => {
  const { panel } = makePanel();
  panel._diffItems = [
    { path: 'a.gs', status: 'mod', origin: 'local' },
    { path: 'f.gs', status: 'add', origin: 'local' },
    { path: 'b.gs', status: 'mod', origin: 'remote' },
    { path: 'c.gs', status: 'mod', origin: 'conflict' },
  ];
  panel._selectedFiles = new Set(['a.gs', 'f.gs']);
  assert.equal(panel._pullRequired_(), false);
  panel._selectedFiles.add('b.gs');
  assert.equal(panel._pullRequired_(), true, 'un archivo de GitHub seleccionado sí bloquea');
  panel._selectedFiles = new Set(['a.gs', 'c.gs']);
  assert.equal(panel._pullRequired_(), true, 'un conflicto seleccionado sí bloquea');
  panel._loadingDiff = true;
  assert.equal(panel._pullRequired_(), true, 'mientras se recalcula, bloquea');
});

/** Panel listo para un push de a.gs. */
function pushPanel(extraItems = [], data = { commitSha: SHA_C, parentSha: SHA_P }) {
  const made = makePanel({
    _fetchProjectFromApi_: async () => [{ path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'a2' }],
  });
  const { panel, calls } = made;
  panel._remoteCommitSha = SHA_P;
  panel._diffItems = [{ path: 'a.gs', status: 'mod', origin: 'local', local: 'a2', remote: 'a1', plus: 1, minus: 1 }, ...extraItems];
  panel._selectedFiles = new Set(['a.gs']);
  panel._ghApi_ = async (action, payload) => {
    calls.api.push({ action, payload: plain(payload) });
    return action === 'PUSH_FILES' ? { ok: true, data } : { ok: false };
  };
  return made;
}

test('baseSha se fija al commit del push y se persiste en la config del proyecto', async () => {
  const { panel, calls } = pushPanel([{ path: 'f.gs', status: 'add', origin: 'local' }]);
  await panel._push_();
  assert.equal(panel._project.baseSha, SHA_C);
  const save = calls.bridge.find((c) => c.evt === 'GAS_GH_SAVE_PROJECT');
  assert.equal(save.payload.config.baseSha, SHA_C);
  assert.equal(save.payload.scriptId, 'script1');
  assert.equal(panel._remoteCommitSha, SHA_C);
  // Snapshot post-push con el SHA real del blob subido.
  assert.equal(panel._postPushSnapshot.files.get('a.gs').sha, await sha('a2\n'));
  assert.equal(panel._diffItems.find((i) => i.path === 'a.gs').status, 'eq');
});

test('el push no mueve la base si deja cambios de GitHub sin traer o hubo auto-rebase', async () => {
  const left = pushPanel([{ path: 'b.gs', status: 'mod', origin: 'remote' }]);
  left.panel._project.baseSha = SHA_R;
  await left.panel._push_();
  assert.equal(left.panel._project.baseSha, SHA_R);

  const rebased = pushPanel([], { commitSha: SHA_C, parentSha: 'd'.repeat(40) });
  await rebased.panel._push_();
  assert.equal(rebased.panel._project.baseSha, undefined);
  assert.equal(rebased.panel._remoteCommitSha, null);
});

test('baseSha se fija al commit remoto comparado tras un pull correcto', async () => {
  const { panel, calls } = makePanel({
    _showPullConfirm_: async function (opts) { return { confirmed: true, reload: false, selected: new Set(opts.files.filter((f) => this._pullRowDefault_(f).checked).map((f) => f.path)) }; },
    _fetchProjectFromApi_: async () => [{ path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'a1' }],
    _pushProjectToApi_: async () => true,
  });
  panel._recomputeDiff_ = async () => {};
  panel._remoteCommitSha = SHA_R;
  panel._diffItems = [{ path: 'a.gs', status: 'mod', origin: 'remote', local: 'a1', remote: 'a2', plus: 1, minus: 1 }];
  await panel._pull_();
  assert.equal(panel._project.baseSha, SHA_R);
  assert.ok(calls.bridge.some((c) => c.evt === 'GAS_GH_SAVE_PROJECT' && c.payload.config.baseSha === SHA_R));
});

test('cambiar de rama descarta la base de sincronización', async () => {
  const { panel } = makePanel({ isBusy: () => false, _recomputeDiff_: async () => {}, _updateAnchorBadge_: () => {} });
  panel._project.baseSha = SHA_R;
  await panel._onBranchChange_('dev');
  assert.equal(panel._project.branch, 'dev');
  assert.equal(panel._project.baseSha, undefined);
});

test('_recomputeDiff_ pide el árbol con baseSha y solo descarga los blobs que difieren', async () => {
  const same = 'same\n';
  const remoteChanged = 'remote\n';
  const { panel, calls } = makePanel({
    _fetchProjectFromApi_: async () => [
      { path: 'same.gs', source: 'same' },
      { path: 'mine.gs', source: 'mine' },
    ],
  });
  panel._project.baseSha = SHA_P;
  const tree = {
    commitSha: SHA_R,
    files: [
      { path: 'same.gs', sha: await sha(same), size: 5 },
      { path: 'mine.gs', sha: await sha(remoteChanged), size: 7 },
      { path: 'README.md', sha: await sha('# x\n'), size: 4 },
    ],
    baseFiles: [
      { path: 'same.gs', sha: await sha(same), size: 5 },
      { path: 'mine.gs', sha: await sha(remoteChanged), size: 7 },
    ],
    baseSha: SHA_P,
    baseMissing: false,
  };
  panel._ghApi_ = async (action, payload) => {
    calls.api.push({ action, payload: plain(payload) });
    if (action === 'FETCH_TREE') return { ok: true, data: tree };
    if (action === 'FETCH_BLOBS') return { ok: true, data: { blobs: Object.fromEntries(payload.shas.map((s) => [s, remoteChanged])) } };
    return { ok: false };
  };
  await panel._recomputeDiff_();
  const treeCall = calls.api.find((c) => c.action === 'FETCH_TREE');
  assert.equal(treeCall.payload.baseSha, SHA_P);
  const blobCalls = calls.api.filter((c) => c.action === 'FETCH_BLOBS');
  assert.equal(blobCalls.length, 1);
  assert.deepEqual(blobCalls[0].payload.shas, [await sha(remoteChanged)]);
  assert.deepEqual(plain(panel._diffItems.map((i) => [i.path, i.status, i.origin])), [
    ['mine.gs', 'mod', 'local'],
    ['same.gs', 'eq', null],
  ]);
  assert.equal(panel._remoteCommitSha, SHA_R);
  assert.deepEqual([...panel._selectedFiles], ['mine.gs']);
});

// ── Render compacto ────────────────────────────────────────────────────

const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

/** Filas [clase, nº GitHub, nº GAS] del HTML del diff. */
const rowsOf = (html) => [...html.matchAll(/<tr class="qc__gh-dRow (qc__gh-d\w+)"><td class="qc__gh-dNum">(\d*)<\/td><td class="qc__gh-dNum qc__gh-dNum2">(\d*)<\/td>/g)]
  .map((m) => [m[1].replace('qc__gh-d', ''), m[2], m[3]]);

test('hunks con contexto 3, cabecera @@, números de línea y contexto plegado', () => {
  const { panel } = makePanel();
  const remote = lines(20);
  const local = lines(20, (i) => (i === 10 ? 'line ten' : `line ${i}`));
  const item = { path: 'a.gs', status: 'mod', local, remote };
  const html = panel._diffBodyHtml_(item);
  assert.match(html, />GitHub<\/th>/);
  assert.match(html, />GAS<\/th>/);
  assert.match(html, /@@ -7,7 \+7,7 @@/);
  assert.match(html, /data-fold="0"[^>]*>.*Show 6 lines/);
  assert.match(html, /data-fold="1"[^>]*>.*Show 7 lines/);
  assert.deepEqual(rowsOf(html), [
    ['Eq', '7', '7'], ['Eq', '8', '8'], ['Eq', '9', '9'],
    ['Del', '10', ''], ['Add', '', '10'],
    ['Eq', '11', '11'], ['Eq', '12', '12'], ['Eq', '13', '13'],
  ]);

  // Desplegar el primer tramo muestra las líneas 1-6 con sus números.
  panel._diffFoldsOpen = new Map([['a.gs', new Set([0])]]);
  const open = panel._diffBodyHtml_(item);
  assert.doesNotMatch(open, /Show 6 lines/);
  assert.deepEqual(rowsOf(open).slice(0, 2), [['Eq', '1', '1'], ['Eq', '2', '2']]);
  assert.match(open, /Show 7 lines/);
});

test('archivo nuevo: cabecera -0,0 y solo altas; singular en "Show 1 line"', () => {
  const { panel } = makePanel();
  const html = panel._diffBodyHtml_({ path: 'n.gs', status: 'add', local: 'x\ny', remote: '' });
  assert.match(html, /@@ -0,0 \+1,2 @@/);
  assert.deepEqual(rowsOf(html), [['Add', '', '1'], ['Add', '', '2']]);

  const one = panel._diffBodyHtml_({ path: 'o.gs', status: 'mod', remote: lines(8), local: lines(8, (i) => (i === 4 ? 'four' : `line ${i}`)) });
  assert.match(one, /Show 1 line</);
});

test('escapa HTML en las líneas y en las rutas', () => {
  const { panel } = makePanel();
  const item = {
    path: '<img src=x onerror=alert(1)>.gs', status: 'mod', origin: 'local', plus: 1, minus: 1,
    remote: 'ok', local: '<script>alert("x")</script>',
  };
  const card = panel._renderDiffCard_(item);
  const body = panel._diffBodyHtml_(item);
  const row = panel._renderChangeRow_(item);
  for (const html of [card, body, row]) {
    assert.ok(!/<img|<script/i.test(html), html);
  }
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;\.gs/);
  assert.match(body, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test('resaltado intra-línea en pares borrado/añadido (escapado)', () => {
  const { panel } = makePanel();
  const html = panel._diffBodyHtml_({
    path: 'a.gs', status: 'mod',
    remote: 'const total = price * qty;\nif (a < b) {}',
    local: 'const total = price * quantity;\nif (a <= b) {}',
  });
  assert.match(html, /<span class="qc__gh-dWordDel">qty<\/span>/);
  assert.match(html, /<span class="qc__gh-dWordAdd">quantity<\/span>/);
  assert.match(html, /if \(a &lt;<span class="qc__gh-dWordAdd">=<\/span> b\)/);
  assert.ok(!html.includes('a < b'));

  // Sin nada en común no se resalta (la línea entera ya está marcada).
  const none = panel._intraLineHtml_('foo', 'bar');
  assert.equal(none, null);
});

test('aviso de diff demasiado grande (presupuesto agotado o demasiadas filas)', () => {
  const { panel } = makePanel();
  const big = { path: 'big.gs', status: 'mod', remote: lines(800, (i) => `a${i}`), local: lines(800, (i) => `b${i}`) };
  assert.match(panel._diffBodyHtml_(big), /This diff is too large to show here/);

  const over = { path: 'o.gs', status: 'mod', remote: 'a', local: 'b' };
  const ops = ENV.GasLineDiff.diffLines('a', 'b');
  Object.defineProperty(ops, 'overBudget', { value: true });
  Object.defineProperty(over, 'ops', { value: ops });
  const html = panel._diffBodyHtml_(over);
  assert.match(html, /qc__gh-diffTooLarge/);
  assert.doesNotMatch(html, /qc__gh-diffViewerLink/, 'sin visor no se ofrece el enlace');
});

test('tarjeta: badge de origen, +x −y exacto y botón del visor solo si existe gasDiffViewer', () => {
  const { panel } = makePanel();
  const item = { path: 'a.gs', status: 'mod', origin: 'conflict', plus: 3, minus: 2 };
  const card = panel._renderDiffCard_(item);
  assert.match(card, /qc__gh-diffOrigin conflict/);
  assert.match(card, />Conflict</);
  assert.match(card, /\+3<\/span> <span class="del">−2/);
  assert.doesNotMatch(card, /qc__gh-diffViewerBtn/);

  const opened = [];
  ENV.ctx.gasDiffViewer = { open: (o) => opened.push(o) };
  try {
    assert.match(panel._renderDiffCard_(item), /qc__gh-diffViewerBtn/);
    panel._diffItems = [item, { path: 'z.gs', status: 'eq' }];
    panel._openDiffViewer_('a.gs');
    assert.equal(opened[0].activePath, 'a.gs');
    assert.deepEqual(opened[0].items.map((i) => i.path), ['a.gs']);
  } finally {
    delete ENV.ctx.gasDiffViewer;
  }

  const labels = [
    [{ status: 'mod', origin: 'local' }, 'Changed in GAS'],
    [{ status: 'add', origin: 'local' }, 'New in GAS'],
    [{ status: 'del', origin: 'local' }, 'Deleted in GAS'],
    [{ status: 'mod', origin: 'remote' }, 'Changed on GitHub'],
    [{ status: 'del', origin: 'remote' }, 'New on GitHub'],
    [{ status: 'add', origin: 'remote' }, 'Deleted on GitHub'],
    [{ status: 'mod', origin: 'unknown' }, 'Unknown origin'],
    [{ status: 'add', origin: 'unknown' }, 'GAS only'],
  ];
  for (const [it, label] of labels) assert.match(panel._renderDiffOriginBadge_(it), new RegExp(`>${label}<`));
});

// ── github-api: árbol y blobs ──────────────────────────────────────────

/** Sustituye fetch por un repo en memoria y mide la concurrencia de blobs. */
function fakeGithub({ heads, trees, blobs, failCommit = new Set() }) {
  const stats = { inFlight: 0, maxInFlight: 0, blobCalls: [] };
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    let m;
    if ((m = u.pathname.match(/\/git\/ref\/heads\/(.+)$/))) return json({ object: { sha: heads[decodeURIComponent(m[1])] } });
    if ((m = u.pathname.match(/\/git\/commits\/(\w+)$/))) {
      if (failCommit.has(m[1])) return new Response('{"message":"Not Found"}', { status: 404 });
      return json({ tree: { sha: `tree-${m[1]}` } });
    }
    if ((m = u.pathname.match(/\/git\/trees\/tree-(\w+)$/))) return json({ truncated: false, tree: trees[m[1]] });
    if ((m = u.pathname.match(/\/git\/blobs\/(\w+)$/))) {
      stats.blobCalls.push(m[1]);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      stats.inFlight--;
      return json({ encoding: 'base64', content: Buffer.from(blobs[m[1]] ?? '', 'utf8').toString('base64') });
    }
    return new Response('{}', { status: 404 });
  };
  return stats;
}

test('FETCH_BLOBS: concurrencia máxima 6, sin duplicados ni SHAs inválidos', async () => {
  const realFetch = globalThis.fetch;
  try {
    const shas = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(40, '0'));
    const stats = fakeGithub({ heads: {}, trees: {}, blobs: Object.fromEntries(shas.map((s, i) => [s, `ñ${i}`])) });
    const res = await fetchBlobs('tok', { repo: 'me/repo', shas: [...shas, shas[0], 'nope'] });
    assert.equal(stats.blobCalls.length, 20);
    assert.ok(stats.maxInFlight <= 6 && stats.maxInFlight > 1, `máx ${stats.maxInFlight}`);
    assert.equal(res.blobs[shas[3]], 'ñ3');
    assert.deepEqual(res.failed, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FETCH_TREE: SHAs de rama y base sin descargar contenido; base reutilizada o ausente', async () => {
  const realFetch = globalThis.fetch;
  try {
    const head = '1'.repeat(40);
    const old = '2'.repeat(40);
    const gone = '3'.repeat(40);
    const stats = fakeGithub({
      heads: { main: head },
      trees: {
        [head]: [{ path: 'src/a.gs', sha: 'x'.repeat(40), type: 'blob', size: 3 }, { path: 'other/b.gs', sha: 'y'.repeat(40), type: 'blob', size: 3 }],
        [old]: [{ path: 'src/a.gs', sha: 'z'.repeat(40), type: 'blob', size: 3 }],
      },
      blobs: {},
      failCommit: new Set([gone]),
    });
    const withBase = await fetchRepoTree('tok', { repo: 'me/repo', branch: 'main', basePath: '/src/', baseSha: old });
    assert.equal(withBase.commitSha, head);
    assert.deepEqual(withBase.files, [{ path: 'a.gs', sha: 'x'.repeat(40), size: 3 }]);
    assert.deepEqual(withBase.baseFiles, [{ path: 'a.gs', sha: 'z'.repeat(40), size: 3 }]);
    assert.equal(withBase.baseSha, old);
    assert.equal(stats.blobCalls.length, 0, 'el árbol no descarga blobs');

    const sameBase = await fetchRepoTree('tok', { repo: 'me/repo', branch: 'main', baseSha: head });
    assert.equal(sameBase.baseFiles, sameBase.files);

    const missing = await fetchRepoTree('tok', { repo: 'me/repo', branch: 'main', baseSha: gone });
    assert.equal(missing.baseFiles, null);
    assert.equal(missing.baseSha, null);
    assert.equal(missing.baseMissing, true);

    const noBase = await fetchRepoTree('tok', { repo: 'me/repo', branch: 'main', baseSha: 'not-a-sha' });
    assert.equal(noBase.baseFiles, null);
    assert.equal(noBase.baseMissing, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Fallos reproducidos por QA (corregidos) ─────────────────────────────────

test('BUG: pull durante el recálculo tras cambiar de rama aplica la rama anterior y fija su base en la nueva', async () => {
  let pushedToGas = null;
  const { panel } = makePanel({
    isBusy: () => false, _updateAnchorBadge_: () => {},
    _showPullConfirm_: async function (opts) { return { confirmed: true, reload: false, selected: new Set(opts.files.filter((f) => this._pullRowDefault_(f).checked).map((f) => f.path)) }; },
    _fetchProjectFromApi_: async () => [{ path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'a1' }],
    _pushProjectToApi_: async (files) => { pushedToGas = files; return true; },
  });
  // Diff calculado en main (commit SHA_R); el recálculo de dev queda en vuelo.
  panel._remoteCommitSha = SHA_R;
  panel._diffItems = [{ path: 'a.gs', status: 'mod', origin: 'remote', local: 'a1', remote: 'a-main', plus: 1, minus: 1 }];
  panel._recomputeDiff_ = async () => { panel._loadingDiff = true; };
  await panel._onBranchChange_('dev');
  await panel._pull_();
  assert.equal(pushedToGas, null, 'escribió en GAS el contenido de main estando en dev');
  assert.equal(panel._project.baseSha, undefined, 'la base de dev quedó con el commit de main');
});

test('BUG: el push no comprueba el bloqueo ni el recálculo en curso (el botón se habilita mientras carga)', async () => {
  const { panel, calls } = pushPanel([{ path: 'b.gs', status: 'mod', origin: 'remote' }]);
  panel._selectedFiles = new Set(['a.gs', 'b.gs']);
  panel._loadingDiff = true;                     // recálculo en vuelo: _pullRequired_() → false
  assert.equal(panel._pullRequired_(), true, 'durante la carga no se bloquea con los items vigentes');
  await panel._push_();
  assert.ok(!calls.api.some((c) => c.action === 'PUSH_FILES'), 'push lanzado con b.gs (origen GitHub) seleccionado');
});

test('BUG: un recálculo en vuelo iniciado antes del push pisa los items y el SHA remoto posteriores', async () => {
  const { panel, calls } = pushPanel();
  let releaseTree;
  const treeGate = new Promise((r) => { releaseTree = r; });
  const oldTree = { commitSha: SHA_P, files: [{ path: 'a.gs', sha: await sha('a1\n'), size: 3 }], baseFiles: null, baseMissing: false };
  panel._fetchProjectFromApi_ = async () => [{ path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'a2' }];
  panel._ghApi_ = async (action, payload) => {
    calls.api.push({ action, payload: plain(payload) });
    if (action === 'FETCH_TREE') { await treeGate; return { ok: true, data: oldTree }; }
    if (action === 'FETCH_BLOBS') return { ok: true, data: { blobs: { [await sha('a1\n')]: 'a1\n' } } };
    if (action === 'PUSH_FILES') return { ok: true, data: { commitSha: SHA_C, parentSha: SHA_P } };
    return { ok: false };
  };
  const pending = panel._recomputeDiff_();        // árbol antiguo en vuelo
  panel._loadingDiff = false;
  await panel._push_();
  assert.equal(panel._remoteCommitSha, SHA_C);
  releaseTree();
  await pending;
  assert.equal(panel._remoteCommitSha, SHA_C, 'el resultado viejo devolvió _remoteCommitSha al padre');
  assert.equal(panel._diffItems.find((i) => i.path === 'a.gs').status, 'eq', 'a.gs vuelve a parecer pendiente');
});

test('BUG: el push no envía el commit comparado: si la rama avanzó, sobrescribe cambios remotos sin avisar', async () => {
  const { panel, calls } = pushPanel();
  await panel._push_();
  const push = calls.api.find((c) => c.action === 'PUSH_FILES');
  assert.equal(push.payload.expectedParentSha, SHA_P, 'sin expectedParentSha el background no puede rechazar un head distinto');
});

test('BUG: expandir un contexto plegado largo convierte el diff en "demasiado grande"', () => {
  const { panel } = makePanel();
  const remote = lines(3000);
  const local = lines(3000, (i) => (i === 2990 ? 'changed' : `line ${i}`));
  const item = { path: 'a.gs', status: 'mod', local, remote };
  assert.doesNotMatch(panel._diffBodyHtml_(item), /too large/);
  panel._diffFoldsOpen = new Map([['a.gs', new Set([0])]]);   // el usuario pulsa "Mostrar 2986 líneas"
  assert.doesNotMatch(panel._diffBodyHtml_(item), /too large/, 'tras expandir, el diff entero desaparece');
});

test('BUG: un error transitorio al leer el commit base se presenta como "ya no existe en GitHub"', async () => {
  const realFetch = globalThis.fetch;
  try {
    const head = '1'.repeat(40);
    const old = '2'.repeat(40);
    fakeGithub({ heads: { main: head }, trees: { [head]: [], [old]: [] }, blobs: {} });
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes(`/git/commits/${old}`)
      ? new Response('{"message":"Server Error"}', { status: 502 })
      : inner(url, init));
    let res = null;
    try { res = await fetchRepoTree('tok', { repo: 'me/repo', branch: 'main', baseSha: old }); } catch (_) { /* aceptable: reintentar */ }
    assert.ok(!res || res.baseMissing === false, 'un 502 no significa que la base se borrara (force push)');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('BUG: volver a elegir el mismo repositorio descarta baseSha', async () => {
  const { panel } = makePanel({ isBusy: () => false, _updateAnchorBadge_: () => {}, _loadBranches_: () => {}, _recomputeDiff_: async () => {} });
  panel._repos = [{ full_name: 'me/repo', default_branch: 'main' }];
  panel._project.baseSha = SHA_R;
  await panel._onRepoChange_('me/repo');
  assert.equal(panel._project.baseSha, SHA_R);
});

// ── Lote de correcciones: seguridad, pull/push y render ────────────────

const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('S1: repo y rama del MAIN world se validan antes de construir la URL', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return jsonRes([]); };
  try {
    for (const repo of ['../x', 'a/..', 'a/.', 'a/b/../../user', 'a b/c', '', null, 'a/b?x=1', 'a/b#x']) {
      await assert.rejects(callGithubApi('LIST_BRANCHES', 'tok', { repo }), /Invalid repository/, String(repo));
    }
    await assert.rejects(callGithubApi('FETCH_TREE', 'tok', { repo: 'a/b', branch: 'x/../y' }), /Invalid branch/);
    await assert.rejects(callGithubApi('FETCH_BLOBS', 'tok', { repo: '../../user', shas: [] }), /Invalid repository/);
    await assert.rejects(callGithubApi('CREATE_BRANCH', 'tok', { repo: 'a/b', name: 'bad name', fromBranch: 'main' }), /Invalid branch/);
    await assert.rejects(callGithubApi('CREATE_REPO', 'tok', { name: '..' }), /Invalid repository/);
    assert.deepEqual(urls, [], 'ninguna petición con entradas inválidas');

    await callGithubApi('LIST_BRANCHES', 'tok', { repo: 'me-1/my.repo_x' });
    assert.equal(new URL(urls[0]).pathname, '/repos/me-1/my.repo_x/branches');
    assert.deepEqual(plain(parseRepo('me/repo')), { owner: 'me', name: 'repo' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('S1: las ramas con "/" se codifican por segmento', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const u = new URL(url);
    if (u.pathname.includes('/git/ref/heads/')) return jsonRes({ object: { sha: '1'.repeat(40) } });
    if (u.pathname.includes('/git/commits/')) return jsonRes({ tree: { sha: 'ab'.repeat(20) } });
    return jsonRes({ truncated: false, tree: [] });
  };
  try {
    await callGithubApi('FETCH_TREE', 'tok', { repo: 'a/b', branch: 'feature/ñ-x' });
    assert.equal(new URL(urls[0]).pathname, '/repos/a/b/git/ref/heads/feature/%C3%B1-x');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('S3: árbol truncado con un subárbol ilegible falla; por encima del tope queda incomplete', async () => {
  const realFetch = globalThis.fetch;
  const head = '1'.repeat(40);
  try {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.includes('/git/ref/heads/')) return jsonRes({ object: { sha: head } });
      if (u.pathname.includes('/git/commits/')) return jsonRes({ tree: { sha: 'root' } });
      if (u.pathname.endsWith('/git/trees/root') && u.search.includes('recursive')) return jsonRes({ truncated: true, tree: [] });
      if (u.pathname.endsWith('/git/trees/root')) return jsonRes({ tree: [{ path: 'src', type: 'tree', sha: 'sub' }] });
      return jsonRes({ message: 'boom' }, 500);
    };
    await assert.rejects(fetchRepoTree('tok', { repo: 'a/b', branch: 'main' }), /GitHub 500/);

    const many = Array.from({ length: 1001 }, (_, i) => ({ path: `f${i}.gs`, sha: 'e'.repeat(40), type: 'blob', size: 1 }));
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.includes('/git/ref/heads/')) return jsonRes({ object: { sha: head } });
      if (u.pathname.includes('/git/commits/')) return jsonRes({ tree: { sha: 'root' } });
      return jsonRes({ truncated: false, tree: many });
    };
    const res = await fetchRepoTree('tok', { repo: 'a/b', branch: 'main', baseSha: head });
    assert.equal(res.files.length, 1000);
    assert.equal(res.incomplete, true);
    assert.equal(res.baseIncomplete, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('S4: FETCH_BLOBS rechaza blobs de más de 1 MB', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ size: 2_000_000, encoding: 'base64', content: '' });
  try {
    const sha1 = 'a'.repeat(40);
    const res = await fetchBlobs('tok', { repo: 'a/b', shas: [sha1] });
    assert.deepEqual(plain(res), { blobs: {}, failed: [sha1] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** GitHub en memoria para `pushFiles`: head fijo y `compare` configurable. */
function fakePushGithub({ head, compare }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname.includes('/git/ref/heads/')) return jsonRes({ object: { sha: head } });
    if (u.pathname.includes('/compare/')) {
      const [from, to] = u.pathname.split('/compare/')[1].split('...');
      return jsonRes(compare(from, to));
    }
    if (method === 'POST' && u.pathname.endsWith('/git/blobs')) return jsonRes({ sha: 'b'.repeat(40) });
    if (method === 'GET' && u.pathname.includes('/git/commits/')) return jsonRes({ tree: { sha: 't'.repeat(40) } });
    if (method === 'POST' && u.pathname.endsWith('/git/trees')) return jsonRes({ sha: 'd'.repeat(40) });
    if (method === 'POST' && u.pathname.endsWith('/git/commits')) return jsonRes({ sha: 'c'.repeat(40) });
    if (method === 'PATCH') return jsonRes({});
    return jsonRes({}, 404);
  };
  return calls;
}

test('Q4: el push rechaza si la rama avanzó tocando los archivos que se suben', async () => {
  const realFetch = globalThis.fetch;
  const expected = '1'.repeat(40);
  const head = '2'.repeat(40);
  const base = { repo: 'a/b', branch: 'main', basePath: 'src', message: 'm', files: [{ path: 'a.gs', content: 'x\n' }] };
  try {
    // Mismo head: sigue y devuelve el padre comparado.
    fakePushGithub({ head: expected, compare: () => ({}) });
    assert.equal((await pushFiles('tok', { ...base, expectedParentSha: expected })).parentSha, expected);

    // Commits nuevos en otros archivos: se apila encima.
    let calls = fakePushGithub({ head, compare: () => ({ status: 'ahead', files: [{ filename: 'src/other.gs' }] }) });
    const ok = await pushFiles('tok', { ...base, expectedParentSha: expected });
    assert.equal(ok.parentSha, head);
    assert.ok(calls.some((c) => c.includes(`/compare/${expected}...${head}`)));

    // Commits nuevos en src/a.gs (o renombrados desde ahí): se rechaza sin subir blobs.
    for (const files of [[{ filename: 'src/a.gs' }], [{ filename: 'src/z.gs', previous_filename: 'src/a.gs' }]]) {
      calls = fakePushGithub({ head, compare: () => ({ status: 'ahead', files }) });
      await assert.rejects(pushFiles('tok', { ...base, expectedParentSha: expected }), /GH_BRANCH_CHANGED/);
      assert.ok(!calls.some((c) => c.startsWith('POST') && c.endsWith('/git/blobs')));
    }

    // Historia reescrita (diverged) o sin commit comparado: se rechaza.
    fakePushGithub({ head, compare: () => ({ status: 'diverged', files: [] }) });
    await assert.rejects(pushFiles('tok', { ...base, expectedParentSha: expected }), /GH_BRANCH_CHANGED/);
    fakePushGithub({ head, compare: () => ({ status: 'ahead', files: [] }) });
    await assert.rejects(pushFiles('tok', { ...base, expectedParentSha: null }), /GH_BRANCH_CHANGED/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('S5: la caché de blobs llega como objeto y se reutiliza (solo SHAs válidos)', async () => {
  const realFetch = globalThis.fetch;
  try {
    const calls = fakePushGithub({ head: '1'.repeat(40), compare: () => ({}) });
    const res = await pushFiles('tok', {
      repo: 'a/b', branch: 'main', message: 'm',
      files: [{ path: 'a.gs', content: 'x' }, { path: 'b.gs', content: 'y' }],
      existingBlobs: { 'a.gs': '9'.repeat(40), 'b.gs': 'not-a-sha' },
    });
    assert.equal(res.uploadedBlobs['a.gs'], '9'.repeat(40));
    assert.equal(calls.filter((c) => c === 'POST /repos/a/b/git/blobs').length, 1, 'solo b.gs se sube');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** Panel listo para un pull: GAS con a/b/c y el diff indicado; `pick` = casillas marcadas. */
function pullPanel(items, pick) {
  const state = { written: null, confirmOpts: null };
  const made = makePanel({
    _showPullConfirm_: async function (opts) {
      state.confirmOpts = opts;
      const selected = typeof pick === 'function'
        ? pick(opts, this)
        : new Set(opts.files.filter((f) => this._pullRowDefault_(f).checked).map((f) => f.path));
      return { confirmed: true, reload: false, selected };
    },
    _fetchProjectFromApi_: async () => [
      { path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'mine' },
      { path: 'b.gs', name: 'b', type: 'SERVER_JS', source: 'b1' },
      { path: 'c.gs', name: 'c', type: 'SERVER_JS', source: 'c-local' },
    ],
    _pushProjectToApi_: async (files) => { state.written = files; return true; },
  });
  made.panel._recomputeDiff_ = async () => {};
  made.panel._remoteCommitSha = SHA_R;
  made.panel._diffItems = items;
  return { ...made, state, written: () => Object.fromEntries((state.written || []).map((f) => [f.name, f.source])) };
}

const itemA = () => ({ path: 'a.gs', status: 'mod', origin: 'local', local: 'mine', remote: 'a1', plus: 1, minus: 1 });
const itemB = () => {
  const it = { path: 'b.gs', status: 'mod', origin: 'remote', local: 'b1', remote: 'b2', plus: 1, minus: 1 };
  Object.defineProperty(it, 'remoteRaw', { value: 'b2\n' });
  return it;
};
const itemC = () => ({ path: 'c.gs', status: 'mod', origin: 'conflict', local: 'c-local', remote: 'c-remote', base: 'c0', plus: 1, minus: 1 });

test('pull: por defecto trae lo de GitHub; GAS desmarcado y conflicto sin resolver no se tocan, la base no avanza', async () => {
  const p = pullPanel([itemA(), itemB(), itemC(), { path: '../evil.gs', status: 'del', origin: 'remote', local: '', remote: 'x', plus: 0, minus: 1 }]);
  const { panel } = p;
  assert.deepEqual(plain(['a.gs', 'b.gs', 'c.gs', '../evil.gs'].map((path) => panel._pullRowDefault_(panel._diffItems.find((i) => i.path === path)))), [
    { checked: false, disabled: false },
    { checked: true, disabled: false },
    { checked: false, disabled: true },
    { checked: false, disabled: true },
  ]);
  await panel._pull_();
  const w = p.written();
  assert.equal(w.a, 'mine', 'a.gs (cambio en GAS) intacto');
  assert.equal(w.b, 'b2\n', 'b.gs llega con su salto final');
  assert.equal(w.c, 'c-local', 'el conflicto sin resolver no se pisa');
  assert.ok(!p.state.written.some((f) => f.name.includes('evil')));
  assert.equal(panel._project.baseSha, undefined, 'queda un conflicto sin resolver: la base no avanza');
});

test('pull: un archivo de GAS marcado a mano se aplica (con aviso en la fila)', async () => {
  const p = pullPanel([itemA(), itemB()], (opts) => new Set(opts.files.map((f) => f.path)));
  const { panel } = p;
  assert.match(panel._pullRowHtml_(panel._diffItems[0], true), /Will overwrite your changes in GAS/);
  assert.doesNotMatch(panel._pullRowHtml_(panel._diffItems[0], false), /Will overwrite/);
  await panel._pull_();
  assert.equal(p.written().a, 'a1', 'se trajo la versión de GitHub de a.gs');
  assert.equal(panel._project.baseSha, SHA_R);
});

test('pull: solo lo seleccionado; dejar un cambio de GAS sin marcar no impide mover la base', async () => {
  const p = pullPanel([itemA(), itemB()]);
  await p.panel._pull_();
  assert.equal(p.written().a, 'mine');
  assert.equal(p.panel._project.baseSha, SHA_R);

  const q = pullPanel([itemA(), itemB()], () => new Set());
  await q.panel._pull_();
  assert.equal(q.state.written, null, 'nada marcado = nada escrito');
});

test('pull: resoluciones del visor (take-remote, merged, keep-local)', async () => {
  for (const [res, expected, baseMoves] of [
    [{ action: 'take-remote' }, 'c-remote', true],
    [{ action: 'merged', content: 'c-merged\n' }, 'c-merged\n', true],
    [{ action: 'keep-local' }, 'c-local', true],
  ]) {
    const p = pullPanel([itemB(), itemC()]);
    p.panel._setResolution_('c.gs', res);
    assert.equal(p.panel._pullRowDefault_(p.panel._diffItems[1]).checked, res.action !== 'keep-local');
    await p.panel._pull_();
    assert.equal(p.written().c, expected, res.action);
    assert.equal(p.panel._project.baseSha === SHA_R, baseMoves, `base con ${res.action}`);
  }
});

test('resoluciones: se invalidan si cambia el contenido o la rama; keep-local desbloquea el push', async () => {
  const { panel } = makePanel({ isBusy: () => false, _recomputeDiff_: async () => {}, _updateAnchorBadge_: () => {} });
  panel._diffItems = [itemC()];
  panel._selectedFiles = new Set(['c.gs']);
  assert.equal(panel._pullRequired_(), true);
  panel._setResolution_('c.gs', { action: 'keep-local' });
  assert.equal(panel._pullRequired_(), false, 'Quedarme con GAS permite subirlo');
  assert.equal(panel._setResolution_('c.gs', { action: 'nope' }), false, 'acción desconocida se rechaza');
  assert.equal(panel._resolutions.get('c.gs').action, 'keep-local');
  assert.equal(panel._setResolution_('c.gs', { action: 'take-remote', remote: 'otra cosa' }), false, 'instantánea distinta: se rechaza');

  panel._setResolution_('c.gs', { action: 'take-remote' });
  panel._diffItems = [{ ...itemC(), remote: 'c-remote-2' }];
  assert.equal(panel._resolutionFor_(panel._diffItems[0]), null, 'GitHub cambió: la decisión ya no vale');
  panel._pruneResolutions_();
  assert.equal(panel._resolutions.size, 0);

  panel._diffItems = [itemC()];
  panel._setResolution_('c.gs', { action: 'take-remote' });
  await panel._onBranchChange_('dev');
  assert.equal(panel._resolutions.size, 0, 'cambiar de rama borra las decisiones');
});

test('tarjeta de conflicto: botón Resolver que abre el visor y guarda la decisión', () => {
  const { panel } = makePanel();
  panel._diffItems = [itemC(), itemB()];
  let opened = null;
  ENV.ctx.gasDiffViewer = { open: (o) => { opened = o; return true; } };
  try {
    assert.match(panel._renderDiffCard_(panel._diffItems[0]), /qc__gh-diffResolveBtn[^>]*>Resolve</);
    assert.doesNotMatch(panel._renderDiffCard_(panel._diffItems[1]), /qc__gh-diffResolveBtn/);
    assert.equal(panel._openDiffViewer_('c.gs'), true);
    assert.equal(opened.activePath, 'c.gs');
    opened.onResolve('c.gs', { action: 'merged', content: 'x' });
    assert.equal(panel._resolutionFor_(panel._diffItems[0]).content, 'x');
    assert.match(panel._renderDiffCard_(panel._diffItems[0]), />Edited result</);
    assert.match(panel._pullRowHtml_(panel._diffItems[0], true), /data-resolve="c\.gs"[^>]*>Change</);
  } finally {
    delete ENV.ctx.gasDiffViewer;
  }
});

test('S8: rutas remotas no seguras', () => {
  const { panel } = makePanel();
  for (const bad of ['../a.gs', 'a/../b.gs', '/abs.gs', 'a\\b.gs', 'a\u0000.gs', 'a\u202e.gs', 'x\u2066.gs', '..']) {
    assert.equal(panel._isUnsafeRemotePath_(bad), true, JSON.stringify(bad));
  }
  for (const ok of ['a.gs', 'src/a.b.gs', 'a..b.gs', 'ñ/código.gs']) assert.equal(panel._isUnsafeRemotePath_(ok), false, ok);
});

test('Q6: si la base ya no existe se borra de la config guardada', async () => {
  const { panel, calls } = makePanel({ _fetchProjectFromApi_: async () => [] });
  panel._project.baseSha = SHA_P;
  panel._ghApi_ = async (action) => (action === 'FETCH_TREE'
    ? { ok: true, data: { commitSha: SHA_R, files: [], baseFiles: null, baseSha: null, baseMissing: true } }
    : { ok: false });
  await panel._recomputeDiff_();
  assert.equal(panel._project.baseSha, undefined);
  const save = calls.bridge.find((c) => c.evt === 'GAS_GH_SAVE_PROJECT');
  assert.ok(save && !('baseSha' in save.payload.config));
});

test('Q9: sin base previa, el push la fija aunque queden archivos de origen desconocido', async () => {
  const { panel } = pushPanel([{ path: 'x.gs', status: 'mod', origin: 'unknown' }]);
  await panel._push_();
  assert.equal(panel._project.baseSha, SHA_C);
});

test('U2: lo que viene de GitHub se pinta desde el lado del pull', () => {
  const { panel } = makePanel();
  const newOnGithub = { path: 'n.html', status: 'del', origin: 'remote', plus: 0, minus: 3 };
  assert.match(panel._statusMarkHtml_(newOnGithub), /qc__gh-changeStatus add" aria-hidden="true">\+</);
  assert.match(panel._deltaHtml_(newOnGithub), /class="add">\+3<\/span> <span class="del">−0</);
  assert.match(panel._deltaHtml_(newOnGithub), /Pull brings 3 added and 0 removed lines/);
  const local = { path: 'a.gs', status: 'add', origin: 'local', plus: 2, minus: 0 };
  assert.match(panel._statusMarkHtml_(local), /changeStatus add/);
  assert.match(panel._deltaHtml_(local), /\+2<\/span> <span class="del">−0/);
  assert.match(panel._renderChangeRow_(newOnGithub), /changeStatus add/);
});

test('U3/U6/U8: tabla accesible, badge con aria-label y ruta partida', () => {
  const { panel } = makePanel();
  const html = panel._diffBodyHtml_({ path: 'src/a.gs', status: 'mod', remote: 'a\nb', local: 'a\nc' });
  assert.match(html, /aria-label="Differences in src\/a\.gs"/);
  assert.match(html, /<th colspan="3" scope="rowgroup">@@ -1,2 \+1,2 @@<\/th>/);
  assert.match(html, /<span class="gt-sr-only">Only in GitHub: <\/span>b/);
  assert.match(html, /<span class="gt-sr-only">Only in GAS: <\/span>c/);
  assert.match(html, /class="qc__gh-diffScroll" tabindex="0"/);
  const card = panel._renderDiffCard_({ path: 'src/deep/a.gs', status: 'mod', origin: 'local', plus: 1, minus: 1 }, 4);
  assert.match(card, /aria-controls="ghDiffBody4"/);
  assert.match(card, /id="ghDiffBody4"/);
  assert.match(card, /<span class="qc__gh-changePathDir">src\/deep\/<\/span><span class="qc__gh-changePathFile">a\.gs<\/span>/);
  assert.match(card, /role="img" aria-label="Changed in GAS\. /);
  assert.match(card, /<span class="gt-sr-only">1 added, 1 removed<\/span>/);
});

test('Q5: el contexto largo se despliega por tramos de 200 líneas', () => {
  const { panel } = makePanel();
  const item = { path: 'a.gs', status: 'mod', remote: lines(3000), local: lines(3000, (i) => (i === 2990 ? 'changed' : `line ${i}`)) };
  assert.match(panel._diffBodyHtml_(item), /Show 200 of 2986 hidden lines/);
  panel._expandFold_('a.gs', 0);
  const html = panel._diffBodyHtml_(item);
  assert.match(html, /Show 200 of 2786 hidden lines/);
  const rows = rowsOf(html);
  assert.deepEqual(rows[0], ['Eq', '2787', '2787'], 'se despliega hacia arriba desde el bloque');
  assert.equal(rows.filter((r) => r[0] === 'Eq').length, 200 + 3 + 3);
});

// ── Fase B: fallos reproducidos por QA (corregidos) ─────────────────────────

/** Panel para los casos todo de la fase B. */
function phaseBPullPanel({ items, selected, gasFiles }) {
  const writes = [];
  const made = makePanel({
    _showPullConfirm_: async () => ({ confirmed: true, reload: false, selected: new Set(selected) }),
    _fetchProjectFromApi_: async () => gasFiles,
    _pushProjectToApi_: async (files) => { writes.push(files); return true; },
  });
  made.panel._recomputeDiff_ = async () => {};
  made.panel._remoteCommitSha = SHA_R;
  made.panel._diffItems = items;
  return { ...made, writes };
}

test('BUG: el pull mueve la base aunque quede un borrado de GitHub sin aplicar (archivo solo en GAS con origen remoto)', async () => {
  const { panel } = phaseBPullPanel({
    items: [
      { path: 'a.gs', status: 'mod', origin: 'remote', local: 'a1', remote: 'a2', plus: 1, minus: 1 },
      { path: 'h.gs', status: 'add', origin: 'remote', local: 'h1', remote: '', plus: 1, minus: 0 }, // borrado en GitHub
    ],
    selected: ['a.gs'],
    gasFiles: [
      { path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'a1' },
      { path: 'h.gs', name: 'h', type: 'SERVER_JS', source: 'h1' },
    ],
  });
  await panel._pull_();
  assert.equal(panel._project.baseSha, undefined, 'con la base nueva h.gs pasa a "Nuevo en GAS" y un push lo resucita');
});

test('BUG: "Quedarme con GAS" en un archivo de origen GitHub no se respeta en el pull ni desbloquea el push', () => {
  const { panel } = makePanel();
  const it = { path: 'b.gs', status: 'mod', origin: 'remote', local: 'b1', remote: 'b2', plus: 1, minus: 1 };
  panel._diffItems = [it];
  panel._setResolution_('b.gs', { action: 'keep-local' });   // el visor ofrece este botón para todo archivo
  assert.equal(panel._pullRowDefault_(it).checked, false, 'la confirmación lo marca y el pull lo sobrescribe');
  assert.equal(panel._pullPlan_([it], new Set(['b.gs'])).apply.length, 0);
  panel._selectedFiles = new Set(['b.gs']);
  assert.equal(panel._pullRequired_(), false, 'el push sigue bloqueado pese a la decisión');
});

test('BUG: una decisión tomada en el visor se liga al diff vigente, no al contenido que el usuario vio', () => {
  const { panel } = makePanel();
  const seen = { path: 'c.gs', status: 'mod', origin: 'conflict', local: 'L', remote: 'R1', base: 'B' };
  panel._diffItems = [seen];
  let opts = null;
  ENV.ctx.gasDiffViewer = { open: (o) => { opts = o; return true; } };
  try {
    panel._openDiffViewer_('c.gs');
    // Recálculo mientras el visor está abierto: GitHub tiene ahora R2.
    const now = { ...seen, remote: 'R2' };
    panel._diffItems = [now];
    opts.onResolve('c.gs', { action: 'take-remote' });        // el usuario eligió viendo R1
    assert.equal(panel._resolutionFor_(now), null, 'el pull aplicaría R2, que el usuario no revisó');
  } finally {
    delete ENV.ctx.gasDiffViewer;
  }
});

test('BUG: el pull sobrescribe ediciones hechas en GAS después de calcular el diff', async () => {
  const { panel, writes } = phaseBPullPanel({
    items: [{ path: 'a.gs', status: 'mod', origin: 'remote', local: 'a1', remote: 'a2', plus: 1, minus: 1 }],
    selected: ['a.gs'],
    gasFiles: [{ path: 'a.gs', name: 'a', type: 'SERVER_JS', source: 'a1 + edición posterior' }],
  });
  await panel._pull_();
  const written = writes[0]?.find((f) => f.name === 'a')?.source;
  assert.notEqual(written, 'a2', 'la edición posterior al diff se pierde sin aviso (ahora sería un conflicto)');
});

test('BUG: origen desconocido (sin base) va marcado por defecto y sin aviso de que pisa GAS', () => {
  const { panel } = makePanel();
  const it = { path: 'u.gs', status: 'mod', origin: 'unknown', local: 'mine', remote: 'theirs', plus: 1, minus: 1 };
  const html = panel._pullRowHtml_(it, panel._pullRowDefault_(it).checked);
  assert.match(html, /qc__gh-pullReason warn/, 'sin base no se sabe qué lado cambió: debería avisar o ir desmarcado');
});

test('B4/B9: decisiones con efecto en cualquier origen y solo donde aplican', () => {
  const { panel } = makePanel();
  const local = { path: 'l.gs', status: 'mod', origin: 'local', local: 'L', remote: 'R', plus: 1, minus: 1 };
  const onlyGithub = { path: 'g.gs', status: 'del', origin: 'conflict', local: '', remote: 'R', plus: 0, minus: 1 };
  const onlyGas = { path: 'h.gs', status: 'add', origin: 'remote', local: 'H', remote: '', plus: 1, minus: 0 };
  panel._diffItems = [local, onlyGithub, onlyGas];
  assert.equal(panel._setResolution_('l.gs', { action: 'take-remote' }), true);
  assert.deepEqual(plain(panel._pullRowDefault_(local)), { checked: true, disabled: false }, 'traer en un archivo de GAS: marcado');
  assert.match(panel._pullRowHtml_(local, true), /Will overwrite your changes in GAS/);
  assert.equal(panel._pullPlan_([local], new Set(['l.gs'])).apply.length, 1);
  assert.equal(panel._setResolution_('g.gs', { action: 'keep-local' }), false, 'el push no borra en GitHub: no se ofrece');
  assert.equal(panel._setResolution_('h.gs', { action: 'take-remote' }), false, 'el pull no borra en GAS: no se ofrece');
  assert.equal(panel._setResolution_('h.gs', { action: 'keep-local' }), true);
  assert.equal(panel._pullLeavesBaseSafe_([onlyGas]), true, 'quedarse con un archivo borrado en GitHub es una decisión');
});

test('B10: rutas con caracteres invisibles o "." como segmento', () => {
  const { panel } = makePanel();
  for (const bad of ['./a.gs', 'a/./b.gs', 'a\u200b.gs', 'a\ufeff.gs', 'a\u061c.gs', 'a\u2060b.gs']) {
    assert.equal(panel._isUnsafeRemotePath_(bad), true, JSON.stringify(bad));
  }
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u061c]/.test(fs.readFileSync(new URL('../extension/js/components/gas-github-panel-diff.js', import.meta.url), 'utf8')),
    'sin caracteres invisibles literales en el fuente (solo escapes)');
});

test('B1: el visor se cierra si el diff se invalida o se recalcula', async () => {
  const { panel } = makePanel({ _fetchProjectFromApi_: async () => [] });
  panel._diffItems = [{ path: 'c.gs', status: 'mod', origin: 'conflict', local: 'L', remote: 'R' }];
  let open = false;
  let closes = 0;
  ENV.ctx.gasDiffViewer = { open: () => { open = true; return true; }, isOpen: () => open, close: () => { open = false; closes++; } };
  try {
    panel._openDiffViewer_('c.gs');
    panel._invalidateDiff_();
    assert.equal(closes, 1);
    panel._diffItems = [{ path: 'c.gs', status: 'mod', origin: 'conflict', local: 'L', remote: 'R' }];
    panel._openDiffViewer_('c.gs');
    await panel._recomputeDiff_();
    assert.equal(closes, 2);
  } finally {
    delete ENV.ctx.gasDiffViewer;
  }
});
