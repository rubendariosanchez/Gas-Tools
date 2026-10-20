// Tests del respaldo de DomUtils.setHTML sin Trusted Types: DOMParser + saneo
// (sin script/iframe/object ni atributos on* o URLs javascript:).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../extension/js/services/dom-utils.js', import.meta.url), 'utf8');

/** Elemento mínimo para el saneo. */
function el(tag, attrs = {}) {
  return {
    tagName: tag.toUpperCase(),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    removed: false,
    remove() { this.removed = true; },
    removeAttribute(name) { this.attributes = this.attributes.filter((a) => a.name !== name); },
  };
}

/** Árbol plano con `querySelectorAll` suficiente para los selectores de `sanitizeTree_`. */
function tree(nodes) {
  return {
    childNodes: nodes,
    querySelectorAll(sel) {
      const live = nodes.filter((n) => !n.removed);
      if (sel === '*') return live;
      const tags = sel.split(',').map((t) => t.trim()).filter((t) => /^[a-z]+$/.test(t));
      return live.filter((n) => tags.includes(n.tagName.toLowerCase()));
    },
  };
}

test('setHTML sin política usa DOMParser y quita lo ejecutable', () => {
  const nodes = [
    el('div', { class: 'ok', onclick: 'alert(1)' }),
    el('script'),
    el('iframe', { src: 'https://evil.example' }),
    el('object'),
    el('a', { href: ' JaVaScript:alert(1)', title: 'x' }),
    el('img', { src: 'data:text/html,<b>', onerror: 'x' }),
    el('a', { href: 'https://github.com/' }),
  ];
  const body = tree(nodes);
  let parsed = null;
  const ctx = {
    window: {},
    console,
    document: {},
    DOMParser: class { parseFromString(html, type) { parsed = { html, type }; return { body }; } },
  };
  vm.runInNewContext(`${SRC}\n;globalThis.DomUtils = DomUtils;`, ctx);
  let replaced = null;
  ctx.DomUtils.setHTML({ replaceChildren: (...kids) => { replaced = kids; } }, '<div>hola</div>');

  assert.deepEqual(parsed, { html: '<body><div>hola</div></body>', type: 'text/html' });
  const kept = replaced.filter((n) => !n.removed).map((n) => n.tagName);
  assert.deepEqual(kept, ['DIV', 'A', 'IMG', 'A']);
  assert.deepEqual(nodes[0].attributes.map((a) => a.name), ['class']);
  assert.deepEqual(nodes[4].attributes.map((a) => a.name), ['title']);
  assert.deepEqual(nodes[5].attributes, []);
  assert.deepEqual(nodes[6].attributes.map((a) => a.value), ['https://github.com/']);
});
