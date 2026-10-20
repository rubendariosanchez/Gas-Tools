/**
 * Estilos base compartidos por option-toggle, option-select y option-color.
 * Consumen los tokens `--gt-*` de extension/js/shared/gas-ui.js (heredan al shadow DOM).
 */
export const OPTION_BASE_CSS = `
  :host {
    display: block;
    padding: var(--gt-space-3, 12px) 0;
    border-bottom: 1px solid var(--gt-outline-variant, #c4c7c5);
    color: var(--gt-on-surface, #1f1f1f);
    font: var(--gt-type-body-m, 400 14px/20px Roboto, Arial, sans-serif);
    transition: background var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease);
  }
  :host([hidden]) { display: none; }
  :host([disabled]) .qc__info { opacity: .38; }
  .qc__row { display: flex; justify-content: space-between; align-items: center; gap: var(--gt-space-4, 16px); min-height: 32px; }
  .qc__info { flex: 1; min-width: 0; transition: opacity var(--gt-motion-duration, 150ms) var(--gt-motion-standard, ease); }
  .qc__title {
    display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px;
    color: var(--gt-on-surface, #1f1f1f);
    font: 500 13px/20px var(--gt-font-plain, Arial, sans-serif);
    cursor: pointer;
  }
  :host([disabled]) .qc__title { cursor: default; }
  .qc__desc {
    margin-top: 2px;
    color: var(--gt-on-surface-variant, #444746);
    font: var(--gt-type-body-s, 400 12px/16px Arial, sans-serif);
  }
  .qc__exp-badge {
    display: inline-flex; align-items: center; gap: 2px;
    height: 18px; padding: 0 var(--gt-space-2, 8px);
    border-radius: var(--gt-shape-full, 9999px);
    background: var(--gt-warning-container, #ffdf99);
    color: var(--gt-on-warning-container, #261a00);
    font: var(--gt-type-label-s, 500 11px/16px Arial, sans-serif);
    font-size: 10px;
    letter-spacing: .02em;
  }
`;
