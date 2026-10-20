// Payload `GAS_TransferData` (content script → MAIN world): no debe filtrar
// URLs con el ID estático de la extensión (huella digital para la página).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../extension/js/main-functions.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const STATIC_ID = 'static-extension-id';
const DYNAMIC_ID = 'dynamic-session-id';
const WAR = new Set(manifest.web_accessible_resources.flatMap((w) => w.resources));

/** getURL como Chrome con `use_dynamic_url`: id dinámico solo para recursos WAR. */
const getURL = (p) => `chrome-extension://${WAR.has(p) ? DYNAMIC_ID : STATIC_ID}/${p}`;

test('el payload de GAS_TransferData no lleva URLs con el ID estático', () => {
  const call = src.match(/watchForEditors\(\{[\s\S]*?\}\);/)?.[0];
  assert.ok(call, 'init() llama a watchForEditors con el payload');
  assert.doesNotMatch(call, /themeUrl/);
  assert.doesNotMatch(call, /chrome\.runtime\.getURL/);

  // Única URL del payload: assetsBaseUrl_(), derivada de un recurso WAR.
  const fnSrc = src.match(/function assetsBaseUrl_\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fnSrc);
  const ctx = { chrome: { runtime: { getURL } } };
  vm.runInNewContext(`${fnSrc}\nglobalThis.out = assetsBaseUrl_();`, ctx);
  assert.equal(ctx.out, `chrome-extension://${DYNAMIC_ID}/`);
  assert.equal(ctx.out.includes(STATIC_ID), false);
});
