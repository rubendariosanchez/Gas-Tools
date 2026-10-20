// Tests del renderer Markdown (scripts clásicos cargados en contextos vm aislados).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE_URL = new URL('../extension/js/services/markdown-render.js', import.meta.url);
const VENDOR_URL = new URL('../src/vendor/markdown-it/markdown-it.min.js', import.meta.url);
const source = readFileSync(SOURCE_URL, 'utf8');
const vendor = readFileSync(VENDOR_URL, 'utf8');

/**
 * Carga markdown-render.js en un contexto nuevo; con `withMarkdownIt` carga
 * antes el UMD vendorizado en el MISMO contexto (como en sidepanel.html).
 * Los `const` globales no se exponen como propiedades del contexto: se publican a mano.
 */
const load_ = (withMarkdownIt) => {
  const context = vm.createContext({ console });
  if (withMarkdownIt) vm.runInContext(vendor, context, { filename: 'markdown-it.min.js' });
  vm.runInContext(`${source}\n;globalThis.GasMarkdown = GasMarkdown;`, context, {
    filename: 'markdown-render.js',
  });
  return context;
};

const mainContext = load_(true);
const { GasMarkdown } = mainContext;
const legacyContext = load_(false);

/** Quita los saltos de línea entre etiquetas para comparar estructura. */
const flat_ = (html) => html.replace(/\s*\n\s*(?=<)|(?<=>)\s*\n\s*/g, '').trim();

test('markdown-it vendorizado se carga en el contexto', () => {
  assert.equal(typeof mainContext.markdownit, 'function');
  assert.equal(typeof legacyContext.markdownit, 'undefined');
});

test('expone solo render y highlight', () => {
  assert.equal(typeof GasMarkdown.render, 'function');
  assert.equal(typeof GasMarkdown.highlight, 'function');
  assert.ok(Object.isFrozen(GasMarkdown));
});

