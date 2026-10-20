/**
 * Genera las imágenes de la ficha de Chrome Web Store con la interfaz real de la extensión.
 *
 * Uso (desde la raíz del proyecto): node general_resources/tools/generate-store-assets.mjs
 *
 * - Carga la extensión en Microsoft Edge sin ventana (--load-extension, --disable-sync y perfil temporal).
 * - Toma el popup real a 2x en cada pestaña y lo compone en lienzos con la marca.
 * - Las escenas del editor de Apps Script necesitan sesión de Google, así que usan capturas
 *   tomadas a mano en general_resources/source/ (ver README §5). Si faltan, se omiten.
 * - Guarda PNG de 24 bits sin canal alfa, como pide la tienda:
 *     general_resources/screenshots/NN-*.png  1280 × 800 (capturas, máximo 5)
 *     general_resources/promo/small-440x280.png y marquee-1400x560.png (mosaicos promocionales)
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT_ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EDGE_ = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT_ = 9336;
const POPUP_SIZE_ = { width: 400, height: 600 };
const MAX_SCREENSHOTS_ = 5;
const DASHBOARD_ = join(ROOT_, 'general_resources');
const OUT_SCREENSHOTS_ = join(DASHBOARD_, 'screenshots');
const OUT_PROMO_ = join(DASHBOARD_, 'promo');
const SOURCE_DIR_ = join(DASHBOARD_, 'source');
const sleep_ = (ms_) => new Promise((resolve_) => setTimeout(resolve_, ms_));

/** Escenas del editor: capturas manuales en source/ (1280 × 800 o mayor, misma proporción) */
const EDITOR_SCENES_ = [
  {
    id: '01-editor',
    source: 'editor.png',
    title: 'A modern IDE inside the Apps Script editor',
    text: 'Works on top of the editor tab you already use. No new app, no account.',
    bullets: ['Folders in the file tree', 'Live errors right at the line', 'Search across every file']
  },
  {
    id: '02-ai-chat',
    source: 'ai-chat.png',
    title: 'AI chat that knows your project',
    text: 'Ask about the selection, the file or the whole project. Bring your own key.',
    bullets: ['OpenAI, Anthropic, Gemini, OpenRouter and more', 'Local models with Ollama or LM Studio', 'Agent mode: review every change before applying']
  },
  {
    id: '03-github',
    source: 'github.png',
    title: 'Sync your project with GitHub',
    text: 'Push and pull Apps Script files with a visual diff and per-file selection.',
    bullets: ['Side-by-side diff', 'Pick exactly which files to sync', 'Resumable transfers with live progress']
  }
];

/** Escenas del popup: siempre se generan con la interfaz real */
const POPUP_SCENES_ = [
  {
    id: 'themes',
    tab: 'themes',
    title: '50+ themes and a theme editor',
    text: 'Change the look of the whole editor in one click, or design your own theme.',
    bullets: ['Dark mode for the full IDE', 'Duplicate and edit any theme', 'Applied live, without reloading']
  },
  {
    id: 'ai',
    tab: 'ai',
    scrollTo: '#gt-sec-provider-access',
    title: 'Your AI provider, your key',
    text: 'Network access is granted only to the providers you turn on. Nothing goes through our servers.',
    bullets: ['Inline suggestions with Tab', 'Keys stay on this device', 'Project instructions for better answers']
  },
  {
    id: 'editor-options',
    tab: 'editor',
    title: 'Tune the editor to the way you work',
    text: 'Font, minimap, rulers, bracket colors and more, applied as you change them.',
    bullets: ['Any Google Fonts code font', 'Search across all settings', 'English and Spanish interface']
  },
  {
    id: 'snippets',
    tab: 'snippets',
    title: 'Snippets for Apps Script',
    text: 'A built-in catalog for SpreadsheetApp, DriveApp and more, plus your own snippets.',
    bullets: ['Autocomplete in the editor', 'Create and edit your own', 'Organized by service']
  }
];

/* ────────── Protocolo de depuración ────────── */

let socket_ = null;
let sequence_ = 0;
const pending_ = new Map();

async function connect_() {
  for (let i_ = 0; i_ < 60 && !socket_; i_++) {
    try {
      const version_ = await (await fetch(`http://127.0.0.1:${PORT_}/json/version`)).json();
      socket_ = new WebSocket(version_.webSocketDebuggerUrl);
    } catch (error_) {
      await sleep_(250);
    }
  }
  if (!socket_) throw new Error('No fue posible conectar con Edge.');
  await new Promise((resolve_) => socket_.addEventListener('open', resolve_));
  socket_.addEventListener('message', (event_) => {
    const message_ = JSON.parse(event_.data);
    if (!message_.id || !pending_.has(message_.id)) return;
    const { resolve_, reject_ } = pending_.get(message_.id);
    pending_.delete(message_.id);
    if (message_.error) reject_(new Error(message_.error.message)); else resolve_(message_.result);
  });
}

