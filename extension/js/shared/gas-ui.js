// Fuente de diseño compartida (tokens Material 3 estilo Google / Apps Script).
// Script clásico sin dependencias: define `window.GasUi` una sola vez e instala
// los tokens `--gt-*` en el documento que lo carga. Claro en `:root`, oscuro
// en `body.qc__is-dark-mode` (clase canónica de la opción "IDE Dark Mode").
(function (root) {
  if (!root || root.GasUi) return;

  // Id del <style> inyectado; garantiza la idempotencia de `installTokens`.
  const STYLE_ID = 'gt-ui-tokens';

  const TOKENS_CSS = `
:root {
  --gt-primary: #0b57d0;
  --gt-on-primary: #ffffff;
  --gt-primary-container: #d3e3fd;
  --gt-on-primary-container: #041e49;
  --gt-secondary-container: #c2e7ff;
  --gt-on-secondary-container: #001d35;
  --gt-background: #f0f4f9;
  --gt-surface: #ffffff;
  --gt-surface-container: #f0f4f9;
  --gt-surface-container-high: #e9eef6;
  --gt-surface-bright: #ffffff;
  --gt-on-surface: #1f1f1f;
  --gt-on-surface-variant: #444746;
  --gt-outline: #747775;
  --gt-outline-variant: #c4c7c5;
  --gt-error: #b3261e;
  --gt-on-error: #ffffff;
  --gt-error-container: #f9dedc;
  --gt-on-error-container: #410e0b;
  --gt-success: #146c2e;
  --gt-on-success: #ffffff;
  --gt-success-container: #c4eed0;
  --gt-on-success-container: #072711;
  --gt-warning: #7c5800;
  --gt-on-warning: #ffffff;
  --gt-warning-container: #ffdf99;
  --gt-on-warning-container: #261a00;
  --gt-scrim: rgba(0, 0, 0, .32);
  --gt-state-hover: rgba(31, 31, 31, .08);
  --gt-state-pressed: rgba(31, 31, 31, .12);
  --gt-code-surface: #1e1e1e;
  --gt-code-surface-high: #252526;
  --gt-code-on-surface: #d4d4d4;
  --gt-code-outline: #3c3c3c;

  --gt-font-brand: "Google Sans", Roboto, Arial, sans-serif;
  --gt-font-plain: "Google Sans Text", "Google Sans", Roboto, Arial, sans-serif;
  --gt-font-mono: "Roboto Mono", Consolas, monospace;

  --gt-type-label-s: 500 11px/16px var(--gt-font-plain);
  --gt-type-body-s: 400 12px/16px var(--gt-font-plain);
  --gt-type-body-m: 400 14px/20px var(--gt-font-plain);
  --gt-type-title-s: 500 14px/20px var(--gt-font-brand);
  --gt-type-title-m: 500 16px/24px var(--gt-font-brand);

  --gt-shape-xs: 4px;
  --gt-shape-s: 8px;
  --gt-shape-m: 12px;
  --gt-shape-l: 16px;
  --gt-shape-xl: 28px;
  --gt-shape-full: 9999px;

  --gt-space-1: 4px;
  --gt-space-2: 8px;
  --gt-space-3: 12px;
  --gt-space-4: 16px;
  --gt-space-5: 24px;

  --gt-elevation-1: 0 1px 2px rgba(0, 0, 0, .3), 0 1px 3px 1px rgba(0, 0, 0, .15);
  --gt-elevation-2: 0 1px 2px rgba(0, 0, 0, .3), 0 2px 6px 2px rgba(0, 0, 0, .15);
  --gt-elevation-3: 0 4px 8px 3px rgba(0, 0, 0, .15), 0 1px 3px rgba(0, 0, 0, .3);

  --gt-motion-standard: cubic-bezier(.2, 0, 0, 1);
  --gt-motion-duration: 150ms;

  /* Escala de z-index: por encima de la UI de GAS (popover < panel < modal < toast). */
  --gt-z-popover: 100000;
  --gt-z-panel: 2147483640;
  --gt-z-modal: 2147483646;
  --gt-z-toast: 2147483647;
}
body.qc__is-dark-mode {
  --gt-primary: #a8c7fa;
  --gt-on-primary: #062e6f;
  --gt-primary-container: #0842a0;
  --gt-on-primary-container: #d3e3fd;
  --gt-secondary-container: #004a77;
  --gt-on-secondary-container: #c2e7ff;
  --gt-background: #131314;
  --gt-surface: #1f1f1f;
  --gt-surface-container: #282a2c;
  --gt-surface-container-high: #333537;
  --gt-surface-bright: #303134;
  --gt-on-surface: #e3e3e3;
  --gt-on-surface-variant: #c4c7c5;
  --gt-outline: #8e918f;
  --gt-outline-variant: #444746;
  --gt-error: #f2b8b5;
  --gt-on-error: #601410;
  --gt-error-container: #8c1d18;
  --gt-on-error-container: #f9dedc;
  --gt-success: #6dd58c;
  --gt-on-success: #0a3818;
  --gt-success-container: #0f5223;
  --gt-on-success-container: #c4eed0;
  --gt-warning: #fbc02d;
  --gt-on-warning: #412d00;
  --gt-warning-container: #5d4200;
  --gt-on-warning-container: #ffdf99;
  --gt-scrim: rgba(0, 0, 0, .6);
  --gt-state-hover: rgba(227, 227, 227, .08);
  --gt-state-pressed: rgba(227, 227, 227, .12);
  --gt-code-surface: #1e1e1e;
  --gt-code-surface-high: #252526;
  --gt-code-on-surface: #d4d4d4;
  --gt-code-outline: #3c3c3c;
  --gt-elevation-1: 0 1px 2px rgba(0, 0, 0, .6), 0 1px 3px 1px rgba(0, 0, 0, .3);
  --gt-elevation-2: 0 1px 2px rgba(0, 0, 0, .6), 0 2px 6px 2px rgba(0, 0, 0, .3);
  --gt-elevation-3: 0 4px 8px 3px rgba(0, 0, 0, .3), 0 1px 3px rgba(0, 0, 0, .6);
}
`;

  // Hoja base compartida (componentes GM3). Se adopta en cada shadow root.
  const BASE_CSS = `
:focus-visible { outline: 2px solid var(--gt-primary); outline-offset: 2px; }

.gt-icon { display: block; flex: 0 0 auto; fill: currentColor; }

/* Botón conmutador: el texto no cambia, el estado va en aria-pressed. */
.gt-btn[aria-pressed="true"] {
  border-color: transparent;
  background: var(--gt-secondary-container);
  color: var(--gt-on-secondary-container);
}

/* Texto solo para lectores de pantalla. */
.gt-sr-only {
  position: absolute !important;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.gt-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gt-space-2);
  box-sizing: border-box;
  height: 32px;
  min-width: 0;
  padding: 0 var(--gt-space-4);
  border: 1px solid transparent;
  border-radius: var(--gt-shape-full);
  background: transparent;
  color: var(--gt-primary);
  font: 500 13px/20px var(--gt-font-brand);
  letter-spacing: .01em;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--gt-motion-duration) var(--gt-motion-standard),
    border-color var(--gt-motion-duration) var(--gt-motion-standard),
    box-shadow var(--gt-motion-duration) var(--gt-motion-standard);
}
.gt-btn:disabled, .gt-btn[aria-disabled="true"] { opacity: .38; cursor: default; }
.gt-btn--sm { height: 28px; padding: 0 var(--gt-space-3); gap: 6px; font-size: 12px; }
.gt-btn--filled { background: var(--gt-primary); color: var(--gt-on-primary); }
.gt-btn--filled:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gt-primary) 92%, var(--gt-on-primary));
  box-shadow: var(--gt-elevation-1);
}
.gt-btn--filled:active:not(:disabled) {
  background: color-mix(in srgb, var(--gt-primary) 88%, var(--gt-on-primary));
  box-shadow: none;
}
.gt-btn--tonal { background: var(--gt-primary-container); color: var(--gt-on-primary-container); }
.gt-btn--tonal:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gt-primary-container) 92%, var(--gt-on-primary-container));
}
.gt-btn--outlined { border-color: var(--gt-outline); }
.gt-btn--text { padding: 0 var(--gt-space-3); }
.gt-btn--outlined:hover:not(:disabled),
.gt-btn--text:hover:not(:disabled) { background: color-mix(in srgb, var(--gt-primary) 8%, transparent); }
.gt-btn--outlined:active:not(:disabled),
.gt-btn--text:active:not(:disabled) { background: color-mix(in srgb, var(--gt-primary) 12%, transparent); }
.gt-btn--danger { color: var(--gt-error); }
.gt-btn--danger.gt-btn--outlined:hover:not(:disabled),
.gt-btn--danger.gt-btn--text:hover:not(:disabled) { background: color-mix(in srgb, var(--gt-error) 8%, transparent); }
.gt-btn--danger.gt-btn--filled { background: var(--gt-error); color: var(--gt-on-error); }
.gt-btn--danger.gt-btn--filled:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gt-error) 92%, var(--gt-on-error));
}

.gt-icon-btn {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--gt-shape-full);
  background: transparent;
  color: var(--gt-on-surface-variant);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--gt-motion-duration) var(--gt-motion-standard),
    color var(--gt-motion-duration) var(--gt-motion-standard);
}
.gt-icon-btn:hover:not(:disabled) { background: var(--gt-state-hover); color: var(--gt-on-surface); }
.gt-icon-btn:active:not(:disabled) { background: var(--gt-state-pressed); }
.gt-icon-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
  color: var(--gt-primary);
}
.gt-icon-btn:disabled { opacity: .38; cursor: default; }
.gt-icon-btn--outlined { border: 1px solid var(--gt-outline); border-radius: var(--gt-shape-s); }

.gt-popover {
  --gt-arrow-x: 50%;
  position: fixed;
  z-index: var(--gt-z-popover);
  box-sizing: border-box;
  max-width: min(360px, calc(100vw - 16px));
  padding: var(--gt-space-3);
  border-radius: var(--gt-shape-s);
  background: var(--gt-surface-bright);
  color: var(--gt-on-surface);
  box-shadow: var(--gt-elevation-2);
  font: var(--gt-type-body-s);
}
.gt-popover[hidden] { display: none; }
.gt-popover[data-placement]::before {
  content: '';
  position: absolute;
  left: var(--gt-arrow-x);
  width: 10px;
  height: 10px;
  background: inherit;
  transform: translateX(-50%) rotate(45deg);
}
.gt-popover[data-placement="bottom"]::before { top: -5px; }
.gt-popover[data-placement="top"]::before { bottom: -5px; }
/* Variante tarjeta: cabecera tonal (la flecha inferior continúa su color). */
.gt-popover--card {
  --gt-popover-header: color-mix(in srgb, var(--gt-primary) 10%, var(--gt-surface-bright));
  width: 280px;
  padding: 0;
  border: 1px solid var(--gt-outline-variant);
  border-radius: var(--gt-shape-m);
}
.gt-popover--card[data-placement="bottom"]::before { background: var(--gt-popover-header); }
.gt-popover__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--gt-outline-variant);
  border-radius: var(--gt-shape-m) var(--gt-shape-m) 0 0;
  background: var(--gt-popover-header);
}
.gt-popover__icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: var(--gt-shape-s);
  background: var(--gt-surface-bright);
  color: var(--gt-primary);
  box-shadow: var(--gt-elevation-1);
}
.gt-popover__title {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--gt-primary);
  font: 500 13px/1.3 var(--gt-font-brand);
}

.gt-menu {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 160px;
  padding: var(--gt-space-1);
  border-radius: var(--gt-shape-s);
  background: var(--gt-surface-bright);
  color: var(--gt-on-surface);
  box-shadow: var(--gt-elevation-2);
}
.gt-menu-item {
  display: flex;
  align-items: center;
  gap: var(--gt-space-3);
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  padding: 6px var(--gt-space-3);
  border: 0;
  border-radius: var(--gt-shape-xs);
  background: transparent;
  color: var(--gt-on-surface);
  font: 400 13px/18px var(--gt-font-plain);
  text-align: left;
  cursor: pointer;
}
.gt-menu-item:hover:not(:disabled) { background: var(--gt-state-hover); }
.gt-menu-item:focus-visible {
  outline: none;
  background: color-mix(in srgb, var(--gt-primary) 12%, transparent);
  box-shadow: inset 0 0 0 1px var(--gt-primary);
}
.gt-menu-item:disabled { opacity: .38; cursor: default; }

.gt-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--gt-z-modal);
  display: grid;
  place-items: center;
  padding: var(--gt-space-4);
  background: var(--gt-scrim);
  animation: gt-fade-in var(--gt-motion-duration) var(--gt-motion-standard);
}
.gt-dialog {
  box-sizing: border-box;
  width: min(400px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: var(--gt-space-5);
  border-radius: var(--gt-shape-xl);
  background: var(--gt-surface-container-high);
  color: var(--gt-on-surface);
  box-shadow: var(--gt-elevation-3);
  font: var(--gt-type-body-m);
  animation: gt-dialog-in 200ms var(--gt-motion-standard);
}
.gt-dialog__title { margin: 0 0 var(--gt-space-4); font: 400 20px/28px var(--gt-font-brand); }
.gt-dialog__body { margin: 0; color: var(--gt-on-surface-variant); white-space: pre-wrap; overflow-wrap: anywhere; }
.gt-dialog__actions { display: flex; justify-content: flex-end; gap: var(--gt-space-2); margin-top: var(--gt-space-5); }
.gt-dialog__list {
  max-height: 180px;
  overflow-y: auto;
  margin: var(--gt-space-3) 0 0;
  padding: var(--gt-space-2);
  list-style: none;
  border: 1px solid var(--gt-outline-variant);
  border-radius: var(--gt-shape-s);
  background: var(--gt-surface);
  color: var(--gt-on-surface-variant);
  font: 400 12px/1.6 var(--gt-font-mono);
}
.gt-dialog__list li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.gt-field { display: flex; flex-direction: column; gap: var(--gt-space-1); min-width: 0; }
.gt-field__label { color: var(--gt-on-surface-variant); font: var(--gt-type-label-s); }
.gt-input,
.gt-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 var(--gt-space-3);
  border: 1px solid var(--gt-outline);
  border-radius: var(--gt-shape-s);
  background: var(--gt-surface);
  color: var(--gt-on-surface);
  font: 400 13px/20px var(--gt-font-plain);
  outline: none;
  transition: border-color var(--gt-motion-duration) var(--gt-motion-standard),
    box-shadow var(--gt-motion-duration) var(--gt-motion-standard);
}
textarea.gt-input { height: auto; min-height: 80px; padding: var(--gt-space-2) var(--gt-space-3); line-height: 1.5; resize: vertical; }
.gt-input::placeholder { color: var(--gt-on-surface-variant); opacity: .8; }
.gt-input:hover:not(:disabled):not(:focus),
.gt-select:hover:not(:disabled):not(:focus) { border-color: var(--gt-on-surface); }
.gt-input:focus,
.gt-select:focus { border-color: var(--gt-primary); box-shadow: inset 0 0 0 1px var(--gt-primary); }
.gt-input:disabled,
.gt-select:disabled { opacity: .38; }
.gt-input[aria-invalid="true"] { border-color: var(--gt-error); }
.gt-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 32px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238e918f' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  text-overflow: ellipsis;
  cursor: pointer;
}
.gt-select option { background: var(--gt-surface-bright); color: var(--gt-on-surface); }

.gt-toast-stack {
  position: fixed;
  left: 0;
  right: 0;
  bottom: var(--gt-space-4);
  z-index: var(--gt-z-toast);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gt-space-1);
  padding: 0 var(--gt-space-2);
  pointer-events: none;
}
.gt-toast {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
  gap: var(--gt-space-2);
  box-sizing: border-box;
  width: min(100%, 480px);
  padding: 9px 10px 9px 12px;
  border-radius: var(--gt-shape-s);
  box-shadow: var(--gt-elevation-2);
  font: 500 12px/1.45 var(--gt-font-plain);
  pointer-events: auto;
  animation: gt-toast-in .22s var(--gt-motion-standard) both;
}
.gt-toast--info { background: var(--gt-primary-container); color: var(--gt-on-primary-container); }
.gt-toast--success { background: var(--gt-success-container); color: var(--gt-on-success-container); }
.gt-toast--warning { background: var(--gt-warning-container); color: var(--gt-on-warning-container); }
.gt-toast--error { background: var(--gt-error-container); color: var(--gt-on-error-container); }
.gt-toast--out { animation: gt-toast-out .2s ease-in forwards; }
.gt-toast__icon { flex: 0 0 auto; margin-top: 1px; }
.gt-toast__body { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.gt-toast__close {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin: -2px -4px -2px 0;
  padding: 0;
  border: 0;
  border-radius: var(--gt-shape-xs);
  background: transparent;
  color: inherit;
  opacity: .7;
  cursor: pointer;
}
.gt-toast__close:hover { opacity: 1; background: var(--gt-state-hover); }
.gt-toast__progress {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 2px;
  background: currentColor;
  opacity: .35;
  transform-origin: left;
  animation: gt-toast-progress linear forwards;
}

.gt-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--gt-space-1);
  box-sizing: border-box;
  max-width: 100%;
  height: 28px;
  padding: 0 var(--gt-space-3);
  border: 1px solid var(--gt-outline-variant);
  border-radius: var(--gt-shape-s);
  background: transparent;
  color: var(--gt-on-surface-variant);
  font: 500 12px/16px var(--gt-font-plain);
}
button.gt-chip { cursor: pointer; }
button.gt-chip:hover { background: var(--gt-state-hover); }
.gt-chip--selected, .gt-chip[aria-selected="true"] {
  border-color: transparent;
  background: var(--gt-primary-container);
  color: var(--gt-on-primary-container);
}

.gt-progress {
  --gt-progress: 0%;
  position: relative;
  display: block;
  width: 100%;
  height: 4px;
  overflow: hidden;
  border-radius: var(--gt-shape-full);
  background: var(--gt-primary-container);
}
.gt-progress::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: var(--gt-progress);
  border-radius: inherit;
  background: var(--gt-primary);
  transition: width .2s var(--gt-motion-standard);
}
.gt-progress--indeterminate::before { width: 40%; animation: gt-progress-slide 1.2s ease-in-out infinite; }

@keyframes gt-fade-in { from { opacity: 0; } }
@keyframes gt-dialog-in { from { opacity: 0; transform: scale(.96); } }
@keyframes gt-toast-in { from { opacity: 0; transform: translateY(-8px) scale(.97); } }
@keyframes gt-toast-out { to { opacity: 0; transform: translateY(-6px) scale(.96); } }
@keyframes gt-toast-progress { to { transform: scaleX(0); } }
@keyframes gt-progress-slide { from { left: -40%; } to { left: 100%; } }

@media (prefers-reduced-motion: reduce) {
  .gt-btn, .gt-icon-btn, .gt-input, .gt-select, .gt-progress::before { transition: none; }
  .gt-scrim, .gt-dialog, .gt-toast, .gt-toast--out { animation-duration: .001ms; }
  .gt-progress--indeterminate::before { animation: none; width: 100%; opacity: .5; }
}
`;

  // Material Symbols (Outlined, 400; sufijo `Fill` = FILL 1). viewBox por defecto "0 -960 960 960".
  const ICON_VIEWBOX = '0 -960 960 960';
  const ICONS = {
    accountTree: 'M600-120v-120H440v-400h-80v120H80v-320h280v120h240v-120h280v320H600v-120h-80v320h80v-120h280v320H600ZM160-760v160-160Zm520 400v160-160Zm0-400v160-160Zm0 160h120v-160H680v160Zm0 400h120v-160H680v160ZM160-600h120v-160H160v160Z',
    altRoute: 'M440-80v-200q0-56-17-83t-45-53l57-57q12 11 23 23.5t22 26.5q14-19 28.5-33.5T538-485q38-35 69-81t33-161l-63 63-57-56 160-160 160 160-56 56-64-63q-2 143-44 203.5T592-425q-32 29-52 56.5T520-280v200h-80ZM248-633q-4-20-5.5-44t-2.5-50l-64 63-56-56 160-160 160 160-57 56-63-62q0 21 2 39.5t4 34.5l-78 19Zm86 176q-20-21-38.5-49T263-575l77-19q10 27 23 46t28 34l-57 57Z',
    apply: 'M120-320v-80h280v80H120Zm0-160v-80h440v80H120Zm0-160v-80h440v80H120Zm534 400L512-382l56-56 86 84 170-170 56 58-226 226Z',
    arrowForward: 'M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z',
    at: 'M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480v58q0 59-40.5 100.5T740-280q-35 0-66-15t-52-43q-29 29-65.5 43.5T480-280q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480v58q0 26 17 44t43 18q26 0 43-18t17-44v-58q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93h200v80H480Zm0-280q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z',
    autoAwesome: 'm760-600-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110Zm0 560-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110ZM360-160 260-380 40-480l220-100 100-220 100 220 220 100-220 100-100 220Zm0-194 40-86 86-40-86-40-40-86-40 86-86 40 86 40 40 86Zm0-126Z',
    autoAwesomeFill: 'm760-600-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110Zm0 560-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110ZM360-160 260-380 40-480l220-100 100-220 100 220 220 100-220 100-100 220Z',
    autorenew: 'M204-318q-22-38-33-78t-11-82q0-134 93-228t227-94h7l-64-64 56-56 160 160-160 160-56-56 64-64h-7q-100 0-170 70.5T240-478q0 26 6 51t18 49l-60 60ZM481-40 321-200l160-160 56 56-64 64h7q100 0 170-70.5T720-482q0-26-6-51t-18-49l60-60q22 38 33 78t11 82q0 134-93 228t-227 94h-7l64 64-56 56Z',
    back: 'M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z',
    book: 'M270-80q-45 0-77.5-30.5T160-186v-558q0-38 23.5-68t61.5-38l395-78v640l-379 76q-9 2-15 9.5t-6 16.5q0 11 9 18.5t21 7.5h450v-640h80v720H270Zm90-233 200-39v-478l-200 39v478Zm-80 16v-478l-15 3q-11 2-18 9.5t-7 18.5v457q5-2 10.5-3.5T261-293l19-4Zm-40-472v482-482Z',
    branch: 'M440-160v-304L240-664v104h-80v-240h240v80H296l224 224v336h-80Zm154-376-58-58 128-126H560v-80h240v240h-80v-104L594-536Z',
    bug: 'M480-200q66 0 113-47t47-113v-160q0-66-47-113t-113-47q-66 0-113 47t-47 113v160q0 66 47 113t113 47Zm-80-120h160v-80H400v80Zm0-160h160v-80H400v80Zm80 40Zm0 320q-65 0-120.5-32T272-240H160v-80h84q-3-20-3.5-40t-.5-40h-80v-80h80q0-20 .5-40t3.5-40h-84v-80h112q14-23 31.5-43t40.5-35l-64-66 56-56 86 86q28-9 57-9t57 9l88-86 56 56-66 66q23 15 41.5 34.5T688-640h112v80h-84q3 20 3.5 40t.5 40h80v80h-80q0 20-.5 40t-3.5 40h84v80H688q-32 56-87.5 88T480-120Z',
    build: 'M686-132 444-376q-20 8-40.5 12t-43.5 4q-100 0-170-70t-70-170q0-36 10-68.5t28-61.5l146 146 72-72-146-146q29-18 61.5-28t68.5-10q100 0 170 70t70 170q0 23-4 43.5T584-516l244 242q12 12 12 29t-12 29l-84 84q-12 12-29 12t-29-12Zm29-85 27-27-256-256q18-20 26-46.5t8-53.5q0-60-38.5-104.5T386-758l74 74q12 12 12 28t-12 28L332-500q-12 12-28 12t-28-12l-74-74q9 57 53.5 95.5T360-440q26 0 52-8t47-25l256 256ZM472-488Z',
    buildFill: 'M686-132 444-376q-20 8-40.5 12t-43.5 4q-100 0-170-70t-70-170q0-36 10-68.5t28-61.5l146 146 72-72-146-146q29-18 61.5-28t68.5-10q100 0 170 70t70 170q0 23-4 43.5T584-516l244 242q12 12 12 29t-12 29l-84 84q-12 12-29 12t-29-12Z',
    cached: 'M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z',
    chat: 'M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z',
    check: 'M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z',
    checkCircleFill: 'm424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z',
    chevronDown: 'M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z',
    chevronLeft: 'M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z',
    chevronRight: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z',
    chevronUp: 'm296-345-56-56 240-240 240 240-56 56-184-184-184 184Z',
    close: 'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
    cloudDone: 'm414-280 226-226-58-58-169 169-84-84-57 57 142 142ZM260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm0-80h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41Zm220-240Z',
    cloudDoneFill: 'm414-280 226-226-58-58-169 169-84-84-57 57 142 142ZM260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Z',
    cloudDownload: 'M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q17-72 85-137t145-65q33 0 56.5 23.5T520-716v242l64-62 56 56-160 160-160-160 56-56 64 62v-242q-76 14-118 73.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-48-22-89.5T600-680v-93q74 35 117 103.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm220-358Z',
    cloudUpload: 'M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q25-92 100-149t170-57q117 0 198.5 81.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H520q-33 0-56.5-23.5T440-240v-206l-64 62-56-56 160-160 160 160-56 56-64-62v206h220q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-83-58.5-141.5T480-720q-83 0-141.5 58.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h100v80H260Zm220-280Z',
    code: 'M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z',
    commit: 'M352.5-325.5Q298-371 284-440H80v-80h204q14-69 68.5-114.5T480-680q73 0 127.5 45.5T676-520h204v80H676q-14 69-68.5 114.5T480-280q-73 0-127.5-45.5ZM480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z',
    contrast: 'M324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM520-163q119-15 199.5-104.5T800-480q0-123-80.5-212.5T520-797v634Z',
    copy: 'M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z',
    deleteSweep: 'M600-240v-80h160v80H600Zm0-320v-80h280v80H600Zm0 160v-80h240v80H600ZM120-640H80v-80h160v-60h160v60h160v80h-40v360q0 33-23.5 56.5T440-200H200q-33 0-56.5-23.5T120-280v-360Zm80 0v360h240v-360H200Zm0 0v360-360Z',
    doneAll: 'M268-240 42-466l57-56 170 170 56 56-57 56Zm226 0L268-466l56-57 170 170 368-368 56 57-424 424Zm0-226-57-56 198-198 57 56-198 198Z',
    download: 'M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z',
    editNote: 'M160-400v-80h280v80H160Zm0-160v-80h440v80H160Zm0-160v-80h440v80H160Zm360 560v-123l221-220q9-9 20-13t22-4q12 0 23 4.5t20 13.5l37 37q8 9 12.5 20t4.5 22q0 11-4 22.5T863-380L643-160H520Zm300-263-37-37 37 37ZM580-220h38l121-122-18-19-19-18-122 121v38Zm141-141-19-18 37 37-18-19Z',
    error: 'm336-280 144-144 144 144 56-56-144-144 144-144-56-56-144 144-144-144-56 56 144 144-144 144 56 56ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z',
    eye: 'M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-72q-45 0-76.5-31.5T372-500q0-45 31.5-76.5T480-608q45 0 76.5 31.5T588-500q0 45-31.5 76.5T480-392Zm0 192q-146 0-266-81.5T40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200Zm0-300Zm0 220q113 0 207.5-59.5T832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-280Z',
    eyeOff: 'm644-428-58-58q9-47-27-88t-93-32l-58-58q17-8 34.5-12t37.5-4q75 0 127.5 52.5T660-500q0 20-4 37.5T644-428Zm128 126-58-56q38-29 67.5-63.5T832-500q-50-101-143.5-160.5T480-720q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t90-8.5q151 0 269 83.5T920-500q-23 59-60.5 109.5T772-302Zm20 246L624-222q-35 11-70.5 16.5T480-200q-151 0-269-83.5T40-500q21-53 53-98.5t73-81.5L56-792l56-56 736 736-56 56ZM222-624q-29 26-53 57t-41 67q50 101 143.5 160.5T480-280q20 0 39-2.5t39-5.5l-36-38q-11 3-21 4.5t-21 1.5q-75 0-127.5-52.5T300-500q0-11 1.5-21t4.5-21l-84-82Zm319 93Zm-151 75Z',
    file: 'M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z',
    fileNew: 'M440-240h80v-120h120v-80H520v-120h-80v120H320v80h120v120ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z',
    folderOpen: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640H447l-80-80H160v480l96-320h684L837-217q-8 26-29.5 41.5T760-160H160Zm84-80h516l72-240H316l-72 240Zm0 0 72-240-72 240Zm-84-400v-80 80Z',
    google: { viewBox: '0 0 24 24', d: 'M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z' },
    help: 'M513.5-254.5Q528-269 528-290t-14.5-35.5Q499-340 478-340t-35.5 14.5Q428-311 428-290t14.5 35.5Q457-240 478-240t35.5-14.5ZM442-394h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z',
    history: 'M480-120q-138 0-240.5-91.5T122-440h82q14 104 92.5 172T480-200q117 0 198.5-81.5T760-480q0-117-81.5-198.5T480-760q-69 0-129 32t-101 88h110v80H120v-240h80v94q51-64 124.5-99T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-120Zm112-192L440-464v-216h80v184l128 128-56 56Z',
    hourglass: 'M320-160h320v-120q0-66-47-113t-113-47q-66 0-113 47t-47 113v120ZM160-80v-80h80v-120q0-61 28.5-114.5T348-480q-51-32-79.5-85.5T240-680v-120h-80v-80h640v80h-80v120q0 61-28.5 114.5T612-480q51 32 79.5 85.5T720-280v120h80v80H160Z',
    info: 'M440-280h80v-240h-80v240Zm40-320q17 0 28.5-11.5T520-640q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640q0 17 11.5 28.5T480-600Zm0 520q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z',
    infoFill: 'M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z',
    insert: 'M160-120v-80h640v80H160Zm320-160L280-480l56-56 104 104v-408h80v408l104-104 56 56-200 200Z',
    key: 'M223.5-423.5Q200-447 200-480t23.5-56.5Q247-560 280-560t56.5 23.5Q360-513 360-480t-23.5 56.5Q313-400 280-400t-56.5-23.5ZM280-240q-100 0-170-70T40-480q0-100 70-170t170-70q67 0 121.5 33t86.5 87h352l120 120-180 180-80-60-80 60-85-60h-47q-32 54-86.5 87T280-240Zm0-80q56 0 98.5-34t56.5-86h125l58 41 82-61 71 55 75-75-40-40H435q-14-52-56.5-86T280-640q-66 0-113 47t-47 113q0 66 47 113t113 47Z',
    language: 'M325-111.5q-73-31.5-127.5-86t-86-127.5Q80-398 80-480.5t31.5-155q31.5-72.5 86-127t127.5-86Q398-880 480.5-880t155 31.5q72.5 31.5 127 86t86 127Q880-563 880-480.5T848.5-325q-31.5 73-86 127.5t-127 86Q563-80 480.5-80T325-111.5ZM480-162q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z',
    linkOff: 'm770-302-60-62q40-11 65-42.5t25-73.5q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 57-29.5 105T770-302ZM634-440l-80-80h86v80h-6ZM792-56 56-792l56-56 736 736-56 56ZM440-280H280q-83 0-141.5-58.5T80-480q0-69 42-123t108-71l74 74h-24q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h65l79 80H320Z',
    list: 'M360-200v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360ZM200-160q-33 0-56.5-23.5T120-240q0-33 23.5-56.5T200-320q33 0 56.5 23.5T280-240q0 33-23.5 56.5T200-160Zm0-240q-33 0-56.5-23.5T120-480q0-33 23.5-56.5T200-560q33 0 56.5 23.5T280-480q0 33-23.5 56.5T200-400Zm0-240q-33 0-56.5-23.5T120-720q0-33 23.5-56.5T200-800q33 0 56.5 23.5T280-720q0 33-23.5 56.5T200-640Z',
    lock: 'M240-80q-33 0-56.5-23.5T160-160v-400q0-33 23.5-56.5T240-640h40v-80q0-83 58.5-141.5T480-920q83 0 141.5 58.5T680-720v80h40q33 0 56.5 23.5T800-560v400q0 33-23.5 56.5T720-80H240Zm0-80h480v-400H240v400Zm296.5-143.5Q560-327 560-360t-23.5-56.5Q513-440 480-440t-56.5 23.5Q400-393 400-360t23.5 56.5Q447-280 480-280t56.5-23.5ZM360-640h240v-80q0-50-35-85t-85-35q-50 0-85 35t-35 85v80ZM240-160v-400 400Z',
    login: 'M480-120v-80h280v-560H480v-80h280q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H480Zm-80-160-55-58 102-102H120v-80h327L345-622l55-58 200 200-200 200Z',
    logout: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h280v80H200Zm440-160-55-58 102-102H360v-80h327L585-622l55-58 200 200-200 200Z',
    looksOne: 'M480-280h80v-400H400v80h80v320ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z',
    looksTwo: 'M360-280h240v-80H440v-80h80q33 0 56.5-23.5T600-520v-80q0-33-23.5-56.5T520-680H360v80h160v80h-80q-33 0-56.5 23.5T360-440v160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z',
    merge: 'M664-160 440-384v-301L336-581l-57-57 201-201 200 200-57 57-103-103v269l200 200-56 56Zm-368 1-56-56 127-128 57 57-128 127Z',
    minus: 'M200-440v-80h560v80H200Z',
    newChat: 'M440-400h80v-120h120v-80H520v-120h-80v120H320v80h120v120ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm126-240h594v-480H160v525l46-45Zm-46 0v-480 480Z',
    openInNew: 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z',
    palette: 'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-177 23q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120-160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm200 0q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120 160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17ZM480-160q9 0 14.5-5t5.5-13q0-14-15-33t-15-57q0-42 29-67t71-25h70q66 0 113-38.5T800-518q0-121-92.5-201.5T488-800q-136 0-232 93t-96 227q0 133 93.5 226.5T480-160Z',
    paletteFill: 'M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80ZM303-457q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120-160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm200 0q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120 160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Z',
    pencil: 'M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z',
    person: 'M367-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Zm80-80h480v-32q0-11-5.5-20T700-306q-54-27-109-40.5T480-360q-56 0-111 13.5T260-306q-9 5-14.5 14t-5.5 20v32Zm296.5-343.5Q560-607 560-640t-23.5-56.5Q513-720 480-720t-56.5 23.5Q400-673 400-640t23.5 56.5Q447-560 480-560t56.5-23.5ZM480-640Zm0 400Z',
    plus: 'M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z',
    project: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z',
    radioUnchecked: 'M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Z',
    refresh: 'M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z',
    replace: 'M280-160 80-360l200-200 56 57-103 103h287v80H233l103 103-56 57Zm400-240-56-57 103-103H440v-80h287L624-743l56-57 200 200-200 200Z',
    restartAlt: 'M440-122q-121-15-200.5-105.5T160-440q0-66 26-126.5T260-672l57 57q-38 34-57.5 79T240-440q0 88 56 155.5T440-202v80Zm80 0v-80q87-16 143.5-83T720-440q0-100-70-170t-170-70h-3l44 44-56 56-140-140 140-140 56 56-44 44h3q134 0 227 93t93 227q0 121-79.5 211.5T520-122Z',
    retry: 'M480-80q-75 0-140.5-28.5t-114-77q-48.5-48.5-77-114T120-440h80q0 117 81.5 198.5T480-160q117 0 198.5-81.5T760-440q0-117-81.5-198.5T480-720h-6l62 62-56 58-160-160 160-160 56 58-62 62h6q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-440q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-80Z',
    save: 'M840-680v480q0 33-23.5 56.5T760-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h480l160 160Zm-80 34L646-760H200v560h560v-446ZM565-275q35-35 35-85t-35-85q-35-35-85-35t-85 35q-35 35-35 85t35 85q35 35 85 35t85-35ZM240-560h360v-160H240v160Zm-40-86v446-560 114Z',
    science: 'M200-120q-51 0-72.5-45.5T138-250l222-270v-240h-40q-17 0-28.5-11.5T280-800q0-17 11.5-28.5T320-840h320q17 0 28.5 11.5T680-800q0 17-11.5 28.5T640-760h-40v240l222 270q32 39 10.5 84.5T760-120H200Zm0-80h560L520-492v-268h-80v268L200-200Zm280-280Z',
    search: 'M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z',
    searchOff: 'M138.5-138.5Q80-197 80-280t58.5-141.5Q197-480 280-480t141.5 58.5Q480-363 480-280t-58.5 141.5Q363-80 280-80t-141.5-58.5ZM824-120 568-376q-12-13-25.5-26.5T516-428q38-24 61-64t23-88q0-75-52.5-127.5T420-760q-75 0-127.5 52.5T240-580q0 6 .5 11.5T242-557q-18 2-39.5 8T164-535q-2-11-3-22t-1-23q0-109 75.5-184.5T420-840q109 0 184.5 75.5T680-580q0 43-13.5 81.5T629-428l251 252-56 56Zm-615-61 71-71 70 71 29-28-71-71 71-71-28-28-71 71-71-71-28 28 71 71-71 71 28 28Z',
    selection: 'M120-600v-160q0-33 23.5-56.5T200-840h160v80H200v160h-80Zm480-240h160q33 0 56.5 23.5T840-760v160h-80v-160H600v-80Zm240 480v160q0 33-23.5 56.5T760-120H600v-80h160v-160h80ZM360-120H200q-33 0-56.5-23.5T120-200v-160h80v160h160v80Zm-80-400h400v-80H280v80Zm0 160h240v-80H280v80Z',
    send: 'M440-160v-487L216-423l-56-57 320-320 320 320-56 57-224-224v487h-80Z',
    settings: 'm370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z',
    sliders: 'M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z',
    spark: 'm720-560-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110Zm0 480-50-110-110-50 110-50 50-110 50 110 110 50-110 50-50 110ZM360-200 260-420 40-520l220-100 100-220 100 220 220 100-220 100-100 220Zm0-194 40-86 86-40-86-40-40-86-40 86-86 40 86 40 40 86Zm0-126Z',
    stop: 'M240-240v-480h480v480H240Z',
    success: 'm424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z',
    swipeVertical: 'M80-80v-60h81q-59-72-90-159T40-480q0-94 31-181t90-159H80v-60h200v200h-60v-116q-58 66-89 147t-31 169q0 88 31 169t89 147v-116h60v200H80Zm578-47q-23 8-46.5 7.5T566-131L304-253l18-40q10-20 28-32.5t40-14.5l68-5-112-307q-6-16 1-30.5t23-20.5q16-6 30.5 1t20.5 23l148 407-100 7 131 61q7 3 15 3.5t15-1.5l157-57q31-11 45-41.5t3-61.5l-55-150q-6-16 1-30.5t23-20.5q16-6 30.5 1t20.5 23l55 150q23 63-4.5 122.5T815-184l-157 57Zm-90-265-54-151q-6-16 1-30.5t23-20.5q16-6 30.5 1t20.5 23l55 150-76 28Zm113-41-41-113q-6-16 1-30.5t23-20.5q16-6 30.5 1t20.5 23l41 112-75 28Zm8 88Z',
    tag: 'm240-160 40-160H120l20-80h160l40-160H180l20-80h160l40-160h80l-40 160h160l40-160h80l-40 160h160l-20 80H660l-40 160h160l-20 80H600l-40 160h-80l40-160H360l-40 160h-80Zm140-240h160l40-160H420l-40 160Z',
    terminal: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H160v400Zm140-40-56-56 103-104-104-104 57-56 160 160-160 160Zm180 0v-80h240v80H480Z',
    terminalFill: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H160v400Zm140-40-56-56 103-104-104-104 57-56 160 160-160 160Zm180 0v-80h240v80H480Z',
    textFields: 'M280-160v-520H80v-120h520v120H400v520H280Zm360 0v-320H520v-120h360v120H760v320H640Z',
    translate: 'm476-80 182-480h84L924-80h-84l-43-122H603L560-80h-84ZM160-200l-56-56 202-202q-35-35-63.5-80T190-640h84q20 39 40 68t48 58q33-33 68.5-92.5T484-720H40v-80h280v-80h80v80h280v80H564q-21 72-63 148t-83 116l96 98-30 82-122-125-202 201Zm468-72h144l-72-204-72 204Z',
    trash: 'M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z',
    troubleshoot: 'M824-120 636-308q-41 32-90.5 50T440-240q-90 0-162.5-44T163-400h98q34 37 79.5 58.5T440-320q100 0 170-70t70-170q0-100-70-170t-170-70q-94 0-162.5 63.5T201-580h-80q8-127 99.5-213.5T440-880q134 0 227 93t93 227q0 56-18 105.5T692-364l188 188-56 56ZM397-400l-63-208-52 148H80v-60h160l66-190h60l61 204 43-134h60l60 120h30v60h-67l-47-94-50 154h-59Z',
    unfoldMore: 'M480-120 300-300l58-58 122 122 122-122 58 58-180 180ZM358-598l-58-58 180-180 180 180-58 58-122-122-122 122Z',
    uploadFile: 'M440-200h80v-167l64 64 56-57-160-160-160 160 57 56 63-63v167ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z',
    warn: 'm40-120 440-760 440 760H40Zm138-80h604L480-720 178-200Zm302-40q17 0 28.5-11.5T520-280q0-17-11.5-28.5T480-320q-17 0-28.5 11.5T440-280q0 17 11.5 28.5T480-240Zm-40-120h80v-200h-80v200Zm40-100Z',
  };
  // Alias del registro (mismo trazo, nombre semántico distinto).
  ICONS.folder = ICONS.project;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TOAST_KINDS = { info: 'info', success: 'success', warning: 'warn', error: 'error' };
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Normaliza la entrada del registro de iconos.
   * @param {string} name Nombre del icono.
   * @returns {{d:string, viewBox:string}|null} Datos del path o null si no existe.
   */
  function iconData(name) {
    const entry = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : null;
    if (!entry) return null;
    return typeof entry === 'string' ? { d: entry, viewBox: ICON_VIEWBOX } : entry;
  }

  /**
   * Marcado SVG de un icono (para plantillas que pasan por DomUtils.setHTML).
   * @param {string} name Nombre del registro (`GasUi.ICON_NAMES`).
   * @param {number} [size=16] Lado en px.
   * @returns {string} `<svg>` o '' si el nombre no existe.
   */
  function icon(name, size = 16) {
    const data = iconData(name);
    if (!data) return '';
    const px = Number(size) > 0 ? Number(size) : 16;
    return `<svg class="gt-icon" width="${px}" height="${px}" viewBox="${data.viewBox}" aria-hidden="true" focusable="false"><path d="${data.d}"/></svg>`;
  }

  /**
   * Crea el icono como nodo DOM (sin parsear HTML).
   * @param {Document} doc Documento propietario.
   * @param {string} name Nombre del registro.
   * @param {number} [size=16] Lado en px.
   * @returns {SVGElement|null} Nodo o null si el nombre no existe.
   */
  function iconNode(doc, name, size = 16) {
    const data = iconData(name);
    if (!data || !doc?.createElementNS) return null;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    const px = String(Number(size) > 0 ? Number(size) : 16);
    svg.setAttribute('class', 'gt-icon');
    svg.setAttribute('width', px);
    svg.setAttribute('height', px);
    svg.setAttribute('viewBox', data.viewBox);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', data.d);
    svg.appendChild(path);
    return svg;
  }

  // Caché de hojas construidas (una por texto CSS) y de ids del fallback.
  const sheetCache = new Map();
  const fallbackIds = new Map();

  /**
   * Devuelve la CSSStyleSheet cacheada para un CSS (null sin soporte).
   * @param {string} css Texto CSS.
   * @returns {CSSStyleSheet|null} Hoja compartida.
   */
  function sheetFor(css) {
    if (sheetCache.has(css)) return sheetCache.get(css);
    const Ctor = root.CSSStyleSheet;
    if (typeof Ctor !== 'function' || typeof Ctor.prototype?.replaceSync !== 'function') return null;
    const sheet = new Ctor();
    sheet.replaceSync(css);
    sheetCache.set(css, sheet);
    return sheet;
  }

  /**
   * Adopta la hoja base (y hojas extra) en un shadow root o documento.
   * Idempotente; usa `<style>` si no hay `adoptedStyleSheets`.
   * @param {ShadowRoot|Document} target Raíz destino.
   * @param {...string} extraCss CSS propio del componente (se cachea).
   * @returns {boolean} false si no hay raíz válida.
   */
  function adopt(target, ...extraCss) {
    if (!target) return false;
    const cssList = [BASE_CSS, ...extraCss.filter((css) => typeof css === 'string' && css)];
    if (Array.isArray(target.adoptedStyleSheets)) {
      const sheets = cssList.map(sheetFor);
      if (sheets.every(Boolean)) {
        const current = target.adoptedStyleSheets;
        const missing = sheets.filter((s) => !current.includes(s));
        if (missing.length) target.adoptedStyleSheets = [...current, ...missing];
        return true;
      }
    }
    const doc = target.ownerDocument || target;
    if (typeof doc.createElement !== 'function' || typeof target.querySelector !== 'function') return false;
    let prev = null;
    for (const css of cssList) {
      if (!fallbackIds.has(css)) fallbackIds.set(css, `gt-sheet-${fallbackIds.size}`);
      const id = fallbackIds.get(css);
      let style = target.querySelector(`style[data-gt-sheet="${id}"]`);
      if (!style) {
        style = doc.createElement('style');
        style.setAttribute('data-gt-sheet', id);
        style.textContent = css;
        if (prev) prev.after(style);
        else target.prepend(style);
      }
      prev = style;
    }
    return true;
  }

  /**
   * Raíz donde adoptar estilos para un contenedor dado.
   * @param {Node} node Shadow root, documento o elemento.
   * @returns {ShadowRoot|Document|null} Raíz de estilos.
   */
  function styleRootOf(node) {
    if (!node) return null;
    if ('adoptedStyleSheets' in node) return node;
    return node.getRootNode?.() || null;
  }

  /**
   * Crea un elemento con clase y texto opcionales (sin HTML).
   * @param {Document} doc Documento propietario.
   * @param {string} tag Etiqueta.
   * @param {string} [className] Clases.
   * @param {string} [text] Texto plano.
   * @returns {HTMLElement} Elemento creado.
   */
  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  // Id del host (light DOM) de los toasts a nivel de página.
  const PAGE_TOAST_HOST_ID = 'gt-toast-host';

  /**
   * Shadow root aislado para toasts de página: no adopta la hoja base en el
   * documento ajeno (evita filtrar `:focus-visible` y `.gt-*` a la página).
   * @param {Document} doc Documento de la página.
   * @returns {ShadowRoot|null} Raíz del host de toasts.
   */
  function pageToastRoot(doc) {
    let host = doc.getElementById(PAGE_TOAST_HOST_ID);
    if (!host) {
      const parent = doc.body || doc.documentElement;
      if (!parent || typeof doc.createElement !== 'function') return null;
      host = doc.createElement('div');
      host.id = PAGE_TOAST_HOST_ID;
      host.attachShadow({ mode: 'open' });
      parent.appendChild(host);
    }
    return host.shadowRoot;
  }

  /**
   * Muestra un toast en la pila `.gt-toast-stack` de `target` (la crea si falta).
   * Con un `Document` se monta en un host propio con Shadow DOM.
   * @param {ShadowRoot|Element|Document} target Contenedor, la propia pila o el documento.
   * @param {{text:string, kind?:string, durationMs?:number, closeLabel?:string}} opts
   *   `kind`: info|success|warning|error ('warn' = warning). `durationMs` 0 = persistente.
   * @returns {{element:HTMLElement, dismiss:Function}|null} Control del toast.
   */
  function toast(target, { text, kind = 'info', durationMs = 5000, closeLabel = 'Dismiss' } = {}) {
    if (target?.nodeType === 9) target = pageToastRoot(target);
    if (!target) return null;
    const doc = target.ownerDocument || root.document;
    if (!doc) return null;
    adopt(styleRootOf(target));
    let stack = target.classList?.contains('gt-toast-stack') ? target : target.querySelector('.gt-toast-stack');
    if (!stack) {
      // Sin aria-live: cada toast ya lleva role=status|alert (evita el doble anuncio).
      stack = el(doc, 'div', 'gt-toast-stack');
      target.appendChild(stack);
    }
    const safeKind = kind === 'warn' ? 'warning' : (Object.prototype.hasOwnProperty.call(TOAST_KINDS, kind) ? kind : 'info');
    const node = el(doc, 'div', `gt-toast gt-toast--${safeKind}`);
    node.setAttribute('role', safeKind === 'error' || safeKind === 'warning' ? 'alert' : 'status');
    const iconWrap = el(doc, 'span', 'gt-toast__icon');
    const svg = iconNode(doc, TOAST_KINDS[safeKind], 14);
    if (svg) iconWrap.appendChild(svg);
    const close = el(doc, 'button', 'gt-toast__close');
    close.type = 'button';
    close.setAttribute('aria-label', closeLabel);
    close.title = closeLabel;
    const closeSvg = iconNode(doc, 'close', 12);
    if (closeSvg) close.appendChild(closeSvg);
    node.append(iconWrap, el(doc, 'span', 'gt-toast__body', text ?? ''), close);
    const ms = Number(durationMs) > 0 ? Number(durationMs) : 0;
    if (ms) {
      const bar = el(doc, 'span', 'gt-toast__progress');
      bar.style.animationDuration = `${ms}ms`;
      node.appendChild(bar);
    }
    let timer = null;
    const dismiss = () => {
      if (node.classList.contains('gt-toast--out')) return;
      clearTimeout(timer);
      node.classList.add('gt-toast--out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
      setTimeout(() => node.remove(), 400);
    };
    close.addEventListener('click', dismiss);
    if (ms) timer = setTimeout(dismiss, ms);
    stack.appendChild(node);
    return { element: node, dismiss };
  }

  /**
   * Diálogo modal de confirmación con trampa de foco y Escape.
   * En el light DOM (documento o elemento) se monta en un host con Shadow DOM.
   * @param {ShadowRoot|Element|Document} target Donde se monta el diálogo.
   * @param {{title:string, body?:string, items?:string[], confirmLabel?:string, cancelLabel?:string, danger?:boolean, signal?:AbortSignal}} opts
   *   `items`: lista opcional (texto plano) en un bloque desplazable.
   *   `signal`: al abortar se cierra resolviendo false.
   * @returns {Promise<boolean>} true si se confirma.
   */
  /**
   * Mantiene Tab / Mayús+Tab dentro de `container` (ciclo entre su primer y último control).
   * @param {KeyboardEvent} e Evento `keydown`.
   * @param {Element} container Contenedor del diálogo.
   * @param {Document|ShadowRoot} [focusRoot] Raíz donde leer `activeElement`.
   * @returns {boolean} `true` si movió el foco.
   */
  function trapTab(e, container, focusRoot) {
    if (e?.key !== 'Tab' || !container) return false;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!items.length) return false;
    const first = items[0];
    const last = items[items.length - 1];
    const active = (focusRoot || container.getRootNode?.())?.activeElement;
    const inside = items.includes(active);
    if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); return true; }
    if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); return true; }
    return false;
  }

  function confirm(target, { title, body = '', items = [], confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, signal = null } = {}) {
    if (target?.nodeType === 9) target = target.body || target.documentElement;
    const doc = target?.ownerDocument || root.document;
    if (!target || !doc || signal?.aborted) return Promise.resolve(false);
    // Light DOM: host propio con Shadow DOM (aísla estilos y el CSS oscuro del IDE).
    let pageHost = null;
    if (target.nodeType === 1 && target.getRootNode?.()?.nodeType === 9 && typeof target.attachShadow === 'function') {
      pageHost = doc.createElement('div');
      pageHost.className = 'gt-dialog-host';
      pageHost.attachShadow({ mode: 'open' });
      target.appendChild(pageHost);
      target = pageHost.shadowRoot;
    }
    adopt(styleRootOf(target));
    const uid = `gt-dlg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const scrim = el(doc, 'div', 'gt-scrim');
    const dialog = el(doc, 'div', 'gt-dialog');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${uid}-t`);
    const heading = el(doc, 'h2', 'gt-dialog__title', title ?? '');
    heading.id = `${uid}-t`;
    dialog.appendChild(heading);
    if (body) {
      const text = el(doc, 'p', 'gt-dialog__body', body);
      text.id = `${uid}-b`;
      dialog.setAttribute('aria-describedby', text.id);
      dialog.appendChild(text);
    }
    if (Array.isArray(items) && items.length) {
      const list = el(doc, 'ul', 'gt-dialog__list');
      for (const item of items) list.appendChild(el(doc, 'li', '', item));
      dialog.appendChild(list);
    }
    const actions = el(doc, 'div', 'gt-dialog__actions');
    const cancelBtn = el(doc, 'button', 'gt-btn gt-btn--text', cancelLabel);
    const okBtn = el(doc, 'button', `gt-btn gt-btn--filled${danger ? ' gt-btn--danger' : ''}`, confirmLabel);
    cancelBtn.type = 'button';
    okBtn.type = 'button';
    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);
    scrim.appendChild(dialog);

    const focusRoot = target.getRootNode?.() || doc;
    const previous = focusRoot.activeElement || doc.activeElement;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        scrim.remove();
        pageHost?.remove();
        if (previous?.isConnected) previous.focus?.();
        resolve(value);
      };
      signal?.addEventListener('abort', () => finish(false), { once: true });
      scrim.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
        trapTab(e, dialog, focusRoot);
      });
      scrim.addEventListener('click', (e) => { if (e.target === scrim) finish(false); });
      cancelBtn.addEventListener('click', () => finish(false));
      okBtn.addEventListener('click', () => finish(true));
      target.appendChild(scrim);
      (danger ? cancelBtn : okBtn).focus();
    });
  }

  /**
   * Posiciona un `.gt-popover` (fixed) junto a su ancla, con flip vertical y flecha.
   * @param {HTMLElement} pop Popover.
   * @param {Element|function(): Element|null} resolveAnchor Ancla o función que la resuelve.
   * @param {{align?:'start'|'center'|'end', gap?:number, placement?:'bottom'|'top', margin?:number}} [opts]
   * @returns {boolean} false si no hay ancla conectada.
   */
  function positionPopover(pop, resolveAnchor, { align = 'start', gap = 8, placement = 'bottom', margin = 8 } = {}) {
    const anchor = typeof resolveAnchor === 'function' ? resolveAnchor() : resolveAnchor;
    if (!pop || !anchor?.isConnected || typeof anchor.getBoundingClientRect !== 'function') return false;
    const view = pop.ownerDocument?.defaultView || root;
    const vw = view.innerWidth;
    const vh = view.innerHeight;
    const a = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    const { width, height } = pop.getBoundingClientRect();

    const below = vh - a.bottom - gap - margin;
    const above = a.top - gap - margin;
    let side = placement === 'top' ? 'top' : 'bottom';
    if (side === 'bottom' && height > below && above > below) side = 'top';
    else if (side === 'top' && height > above && below > above) side = 'bottom';
    const top = side === 'bottom' ? a.bottom + gap : a.top - gap - height;

    let left = align === 'end' ? a.right - width : align === 'center' ? a.left + (a.width - width) / 2 : a.left;
    left = Math.max(margin, Math.min(left, vw - width - margin));
    const arrowX = Math.max(12, Math.min(a.left + a.width / 2 - left, width - 12));

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(Math.max(margin, top))}px`;
    pop.style.setProperty('--gt-arrow-x', `${Math.round(arrowX)}px`);
    pop.dataset.placement = side;
    return true;
  }

  /**
   * Devuelve un ancla utilizable: la actual si sigue en el DOM con tamaño, o
   * la primera visible que coincida con `selector` (la toolbar se reinyecta).
   * @param {Element|null} current Ancla previa.
   * @param {string} selector Selector de respaldo.
   * @returns {Element|null} Ancla visible o null.
   */
  function liveAnchor(current, selector) {
    const usable = (node) => {
      if (!node?.isConnected) return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    };
    if (usable(current)) return current;
    const doc = current?.ownerDocument || root.document;
    for (const node of doc?.querySelectorAll?.(selector) || []) {
      if (usable(node)) return node;
    }
    return null;
  }

  /**
   * Inyecta los tokens `--gt-*` en el documento (una sola vez).
   * @param {Document} doc Documento destino.
   * @returns {boolean} true si los tokens quedan instalados.
   */
  function installTokens(doc) {
    const head = doc?.head || doc?.documentElement;
    if (!head || typeof doc.createElement !== 'function') return false;
    if (doc.getElementById(STYLE_ID)) return true;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = TOKENS_CSS;
    // Al principio: las hojas de la página pueden sobrescribir tokens.
    head.insertBefore(style, head.firstChild);
    return true;
  }

  root.GasUi = Object.freeze({
    STYLE_ID,
    TOKENS_CSS,
    BASE_CSS,
    ICON_NAMES: Object.freeze(Object.keys(ICONS)),
    installTokens,
    adopt,
    icon,
    iconNode,
    toast,
    confirm,
    trapTab,
    positionPopover,
    liveAnchor,
  });
  if (root.document) installTokens(root.document);
})(typeof window !== 'undefined' ? window : undefined);