test('XSS: <script> se escapa', () => {
  const html = GasMarkdown.render('hola <script>alert(1)</script>');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('XSS: <img onerror> se escapa', () => {
  const html = GasMarkdown.render('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
});

test('XSS: enlaces javascript: no generan <a>', () => {
  const html = GasMarkdown.render('[click](javascript:alert(1))');
  assert.ok(!html.includes('<a'));
  assert.ok(!/href=["']?javascript:/i.test(html));
});

test('XSS: comillas en URL no rompen el atributo href', () => {
  const html = GasMarkdown.render('[x](https://a.com/"onmouseover="alert(1))');
  // Las comillas quedan como &quot; dentro del href: el tag solo tiene href/target/rel.
  const tags = html.match(/<a\s[^>]*>/g) || [];
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.match(tag, /^<a href="[^"]*" target="_blank" rel="noopener noreferrer">$/);
  }
});

test('XSS: placeholders \\u0000 del input no se pueden falsificar', () => {
  const html = GasMarkdown.render('\u0000CODE0\u0000 \u0000LNK0\u0000');
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('\u0000'));
});

test('XSS: código dentro de fences y highlight se escapa', () => {
  const html = GasMarkdown.render('```html\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!html.includes('<img'));
  const hl = GasMarkdown.highlight('<a b onclick=x "q">', 'html');
  assert.ok(!hl.includes('<a '));
  assert.ok(!hl.includes('"q"'));
});

test('enlaces con guiones bajos quedan intactos', () => {
  const url = 'https://developers.google.com/apps-script/reference/spreadsheet/sheet_range_list';
  const md = GasMarkdown.render(`Ver [docs_page_here](${url}) y ${url}`);
  assert.ok(md.includes(`<a href="${url}" target="_blank" rel="noopener noreferrer">docs_page_here</a>`));
  assert.ok(md.includes(`>${url}</a>`));
  assert.ok(!md.includes('<em>'));
});

test('snake_case no se convierte en cursiva', () => {
  const html = GasMarkdown.render('usa my_var_name aquí');
  assert.ok(!html.includes('<em>'));
});

test('negrita y cursiva', () => {
  const html = GasMarkdown.render('**fuerte** y *suave* y __b__ y _i_');
  assert.ok(html.includes('<strong>fuerte</strong>'));
  assert.ok(html.includes('<em>suave</em>'));
  assert.ok(html.includes('<strong>b</strong>'));
  assert.ok(html.includes('<em>i</em>'));
});

test('inline code no procesa markdown ni HTML', () => {
  const html = GasMarkdown.render('usa `a **b** <c>` ya');
  assert.ok(html.includes('<code class="gc__inlineCode">a **b** &lt;c&gt;</code>'));
});

test('bloque de código con lenguaje', () => {
  const html = GasMarkdown.render('```javascript\nconst x = "hi"; // c\n```');
  assert.ok(html.includes('<span class="gc__codeLang">javascript</span>'));
  assert.ok(html.includes('<span class="hl-keyword">const</span>'));
  assert.ok(html.includes('<span class="hl-string">&quot;hi&quot;</span>'));
  assert.ok(html.includes('<span class="hl-comment">// c</span>'));
  assert.ok(!html.includes('<p><div'));
});

test('bloque de código sin cerrar (streaming) se renderiza como código', () => {
  const html = GasMarkdown.render('Texto\n\n```js\nfunction f() {');
  assert.ok(html.includes('gc__codeWrap'));
  assert.ok(html.includes('<span class="hl-keyword">function</span>'));
});

test('listas ordenadas y no ordenadas', () => {
  const ul = flat_(GasMarkdown.render('- uno\n- dos\n- tres'));
  assert.ok(ul.includes('<ul><li>uno</li><li>dos</li><li>tres</li></ul>'));
  const ol = flat_(GasMarkdown.render('1. a\n2. b'));
  assert.ok(ol.includes('<ol><li>a</li><li>b</li></ol>'));
});

test('encabezados', () => {
  const html = GasMarkdown.render('# Uno\n## Dos\n###### Seis');
  assert.ok(html.includes('<h1>Uno</h1>'));
  assert.ok(html.includes('<h2>Dos</h2>'));
  assert.ok(html.includes('<h6>Seis</h6>'));
});

test('highlight de lenguaje desconocido solo escapa', () => {
  assert.equal(GasMarkdown.highlight('<b>&', 'python'), '&lt;b&gt;&amp;');
});

// ── Casos de markdown-it ─────────────────────────────────────────────

test('lista ordenada con líneas en blanco entre ítems mantiene la numeración', () => {
  const html = flat_(GasMarkdown.render('1. uno\n\n2. dos\n\n3. tres'));
  assert.equal((html.match(/<ol/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.ok(html.includes('<li><p>dos</p></li>'));
});

test('lista ordenada interrumpida por viñetas/párrafos respeta el número de inicio', () => {
  const html = flat_(GasMarkdown.render('1. **Título**:\n\n- a\n- b\n\n2. **Otro**\n\nTexto\n\n3. Fin'));
  assert.ok(html.includes('<ol><li><strong>Título</strong>:</li></ol>'));
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('<ol start="2"><li><strong>Otro</strong></li></ol>'));
  assert.ok(html.includes('<ol start="3"><li>Fin</li></ol>'));
});

test('guiones dentro de un párrafo no crean listas', () => {
  const html = flat_(GasMarkdown.render('Opciones: - item uno. - item dos.'));
  assert.equal(html, '<p>Opciones: - item uno. - item dos.</p>');
});

test('listas anidadas', () => {
  const html = flat_(GasMarkdown.render('- uno\n  - dos\n    - tres\n- cuatro'));
  assert.ok(html.includes('<ul><li>uno<ul><li>dos<ul><li>tres</li></ul></li></ul></li><li>cuatro</li></ul>'));
});

test('code span dentro de listas', () => {
  const html = flat_(GasMarkdown.render('- usa `getRange()` aquí'));
  assert.ok(html.includes('<li>usa <code class="gc__inlineCode">getRange()</code> aquí</li>'));
});

test('task lists → checkboxes deshabilitados', () => {
  const html = flat_(GasMarkdown.render('- [ ] pendiente\n- [x] hecho\n- normal'));
  assert.ok(html.includes('<li class="gc__taskItem"><input type="checkbox" class="gc__taskBox" disabled> pendiente</li>'));
  assert.ok(html.includes('<li class="gc__taskItem"><input type="checkbox" class="gc__taskBox" disabled checked> hecho</li>'));
  assert.ok(html.includes('<li>normal</li>'));
});

test('tablas con alineación dentro de un contenedor con scroll', () => {
  const html = flat_(GasMarkdown.render('| a | b |\n|:-|-:|\n| 1 | **2** |'));
  assert.ok(html.startsWith('<div class="gc__tableWrap"><table class="gc__table">'));
  assert.ok(html.includes('<th style="text-align:left">a</th>'));
  assert.ok(html.includes('<td style="text-align:right"><strong>2</strong></td>'));
  assert.ok(html.endsWith('</table></div>'));
});

test('blockquote, hr y tachado', () => {
  const html = flat_(GasMarkdown.render('> cita **fuerte**\n\n---\n\n~~viejo~~'));
  assert.ok(html.includes('<blockquote><p>cita <strong>fuerte</strong></p></blockquote>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<del>viejo</del>'));
});

test('saltos de línea simples → <br>', () => {
  assert.ok(GasMarkdown.render('línea 1\nlínea 2').includes('línea 1<br>'));
});

test('linkify de URLs sueltas (sin enlaces fuzzy de nombres de archivo)', () => {
  const html = GasMarkdown.render('Mira https://script.google.com/home y Code.gs o utils.js');
  assert.ok(html.includes('<a href="https://script.google.com/home" target="_blank" rel="noopener noreferrer">https://script.google.com/home</a>'));
  assert.ok(!html.includes('http://Code.gs'));
  assert.ok(!html.includes('http://utils.js'));
});

test('XSS: enlaces data:, vbscript: y javascript: (mayúsculas/espacios/autolink) se neutralizan', () => {
  for (const md of [
    '[a](data:text/html;base64,PHNjcmlwdD4=)',
    '[b](JaVaScRiPt:alert(1))',
    '[c](vbscript:msgbox(1))',
    '<javascript:alert(1)>',
    '[d]( javascript:alert(1) )',
  ]) {
    assert.ok(!GasMarkdown.render(md).includes('<a'), md);
  }
});

test('mailto permitido', () => {
  const html = GasMarkdown.render('[escribe](mailto:dev@example.com)');
  assert.ok(html.includes('<a href="mailto:dev@example.com" target="_blank" rel="noopener noreferrer">escribe</a>'));
});

test('imágenes no generan <img> (se muestran como enlace)', () => {
  const html = GasMarkdown.render('![logo](https://example.com/x.png)\n\n![mal](javascript:alert(1))');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<a href="https://example.com/x.png" target="_blank" rel="noopener noreferrer">logo</a>'));
  assert.ok(!/href="javascript:/i.test(html));
});

test('XSS: HTML crudo en bloque e inline se escapa', () => {
  const html = GasMarkdown.render('<div onclick="x">\n<script>alert(1)</script>\n</div>\n\ntexto <b onmouseover=x>b</b>');
  assert.ok(!/<(div|script|b)[\s>]/.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('fence: markup de la barra de acciones (contrato con gas-chat-panel)', () => {
  const html = GasMarkdown.render('```gs extra\nconst a = 1;\n\n\n```');
  assert.ok(html.includes('<div class="gc__codeWrap">'));
  assert.ok(html.includes('<span class="gc__codeLang">gs</span>'));
  for (const action of ['copy', 'insert', 'replace', 'apply']) {
    assert.ok(html.includes(`class="gc__codeBtn" data-action="${action}"`), action);
  }
  assert.ok(html.includes('<span class="gc__codeBtnLabel">Copy</span>'));
  assert.ok(html.includes('<pre class="gc__codeBlock"><code>const a = 1;</code></pre>'));
});

test('fence: misma salida que el renderer legacy', () => {
  const md = '```javascript\nfunction f() { return "x"; }\n```';
  assert.equal(GasMarkdown.render(md).trim(), legacyContext.GasMarkdown.render(md).trim());
});

test('fence dentro de un ítem de lista', () => {
  const html = flat_(GasMarkdown.render('1. Paso:\n\n   ```js\n   var x;\n   ```'));
  assert.ok(/<li><p>Paso:<\/p><div class="gc__codeWrap">/.test(html));
});

test('código indentado usa el bloque con barra de acciones', () => {
  const html = GasMarkdown.render('texto\n\n    var x = 1;');
  assert.ok(html.includes('<span class="gc__codeLang">code</span>'));
  assert.ok(html.includes('<code>var x = 1;</code>'));
});

test('streaming: fence sin cerrar al final y aperturas parciales', () => {
  const html = GasMarkdown.render('Intro\n\n- a\n\n```javascript\nconst x = 1;\nfunction');
  assert.ok(html.includes('gc__codeWrap'));
  assert.ok(html.includes('<span class="hl-keyword">function</span>'));
  assert.doesNotThrow(() => GasMarkdown.render('Intro\n\n``'));
  assert.doesNotThrow(() => GasMarkdown.render('| a | b |\n|-'));
});

test('rendimiento: ~20 KB en menos de 50 ms', () => {
  let md = '';
  while (md.length < 20000) md += '## T\n\n1. ítem **b** `c`\n\n- x\n- y\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|-|-|\n| 1 | 2 |\n\n';
  GasMarkdown.render(md);
  const t0 = performance.now();
  GasMarkdown.render(md);
  assert.ok(performance.now() - t0 < 50);
});

// ── Fallback legacy (sin global markdownit) ─────────────────────────

test('fallback: sin markdownit usa el renderer legacy', () => {
  const legacy = legacyContext.GasMarkdown;
  assert.ok(Object.isFrozen(legacy));
  assert.ok(legacy.render('- uno\n- dos\n* tres').includes('<ul><li>uno</li><li>dos</li><li>tres</li></ul>'));
  assert.ok(legacy.render('1. a\n2. b').includes('<ol><li>a</li><li>b</li></ol>'));
  const xss = legacy.render('hola <script>alert(1)</script> [x](javascript:alert(1))');
  assert.ok(!xss.includes('<script'));
  assert.ok(!xss.includes('<a'));
  assert.ok(legacy.render('```js\nfunction f() {').includes('gc__codeWrap'));
});