function send_(method_, params_ = {}, sessionId_) {
  return new Promise((resolve_, reject_) => {
    const id_ = ++sequence_;
    pending_.set(id_, { resolve_, reject_ });
    socket_.send(JSON.stringify({ id: id_, method: method_, params: params_, sessionId: sessionId_ }));
  });
}

async function evaluate_(sessionId_, expression_) {
  const result_ = await send_('Runtime.evaluate', { expression: expression_, awaitPromise: true, returnByValue: true }, sessionId_);
  if (result_.exceptionDetails) throw new Error('Error en la página: ' + JSON.stringify(result_.exceptionDetails).slice(0, 300));
  return result_.result.value;
}

/** Abre una pestaña con el tamaño y la escala indicados y espera a que cargue */
async function openPage_(url_, width_, height_, scale_, preload_) {
  const { targetId } = await send_('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send_('Target.attachToTarget', { targetId, flatten: true });
  await send_('Page.enable', {}, sessionId);
  if (preload_) await send_('Page.addScriptToEvaluateOnNewDocument', { source: preload_ }, sessionId);
  await send_('Emulation.setDeviceMetricsOverride', { width: width_, height: height_, deviceScaleFactor: scale_, mobile: false }, sessionId);
  await send_('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await send_('Page.navigate', { url: url_ }, sessionId);
  await waitFor_(sessionId, `document.readyState === 'complete'`);
  return { targetId, sessionId };
}

async function waitFor_(sessionId_, condition_, timeoutMs_ = 20000) {
  const start_ = Date.now();
  while (Date.now() - start_ < timeoutMs_) {
    try { if (await evaluate_(sessionId_, condition_)) return; } catch (error_) { /* la página aún carga */ }
    await sleep_(200);
  }
  throw new Error('Tiempo agotado esperando: ' + condition_);
}

async function capture_(sessionId_) {
  const { data } = await send_('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId_);
  return Buffer.from(data, 'base64');
}

/* ────────── PNG: quitamos el canal alfa (la tienda pide 24 bits) ────────── */

function decodePng_(buffer_) {
  let position_ = 8, width_ = 0, height_ = 0, colorType_ = 0;
  const chunks_ = [];
  while (position_ < buffer_.length) {
    const length_ = buffer_.readUInt32BE(position_);
    const type_ = buffer_.toString('ascii', position_ + 4, position_ + 8);
    const data_ = buffer_.subarray(position_ + 8, position_ + 8 + length_);
    if (type_ === 'IHDR') { width_ = data_.readUInt32BE(0); height_ = data_.readUInt32BE(4); colorType_ = data_[9]; }
    if (type_ === 'IDAT') chunks_.push(data_);
    position_ += 12 + length_;
  }
  const channels_ = colorType_ === 6 ? 4 : 3;
  const stride_ = width_ * channels_;
  const raw_ = inflateSync(Buffer.concat(chunks_));
  const pixels_ = Buffer.alloc(height_ * stride_);
  for (let y_ = 0; y_ < height_; y_++) {
    const filter_ = raw_[y_ * (stride_ + 1)];
    for (let x_ = 0; x_ < stride_; x_++) {
      const left_ = x_ >= channels_ ? pixels_[y_ * stride_ + x_ - channels_] : 0;
      const up_ = y_ ? pixels_[(y_ - 1) * stride_ + x_] : 0;
      const upLeft_ = x_ >= channels_ && y_ ? pixels_[(y_ - 1) * stride_ + x_ - channels_] : 0;
      let value_ = raw_[y_ * (stride_ + 1) + 1 + x_];
      if (filter_ === 1) value_ += left_;
      else if (filter_ === 2) value_ += up_;
      else if (filter_ === 3) value_ += (left_ + up_) >> 1;
      else if (filter_ === 4) {
        const p_ = left_ + up_ - upLeft_, pa_ = Math.abs(p_ - left_), pb_ = Math.abs(p_ - up_), pc_ = Math.abs(p_ - upLeft_);
        value_ += pa_ <= pb_ && pa_ <= pc_ ? left_ : pb_ <= pc_ ? up_ : upLeft_;
      }
      pixels_[y_ * stride_ + x_] = value_ & 255;
    }
  }
  return { width: width_, height: height_, channels: channels_, pixels: pixels_ };
}

const CRC_TABLE_ = Array.from({ length: 256 }, (_, n_) => {
  let c_ = n_;
  for (let k_ = 0; k_ < 8; k_++) c_ = c_ & 1 ? 0xEDB88320 ^ (c_ >>> 1) : c_ >>> 1;
  return c_ >>> 0;
});
function crc32_(buffer_) {
  let crc_ = 0xFFFFFFFF;
  for (const byte_ of buffer_) crc_ = CRC_TABLE_[(crc_ ^ byte_) & 255] ^ (crc_ >>> 8);
  return (crc_ ^ 0xFFFFFFFF) >>> 0;
}
function chunk_(type_, data_) {
  const length_ = Buffer.alloc(4); length_.writeUInt32BE(data_.length);
  const body_ = Buffer.concat([Buffer.from(type_, 'ascii'), data_]);
  const crc_ = Buffer.alloc(4); crc_.writeUInt32BE(crc32_(body_));
  return Buffer.concat([length_, body_, crc_]);
}

/** Convierte cualquier captura a PNG RGB de 8 bits por canal, componiendo sobre blanco */
function toRgbPng_(buffer_) {
  const { width, height, channels, pixels } = decodePng_(buffer_);
  const raw_ = Buffer.alloc(height * (width * 3 + 1));
  for (let y_ = 0; y_ < height; y_++) {
    raw_[y_ * (width * 3 + 1)] = 0;
    for (let x_ = 0; x_ < width; x_++) {
      const source_ = (y_ * width + x_) * channels;
      const alpha_ = channels === 4 ? pixels[source_ + 3] / 255 : 1;
      for (let c_ = 0; c_ < 3; c_++) {
        raw_[y_ * (width * 3 + 1) + 1 + x_ * 3 + c_] = Math.round(pixels[source_ + c_] * alpha_ + 255 * (1 - alpha_));
      }
    }
  }
  const header_ = Buffer.alloc(13);
  header_.writeUInt32BE(width, 0); header_.writeUInt32BE(height, 4);
  header_[8] = 8; header_[9] = 2; // 8 bits, color RGB (sin alfa)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk_('IHDR', header_), chunk_('IDAT', deflateSync(raw_, { level: 9 })), chunk_('IEND', Buffer.alloc(0))]);
}

/* ────────── Lienzos con la marca (tokens --gt-* de gas-ui.js) ────────── */

const fileUrl_ = (path_) => pathToFileURL(path_).href;
const escape_ = (text_) => String(text_).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ICON_ = fileUrl_(join(ROOT_, 'resources/icons/icon128.png'));

function baseCss_() {
  return `
    * { box-sizing: border-box; margin: 0; }
    html, body { overflow: hidden; }
    body { font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: #1f1f1f; background: #f8fafd; }
    .bg { position: absolute; inset: 0; overflow: hidden; background: linear-gradient(135deg, #ffffff 0%, #f8fafd 55%, #e9eef6 100%); }
    .bg::before { content: ''; position: absolute; width: 760px; height: 760px; right: -180px; top: -260px; border-radius: 50%; background: radial-gradient(circle, rgba(11,87,208,0.18), rgba(11,87,208,0) 70%); }
    .bg::after { content: ''; position: absolute; width: 560px; height: 560px; right: 220px; bottom: -320px; border-radius: 50%; background: radial-gradient(circle, rgba(52,168,83,0.14), rgba(52,168,83,0) 70%); }
    .frame { position: absolute; border-radius: 14px; overflow: hidden; box-shadow: 0 24px 60px rgba(31,31,31,0.20), 0 4px 14px rgba(31,31,31,0.10); border: 1px solid #c4c7c5; background: #ffffff; }
    .frame img { display: block; width: 100%; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 600; color: #0b57d0; }
    .brand img { width: 40px; height: 40px; }
    h1 { font-weight: 700; color: #1f1f1f; letter-spacing: -0.4px; }
    .text { color: #444746; }
    .bullets { list-style: none; padding: 0; }
    .bullets li { position: relative; padding-left: 30px; color: #1f1f1f; }
    .bullets li::before { content: ''; position: absolute; left: 0; top: 0.36em; width: 16px; height: 16px; border-radius: 5px; background: #0b57d0; }
  `;
}

/** Captura con texto a la izquierda y la interfaz a la derecha (popup) o abajo a la derecha (editor) */
function screenshotHtml_(scene_, imageFile_, isEditor_) {
  const frameCss_ = isEditor_
    ? '.frame { left: 560px; top: 90px; width: 900px; }'
    : '.frame { right: 140px; top: 70px; width: 400px; }';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${baseCss_()}
    .copy { position: absolute; left: 80px; top: 0; bottom: 0; width: ${isEditor_ ? 440 : 560}px; display: flex; flex-direction: column; justify-content: center; gap: 22px; }
    .brand { font-size: 18px; }
    h1 { font-size: ${isEditor_ ? 40 : 44}px; line-height: 1.15; }
    .text { font-size: 20px; line-height: 1.5; }
    .bullets { display: grid; gap: 12px; font-size: 18px; }
    ${frameCss_}
  </style></head><body><div class="bg"></div>
    <div class="copy">
      <div class="brand"><img src="${ICON_}" alt="">Google Apps Script Tools</div>
      <h1>${escape_(scene_.title)}</h1>
      <p class="text">${escape_(scene_.text)}</p>
      <ul class="bullets">${scene_.bullets.map((b_) => `<li>${escape_(b_)}</li>`).join('')}</ul>
    </div>
    <div class="frame"><img src="${fileUrl_(imageFile_)}" alt=""></div>
  </body></html>`;
}

function smallPromoHtml_(popupFile_) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${baseCss_()}
    .bg::before { width: 420px; height: 420px; right: -160px; top: -200px; }
    .bg::after { width: 320px; height: 320px; right: 60px; bottom: -220px; }
    .copy { position: absolute; left: 26px; top: 0; bottom: 0; width: 230px; display: flex; flex-direction: column; justify-content: center; gap: 12px; }
    .copy > img { width: 48px; height: 48px; }
    h1 { font-size: 25px; line-height: 1.15; }
    .text { font-size: 14px; line-height: 1.4; }
    .frame { right: -40px; top: 30px; width: 200px; border-radius: 10px; }
  </style></head><body><div class="bg"></div>
    <div class="copy">
      <img src="${ICON_}" alt="">
      <h1>Apps Script Tools</h1>
      <p class="text">A modern IDE on top of the Apps Script editor.</p>
    </div>
    <div class="frame"><img src="${fileUrl_(popupFile_)}" alt=""></div>
  </body></html>`;
}

function marqueeHtml_(popupFile_) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${baseCss_()}
    .copy { position: absolute; left: 110px; top: 0; bottom: 0; width: 680px; display: flex; flex-direction: column; justify-content: center; gap: 22px; }
    .brand { font-size: 22px; }
    .brand img { width: 56px; height: 56px; }
    h1 { font-size: 52px; line-height: 1.1; }
    .text { font-size: 22px; line-height: 1.45; }
    .frame { right: 180px; top: 60px; width: 400px; }
  </style></head><body><div class="bg"></div>
    <div class="copy">
      <div class="brand"><img src="${ICON_}" alt="">Google Apps Script Tools</div>
      <h1>Turn the Apps Script editor into a modern IDE</h1>
      <p class="text">AI chat, live errors, GitHub sync, folders, multi-file search, themes and snippets.</p>
    </div>
    <div class="frame"><img src="${fileUrl_(popupFile_)}" alt=""></div>
  </body></html>`;
}

/** Dibuja un HTML en un lienzo del tamaño exacto y lo guarda como PNG RGB */
async function renderCanvas_(html_, width_, height_, workDir_, name_, outFile_) {
  const htmlFile_ = join(workDir_, name_ + '.html');
  writeFileSync(htmlFile_, html_);
  const page_ = await openPage_(fileUrl_(htmlFile_), width_, height_, 1);
  await waitFor_(page_.sessionId, `document.fonts.status === 'loaded' && [...document.images].every(i => i.complete && i.naturalWidth > 0)`);
  writeFileSync(outFile_, toRgbPng_(await capture_(page_.sessionId)));
  await send_('Target.closeTarget', { targetId: page_.targetId });
  console.log('Generado:', outFile_.replace(ROOT_, '.'), `(${width_} × ${height_})`);
}

/**
 * El popup solo muestra sus pestañas si la pestaña activa es el editor de Apps Script.
 * Como aquí se abre en su propia pestaña, se responde a chrome.tabs.query con una URL de editor.
 */
const EDITOR_TAB_PRELOAD_ = `(() => {
  const query_ = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (info_) => info_?.active
    ? [{ id: -1, url: 'https://script.google.com/home/projects/demo/edit' }]
    : query_(info_);
})();`;

/** Abre el popup real en la pestaña indicada y guarda la captura a 2x */
async function capturePopupTab_(popupUrl_, tab_, outFile_, scrollTo_) {
  const popup_ = await openPage_(popupUrl_, POPUP_SIZE_.width, POPUP_SIZE_.height, 2, EDITOR_TAB_PRELOAD_);
  await waitFor_(popup_.sessionId, `!document.querySelector('.qc__nav-tabs').hidden && document.fonts.status === 'loaded'`);
  await evaluate_(popup_.sessionId, `document.getElementById('tab-${tab_}').click()`);
  if (scrollTo_) await evaluate_(popup_.sessionId, `document.querySelector(${JSON.stringify(scrollTo_)})?.scrollIntoView({ block: 'start' })`);
  await sleep_(900);
  writeFileSync(outFile_, await capture_(popup_.sessionId));
  await send_('Target.closeTarget', { targetId: popup_.targetId });
}

/* ────────── Flujo principal ────────── */

const profile_ = mkdtempSync(join(tmpdir(), 'gas-tools-store-'));
const workDir_ = mkdtempSync(join(tmpdir(), 'gas-tools-store-work-'));
const edge_ = spawn(EDGE_, ['--headless=new', '--remote-debugging-port=' + PORT_, '--user-data-dir=' + profile_, '--disable-sync',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions-except=' + ROOT_, '--load-extension=' + ROOT_, 'about:blank'], { stdio: 'ignore' });

let exitCode_ = 0;
try {
  mkdirSync(OUT_PROMO_, { recursive: true });
  rmSync(OUT_SCREENSHOTS_, { recursive: true, force: true });
  mkdirSync(OUT_SCREENSHOTS_, { recursive: true });
  copyFileSync(join(ROOT_, 'resources/icons/icon128.png'), join(DASHBOARD_, 'icon-128.png'));
  await connect_();

  // Esperamos el service worker para conocer el ID de la extensión
  let extensionId_ = null;
  for (let i_ = 0; i_ < 60 && !extensionId_; i_++) {
    const { targetInfos } = await send_('Target.getTargets');
    const worker_ = targetInfos.find((t_) => t_.type === 'service_worker' && t_.url.endsWith('/extension/background.js'));
    if (worker_) extensionId_ = new URL(worker_.url).host; else await sleep_(250);
  }
  if (!extensionId_) throw new Error('No se encontró el service worker de la extensión.');
  const popupUrl_ = `chrome-extension://${extensionId_}/src/html/index.html`;

  // Escenas del editor disponibles (capturas manuales) y, después, las del popup hasta llegar a 5
  const sources_ = existsSync(SOURCE_DIR_) ? readdirSync(SOURCE_DIR_) : [];
  const editorScenes_ = EDITOR_SCENES_.filter((s_) => sources_.includes(s_.source));
  for (const s_ of EDITOR_SCENES_) if (!sources_.includes(s_.source)) console.warn(`Omitida ${s_.id}: falta source/${s_.source}`);
  const popupScenes_ = POPUP_SCENES_.slice(0, MAX_SCREENSHOTS_ - editorScenes_.length);

  const popupFiles_ = {};
  for (const scene_ of popupScenes_) {
    popupFiles_[scene_.id] = join(workDir_, `popup-${scene_.id}.png`);
    await capturePopupTab_(popupUrl_, scene_.tab, popupFiles_[scene_.id], scene_.scrollTo);
  }

  let index_ = 0;
  const name_ = (id_) => `${String(++index_).padStart(2, '0')}-${id_.replace(/^\d+-/, '')}`;
  for (const scene_ of editorScenes_) {
    const id_ = name_(scene_.id);
    await renderCanvas_(screenshotHtml_(scene_, join(SOURCE_DIR_, scene_.source), true), 1280, 800, workDir_, id_, join(OUT_SCREENSHOTS_, id_ + '.png'));
  }
  for (const scene_ of popupScenes_) {
    const id_ = name_(scene_.id);
    await renderCanvas_(screenshotHtml_(scene_, popupFiles_[scene_.id], false), 1280, 800, workDir_, id_, join(OUT_SCREENSHOTS_, id_ + '.png'));
  }

  const promoPopup_ = join(workDir_, 'popup-promo.png');
  await capturePopupTab_(popupUrl_, 'editor', promoPopup_);
  await renderCanvas_(smallPromoHtml_(promoPopup_), 440, 280, workDir_, 'small', join(OUT_PROMO_, 'small-440x280.png'));
  await renderCanvas_(marqueeHtml_(promoPopup_), 1400, 560, workDir_, 'marquee', join(OUT_PROMO_, 'marquee-1400x560.png'));
} catch (error_) {
  console.error('No fue posible generar las imágenes:', error_);
  exitCode_ = 1;
} finally {
  try { await send_('Browser.close'); } catch (error_) { /* Edge ya cerró */ }
  setTimeout(() => { try { edge_.kill(); } catch (error_) { /* sin proceso */ } process.exit(exitCode_); }, 800);
}
