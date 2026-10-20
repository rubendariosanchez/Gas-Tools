"use strict";

/**
 * @fileoverview Estilos del Shadow DOM de <gas-github-panel>.
 *
 * Script clásico (no módulo) que corre en el MAIN world y se inyecta justo
 * antes de `gas-github-panel.js`. Expone un único global que `_renderShell_`
 * adopta sobre `GasUi.BASE_CSS` con `GasUi.adopt`. Solo tokens `--gt-*`
 * (heredados del documento) y radios de la escala `--gt-shape-*`.
 */
const GAS_GITHUB_PANEL_STYLES = `
        /* ── Host: popover anclado (GasUi.positionPopover fija left/top) ── */
        :host {
          --gt-arrow-x: calc(100% - 26px);
          display: none;
          position: fixed;
          top: 102px;
          right: 14px;
          z-index: var(--gt-z-panel);
          box-sizing: border-box;
          width: min(760px, calc(100vw - 28px));
          max-height: min(720px, var(--qc-gh-max-h, calc(100vh - 110px)));
          background: var(--gt-surface-bright);
          color: var(--gt-on-surface);
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-l);
          box-shadow: var(--gt-elevation-3);
          font: var(--gt-type-body-m);
          font-size: 13px;
          overflow: visible;
          animation: qc__gh-in var(--gt-motion-duration) var(--gt-motion-standard);
        }
        :host([data-view="unauth"]),
        :host([data-view="loading"]) {
          width: min(420px, calc(100vw - 28px));
          max-height: min(540px, var(--qc-gh-max-h, calc(100vh - 130px)));
        }
        /* Flecha hacia el botón (--gt-arrow-x y data-placement: positionPopover). */
        :host::before {
          content: '';
          position: absolute;
          top: -7px;
          left: var(--gt-arrow-x);
          width: 12px;
          height: 12px;
          background: var(--gt-surface-bright);
          border-left: 1px solid var(--gt-outline-variant);
          border-top: 1px solid var(--gt-outline-variant);
          transform: translateX(-50%) rotate(45deg);
        }
        :host([data-placement="top"])::before {
          top: auto;
          bottom: -7px;
          transform: translateX(-50%) rotate(225deg);
        }
        @keyframes qc__gh-in {
          from { transform: translateY(-6px); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }

        /* Iconos SVG del registro (tamaño = font-size del contexto). */
        .qc__gh-ico {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          font-size: 18px;
          font-style: normal;
          line-height: 1;
        }
        .qc__gh-ico > .gt-icon { width: 1em; height: 1em; }
        .qc__gh-icoOk { color: var(--gt-success); }
        .qc__gh-icoXl { font-size: 32px; }
        .qc__gh-muted { color: var(--gt-on-surface-variant); }

        /* ── Shell y cabecera ── */
        .qc__gh-shell {
          position: relative;
          display: flex;
          flex-direction: column;
          height: 100%;
          max-height: inherit;
          background: var(--gt-surface-bright);
          border-radius: inherit;
          overflow: hidden;
        }
        .qc__gh-header {
          display: flex;
          align-items: center;
          gap: var(--gt-space-3);
          flex: 0 0 auto;
          padding: 14px var(--gt-space-4) var(--gt-space-3);
          border-bottom: 1px solid var(--gt-outline-variant);
        }
        .qc__gh-avatar {
          position: relative;
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          width: 36px;
          height: 36px;
          overflow: hidden;
          border-radius: var(--gt-shape-full);
          background: var(--gt-primary-container);
          color: var(--gt-on-primary-container);
        }
        .qc__gh-avatar img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
          background: var(--gt-primary-container);
        }
        .qc__gh-hdrText { flex: 1; min-width: 0; }
        .qc__gh-hdrTitle,
        .qc__gh-hdrSub {
          overflow: hidden;
          line-height: 1.25;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .qc__gh-hdrTitle { font: var(--gt-type-title-s); color: var(--gt-on-surface); }
        .qc__gh-hdrSub { margin-top: 1px; font-size: 12px; color: var(--gt-on-surface-variant); }

        /* ── Cuerpo y columnas ── */
        .qc__gh-body {
          display: flex;
          flex-direction: column;
          flex: 1;
          gap: 14px;
          min-width: 0;
          min-height: 0;
          padding: 14px var(--gt-space-4);
          overflow: hidden;
        }
        .qc__gh-grid {
          display: grid;
          grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
          align-items: stretch;
          flex: 1;
          gap: var(--gt-space-4);
          min-height: 0;
          overflow: hidden;
        }
        .qc__gh-col {
          display: flex;
          flex-direction: column;
          gap: 10px;
          min-width: 0;
          min-height: 0;
        }
        .qc__gh-colLeft,
        .qc__gh-tabBody,
        .qc__gh-ddList,
        .qc__gh-diffScroll,
        .qc__gh-modalTextWrap,
        .qc__gh-pullList,
        .qc__gh-progressBody,
        .qc__gh-log {
          scrollbar-width: thin;
          scrollbar-color: var(--gt-outline-variant) transparent;
        }
        .qc__gh-colLeft {
          padding-right: 14px;
          border-right: 1px solid var(--gt-outline-variant);
          overflow-x: hidden;
          overflow-y: auto;
        }
        .qc__gh-colRight { gap: var(--gt-space-2); padding-right: 2px; overflow: hidden; }
        .qc__gh-grow { flex: 1; min-height: 0; }
        .qc__gh-commitArea { min-height: 90px; height: 100%; resize: none; }
        .qc__gh-tabs { flex: 0 0 auto; }
        .qc__gh-tabBody { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; }

        /* Pantallas estrechas: una sola columna. */
        @media (max-width: 640px) {
          .qc__gh-body { overflow-y: auto; }
          .qc__gh-grid { flex: none; grid-template-columns: minmax(0, 1fr); overflow: visible; }
          .qc__gh-col { min-height: auto; }
          .qc__gh-colLeft {
            padding: 0 0 var(--gt-space-3);
            border-right: 0;
            border-bottom: 1px solid var(--gt-outline-variant);
            overflow: visible;
          }
          textarea.gt-input.qc__gh-commitArea { height: auto; }
          .qc__gh-colRight { min-height: 240px; overflow: visible; }
        }

        .qc__gh-sectionTitle {
          margin: 0;
          color: var(--gt-on-surface-variant);
          font: var(--gt-type-label-s);
          letter-spacing: 0.6px;
          text-transform: uppercase;
        }
        .qc__gh-sectionHead { display: flex; align-items: center; gap: 6px; }
        .qc__gh-sectionHead .qc__gh-sectionTitle { flex: 1; }
        .qc__gh-sectionActions { display: flex; flex: 0 0 auto; gap: 2px; }

        .qc__gh-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
        .qc__gh-fieldLabel { color: var(--gt-on-surface); font-size: 12px; font-weight: 500; }
        .qc__gh-row { display: flex; align-items: stretch; gap: var(--gt-space-2); }

        /* ── Selectores de repo/branch y dropdown ── */
        .qc__gh-selectorWrap { position: relative; flex: 1; min-width: 0; }
        .qc__gh-selector {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          height: 38px;
          padding: 0 var(--gt-space-3);
          border: 1px solid var(--gt-outline);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
          color: var(--gt-on-surface);
          font: inherit;
          font-size: 13px;
          text-align: left;
          cursor: pointer;
          transition: border-color var(--gt-motion-duration) var(--gt-motion-standard),
            box-shadow var(--gt-motion-duration) var(--gt-motion-standard);
        }
        .qc__gh-selector:hover:not([disabled]) { border-color: var(--gt-on-surface); }
        .qc__gh-selector[aria-expanded="true"] {
          border-color: var(--gt-primary);
          box-shadow: inset 0 0 0 1px var(--gt-primary);
        }
        .qc__gh-selector[disabled] { opacity: .38; cursor: default; }
        .qc__gh-selectorIcon { font-size: 16px; color: var(--gt-on-surface-variant); }
        .qc__gh-selectorLabel {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          font-weight: 500;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .qc__gh-selectorChevron { color: var(--gt-on-surface-variant); }
        .qc__gh-selectorBadge {
          flex: 0 0 auto;
          padding: 2px 6px;
          border-radius: var(--gt-shape-xs);
          background: var(--gt-surface-container-high);
          color: var(--gt-on-surface-variant);
          font-size: 10.5px;
          font-weight: 500;
        }

        .qc__gh-dropdown {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          right: 0;
          z-index: 5;
          overflow: hidden;
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-bright);
          box-shadow: var(--gt-elevation-2);
          animation: gt-fade-in var(--gt-motion-duration) var(--gt-motion-standard);
        }
        /* Sin espacio debajo: se abre hacia arriba (_fitDropdown_). */
        .qc__gh-dropdown.qc__gh-dropUp { top: auto; bottom: calc(100% + 4px); }
        .qc__gh-ddSearch {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          padding: var(--gt-space-2) 10px;
          border-bottom: 1px solid var(--gt-outline-variant);
        }
        .qc__gh-ddSearch .qc__gh-ico { font-size: 16px; color: var(--gt-on-surface-variant); }
        .qc__gh-ddSearch input {
          flex: 1;
          border: none;
          outline: none;
          background: transparent;
          color: inherit;
          font: inherit;
          font-size: 13px;
        }
        .qc__gh-ddSearch input::placeholder { color: var(--gt-on-surface-variant); opacity: 1; }
        .qc__gh-ddList { box-sizing: border-box; max-height: 240px; padding: var(--gt-space-1); overflow-y: auto; }
        .qc__gh-ddItem {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          padding: var(--gt-space-2) 10px;
          border-radius: var(--gt-shape-xs);
          color: var(--gt-on-surface);
          font-size: 13px;
          line-height: 1.2;
          cursor: pointer;
        }
        .qc__gh-ddItem:hover { background: var(--gt-state-hover); }
        .qc__gh-ddItem.qc__gh-active { background: var(--gt-secondary-container); color: var(--gt-on-secondary-container); }
        .qc__gh-ddItem .qc__gh-ico { font-size: 16px; color: var(--gt-on-surface-variant); }
        .qc__gh-ddItemLabel {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .qc__gh-ddItem .qc__gh-ddCheck { color: var(--gt-primary); }
        .qc__gh-ddEmpty { padding: 14px; color: var(--gt-on-surface-variant); font-size: 12px; text-align: center; }
        .qc__gh-ddFooter {
          padding: var(--gt-space-1);
          border-top: 1px solid var(--gt-outline-variant);
          background: var(--gt-surface-container);
        }
        .qc__gh-ddFooterBtn {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          width: 100%;
          padding: var(--gt-space-2) 10px;
          border: none;
          border-radius: var(--gt-shape-xs);
          background: transparent;
          color: var(--gt-primary);
          font: inherit;
          font-size: 12.5px;
          font-weight: 500;
          text-align: left;
          cursor: pointer;
        }
        .qc__gh-ddFooterBtn:hover { background: color-mix(in srgb, var(--gt-primary) 8%, transparent); }
        .qc__gh-ddFooterBtn .qc__gh-ico { font-size: 16px; }

        /* ── Campos y botones (sobre gt-input / gt-btn / gt-icon-btn) ── */
        .gt-input.qc__gh-input { height: 38px; }
        textarea.gt-input.qc__gh-input { height: auto; min-height: 60px; line-height: 1.4; }
        textarea.gt-input.qc__gh-commitArea { height: 100%; min-height: 90px; resize: none; }
        .qc__gh-iconBtn .qc__gh-ico { font-size: 16px; }
        .gt-icon-btn.qc__gh-openExternal { width: 38px; height: 38px; }
        a.gt-icon-btn { text-decoration: none; }
        .qc__gh-btn { height: 36px; }
        .qc__gh-btn .qc__gh-ico { font-size: 16px; }
        .qc__gh-spin .qc__gh-ico { animation: qc__gh-spin 1s linear infinite; }

        /* ── Tabs Changes / Diff ── */
        .qc__gh-tabsRow { display: flex; align-items: center; flex: 0 0 auto; gap: 6px; }
        .qc__gh-tabsRow .qc__gh-tabs { flex: 1; min-width: 0; }
        .qc__gh-tabsRow .qc__gh-iconBtn { width: 38px; height: 38px; }
        .qc__gh-tabs {
          display: grid;
          grid-template-columns: 1fr 1fr;
          padding: var(--gt-space-1);
          border-radius: var(--gt-shape-full);
          background: var(--gt-surface-container);
        }
        .qc__gh-tab {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 32px;
          border: none;
          border-radius: var(--gt-shape-full);
          background: transparent;
          color: var(--gt-on-surface-variant);
          font: inherit;
          font-size: 12.5px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color var(--gt-motion-duration) var(--gt-motion-standard),
            color var(--gt-motion-duration) var(--gt-motion-standard);
        }
        .qc__gh-tab .qc__gh-ico { font-size: 15px; }
        .qc__gh-tab:hover { color: var(--gt-on-surface); }
        .qc__gh-tab.qc__gh-activeTab {
          background: var(--gt-secondary-container);
          color: var(--gt-on-secondary-container);
        }

        /* ── Lista de cambios ── */
        .qc__gh-changesCard {
          overflow: hidden;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-m);
          background: var(--gt-surface-bright);
        }
        .qc__gh-changesHead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--gt-space-2) 10px;
          border-bottom: 1px solid var(--gt-outline-variant);
          background: var(--gt-surface-container);
          color: var(--gt-on-surface-variant);
          font-size: 12px;
        }
        .qc__gh-selectAll {
          display: inline-flex;
          align-items: center;
          gap: var(--gt-space-2);
          padding: 0;
          border: none;
          background: transparent;
          color: var(--gt-on-surface);
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
        .qc__gh-changesList { display: flex; flex-direction: column; min-height: 0; padding: var(--gt-space-1); }
        .qc__gh-changeItem {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          padding: 6px var(--gt-space-2);
          border-radius: var(--gt-shape-xs);
          color: var(--gt-on-surface);
          font-size: 12.5px;
          cursor: pointer;
        }
        .qc__gh-changeItem:hover { background: var(--gt-state-hover); }
        .qc__gh-check {
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          box-sizing: border-box;
          width: 16px;
          height: 16px;
          border: 2px solid var(--gt-on-surface-variant);
          border-radius: var(--gt-shape-xs);
          background: transparent;
          color: var(--gt-on-primary);
        }
        .qc__gh-changeItem.qc__gh-selected .qc__gh-check,
        .qc__gh-selectAll.qc__gh-selected .qc__gh-check {
          border-color: var(--gt-primary);
          background: var(--gt-primary);
        }
        .qc__gh-check .qc__gh-ico { font-size: 12px; opacity: 0; }
        .qc__gh-selected > .qc__gh-check .qc__gh-ico { opacity: 1; }
        .qc__gh-changeStatus,
        .qc__gh-pullStatus {
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          width: 16px;
          height: 16px;
          border-radius: var(--gt-shape-xs);
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
        }
        .qc__gh-changeStatus.add,
        .qc__gh-pullStatus.add { background: var(--gt-success-container); color: var(--gt-on-success-container); }
        .qc__gh-changeStatus.del { background: var(--gt-error-container); color: var(--gt-on-error-container); }
        .qc__gh-changeStatus.mod,
        .qc__gh-pullStatus.mod { background: var(--gt-warning-container); color: var(--gt-on-warning-container); }
        /* Ruta: la carpeta se recorta, el nombre del archivo se ve entero. */
        .qc__gh-changePath,
        .qc__gh-diffCardPath {
          display: flex;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
        }
        .qc__gh-changePathDir {
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          color: var(--gt-on-surface-variant);
          text-overflow: ellipsis;
        }
        .qc__gh-changePathFile {
          flex: 0 0 auto;
          max-width: 100%;
          overflow: hidden;
          color: var(--gt-on-surface);
          font-weight: 600;
          text-overflow: ellipsis;
        }
        .qc__gh-changeItem.qc__gh-unavailable { cursor: default; }
        .qc__gh-changeItem.qc__gh-unavailable .qc__gh-check { visibility: hidden; }
        .qc__gh-changeDelta {
          flex: 0 0 auto;
          font: 600 11px/1.4 var(--gt-font-mono);
          white-space: nowrap;
        }
        .qc__gh-changeDelta .add,
        .qc__gh-pullDelta .add { color: var(--gt-success); }
        .qc__gh-changeDelta .del,
        .qc__gh-pullDelta .del { color: var(--gt-error); }
        .qc__gh-changeItem .qc__gh-diffOrigin { max-width: 40%; }
        .qc__gh-changesCard,
        .qc__gh-diffCard { container-type: inline-size; }
        /* Estrecho: solo el nombre del archivo y el badge como icono (aria-label lo describe). */
        @container (max-width: 380px) {
          .qc__gh-changeItem .qc__gh-changePathDir,
          .qc__gh-diffCardPath .qc__gh-changePathDir { display: none; }
          .qc__gh-originLabel { display: none; }
          .qc__gh-diffOrigin { padding: 2px 4px; }
        }
        .qc__gh-hintCenter { padding: 20px; text-align: center; }
        .qc__gh-emptyText { margin-top: var(--gt-space-2); }
        .qc__gh-changesEmpty { padding: var(--gt-space-5) var(--gt-space-3); color: var(--gt-on-surface-variant); font-size: 12.5px; text-align: center; }

        /* ── Diff ── */
        .qc__gh-diffWrap { display: flex; flex-direction: column; gap: var(--gt-space-2); }
        .qc__gh-baseNotice,
        .qc__gh-diffTooLarge {
          display: flex;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: var(--gt-space-2);
          margin-bottom: var(--gt-space-2);
          padding: var(--gt-space-2) 10px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-container);
          color: var(--gt-on-surface-variant);
          font-size: 11.5px;
          line-height: 1.4;
        }
        .qc__gh-baseNotice span,
        .qc__gh-diffTooLarge span { flex: 1 1 180px; min-width: 0; }
        .qc__gh-diffTooLarge { margin: var(--gt-space-2); background: var(--gt-warning-container); color: var(--gt-on-warning-container); }
        .qc__gh-diffCard {
          overflow: hidden;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-bright);
        }
        .qc__gh-diffCardHead {
          display: flex;
          align-items: center;
          gap: var(--gt-space-1);
          padding-right: var(--gt-space-1);
          border-bottom: 1px solid transparent;
          background: var(--gt-surface-container);
        }
        .qc__gh-diffCardHead:hover { background: var(--gt-surface-container-high); }
        .qc__gh-diffCardOpen .qc__gh-diffCardHead { border-bottom-color: var(--gt-outline-variant); }
        .qc__gh-diffCardToggle {
          display: flex;
          flex: 1 1 auto;
          align-items: center;
          gap: var(--gt-space-2);
          min-width: 0;
          padding: var(--gt-space-2) 10px;
          border: none;
          background: transparent;
          color: var(--gt-on-surface);
          font: inherit;
          font-size: 12.5px;
          text-align: left;
          cursor: pointer;
        }
        .qc__gh-diffCardToggle:focus-visible { outline: 2px solid var(--gt-primary); outline-offset: -2px; }
        .qc__gh-diffViewerBtn { flex: 0 0 auto; width: 30px; height: 30px; }
        .qc__gh-diffCardChevron {
          color: var(--gt-on-surface-variant);
          transition: transform var(--gt-motion-duration) var(--gt-motion-standard);
        }
        .qc__gh-diffCardOpen .qc__gh-diffCardChevron { transform: rotate(90deg); }
        .qc__gh-diffCardPath { font: 500 11.5px/1.4 var(--gt-font-mono); }
        .qc__gh-diffCardBody:empty { display: none; }
        .qc__gh-diffOrigin {
          display: inline-flex;
          align-items: center;
          flex: 0 1 auto;
          gap: 3px;
          min-width: 0;
          overflow: hidden;
          padding: 2px 6px;
          border-radius: var(--gt-shape-xs);
          font: 600 10px/1.2 var(--gt-font-plain);
          white-space: nowrap;
        }
        .qc__gh-originLabel { overflow: hidden; text-overflow: ellipsis; }
        /* GAS = relleno primario; GitHub = contorno: se distinguen sin depender del matiz. */
        .qc__gh-diffOrigin.local { background: var(--gt-primary); color: var(--gt-on-primary); }
        .qc__gh-diffOrigin.remote { background: transparent; box-shadow: inset 0 0 0 1px var(--gt-outline); color: var(--gt-on-surface); }
        .qc__gh-diffOrigin.conflict { background: var(--gt-warning-container); color: var(--gt-on-warning-container); }
        .qc__gh-diffOrigin.unknown { background: var(--gt-surface-container-high); color: var(--gt-on-surface-variant); }
        .qc__gh-diffOrigin.unavailable { background: var(--gt-error-container); color: var(--gt-on-error-container); }
        .qc__gh-diffOrigin .qc__gh-ico { flex: 0 0 auto; font-size: 12px; }
        .qc__gh-diffOrigin .gt-icon { width: 12px; height: 12px; }

        /* Diff compacto: números de GitHub y GAS (fijos al desplazar), signo y código. */
        .qc__gh-diffScroll {
          --qc-gh-num-w: 54px;
          --qc-gh-row-add: color-mix(in srgb, var(--gt-success) 13%, var(--gt-surface-bright));
          --qc-gh-row-del: color-mix(in srgb, var(--gt-error) 13%, var(--gt-surface-bright));
          --qc-gh-word: 32%;
          max-height: min(360px, 50vh);
          overflow: auto;
          overscroll-behavior: contain;
          background: var(--gt-surface-bright);
        }
        :host-context(body.qc__is-dark-mode) .qc__gh-diffScroll { --qc-gh-word: 45%; }
        .qc__gh-diffScroll:focus-visible { outline: 2px solid var(--gt-primary); outline-offset: -2px; }
        .qc__gh-diffTable {
          width: max-content;
          min-width: 100%;
          border-collapse: collapse;
          color: var(--gt-on-surface);
          font: 400 11.5px/1.55 var(--gt-font-mono);
        }
        .qc__gh-diffTable thead th {
          position: sticky;
          top: 0;
          z-index: 2;
          padding: 3px var(--gt-space-2);
          border-bottom: 1px solid var(--gt-outline-variant);
          background: var(--gt-surface-container);
          color: var(--gt-on-surface-variant);
          font: 600 10.5px/1.4 var(--gt-font-plain);
          text-align: left;
          white-space: nowrap;
        }
        .qc__gh-dNum {
          position: sticky;
          left: 0;
          z-index: 1;
          box-sizing: border-box;
          width: var(--qc-gh-num-w);
          min-width: var(--qc-gh-num-w);
          max-width: var(--qc-gh-num-w);
          padding: 0 6px;
          background: var(--gt-surface-bright);
          color: var(--gt-on-surface-variant);
          font-variant-numeric: tabular-nums;
          text-align: right;
          vertical-align: top;
          white-space: nowrap;
          user-select: none;
        }
        .qc__gh-dNum2 { left: var(--qc-gh-num-w); box-shadow: inset -1px 0 0 var(--gt-outline-variant); }
        .qc__gh-diffTable thead .qc__gh-dNum { z-index: 3; overflow: hidden; text-align: right; text-overflow: ellipsis; }
        .qc__gh-dCode { height: 18px; padding: 0 var(--gt-space-2) 0 4px; white-space: pre; }
        .qc__gh-dSign { display: inline-block; width: 1.5ch; color: var(--gt-on-surface-variant); user-select: none; }
        .qc__gh-dAdd td { background: var(--qc-gh-row-add); }
        .qc__gh-dDel td { background: var(--qc-gh-row-del); }
        .qc__gh-dAdd .qc__gh-dNum,
        .qc__gh-dAdd .qc__gh-dSign { color: var(--gt-on-success-container); }
        .qc__gh-dDel .qc__gh-dNum,
        .qc__gh-dDel .qc__gh-dSign { color: var(--gt-on-error-container); }
        .qc__gh-dWordAdd { border-radius: var(--gt-shape-xs); background: color-mix(in srgb, var(--gt-success) var(--qc-gh-word), transparent); }
        .qc__gh-dWordDel { border-radius: var(--gt-shape-xs); background: color-mix(in srgb, var(--gt-error) var(--qc-gh-word), transparent); }
        .qc__gh-dHunk th {
          padding: 2px var(--gt-space-2);
          border-top: 1px solid var(--gt-outline-variant);
          border-bottom: 1px solid var(--gt-outline-variant);
          background: var(--gt-surface-container);
          color: var(--gt-on-surface-variant);
          font: inherit;
          text-align: left;
          white-space: pre;
        }
        .qc__gh-dFold td { padding: 2px var(--gt-space-1); background: var(--gt-surface-container); }
        .qc__gh-dFoldBtn { position: sticky; left: var(--gt-space-1); gap: var(--gt-space-1); min-height: 24px; font-size: 11px; }
        .qc__gh-dFoldBtn:focus-visible { outline: 2px solid var(--gt-primary); outline-offset: -2px; }
        .qc__gh-dFoldBtn .qc__gh-ico { font-size: 13px; }
        .qc__gh-diffEmpty { padding: var(--gt-space-4); color: var(--gt-on-surface-variant); font-size: 12px; text-align: center; }
        .qc__gh-pullReason { flex: 0 0 auto; color: var(--gt-on-surface-variant); font-size: 11px; }
        .qc__gh-pullReason.warn { color: var(--gt-error); font-weight: 600; }
        .qc__gh-diffResolveBtn { flex: 0 0 auto; min-height: 28px; }
        /* Confirmación del pull: una casilla por archivo. */
        #ghPullList .qc__gh-pullItem { flex-wrap: wrap; row-gap: 4px; }
        #ghPullList .qc__gh-pullPath { flex: 1 1 140px; }
        .qc__gh-pullCheck { flex: 0 0 auto; width: 16px; height: 16px; margin: 0; accent-color: var(--gt-primary); }
        .qc__gh-pullItem--off .qc__gh-pullPath { color: var(--gt-on-surface-variant); }
        .qc__gh-pullResolve { flex: 0 0 auto; min-height: 26px; }

        /* ── Footer (push / pull) ── */
        .qc__gh-footer {
          flex: 0 0 auto;
          padding: 10px var(--gt-space-4) 14px;
          border-top: 1px solid var(--gt-outline-variant);
        }
        .qc__gh-footerRow { display: grid; grid-template-columns: 1fr 1.3fr; gap: 10px; }
        .qc__gh-footerRow .qc__gh-btn { height: 40px; }
        .qc__gh-footerHint {
          min-height: 14px;
          margin-top: 6px;
          color: var(--gt-on-surface-variant);
          font-size: 11px;
          text-align: center;
        }
        .qc__gh-pullWarning {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          margin-bottom: var(--gt-space-2);
          padding: var(--gt-space-2) 10px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-warning-container);
          color: var(--gt-on-warning-container);
          font-size: 12px;
        }
        .qc__gh-pullWarning .qc__gh-ico { font-size: 16px; }
        .qc__gh-pullWarning strong { font-weight: 600; }

        /* ── Conexión (Google + GitHub) ── */
        .qc__gh-connectCard {
          padding: 14px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-m);
          background: var(--gt-surface-container);
          text-align: center;
        }
        .qc__gh-connectIcon {
          display: grid;
          place-items: center;
          width: 40px;
          height: 40px;
          margin: 0 auto var(--gt-space-2);
          border-radius: var(--gt-shape-full);
          background: var(--gt-surface-bright);
          color: var(--gt-on-surface);
        }
        .qc__gh-connectIcon .qc__gh-ico { font-size: 22px; }
        .qc__gh-connectTitle { margin-bottom: var(--gt-space-1); font: var(--gt-type-title-s); font-size: 13px; }
        .qc__gh-connectHint { color: var(--gt-on-surface-variant); font-size: 11.5px; line-height: 1.45; }
        .qc__gh-connectHint a { color: var(--gt-primary); text-decoration: none; }
        .qc__gh-connectHint a:hover { text-decoration: underline; }
        .qc__gh-connectStep { display: flex; align-items: flex-start; gap: 10px; padding: var(--gt-space-1) 2px; text-align: left; }
        .qc__gh-connectStepIcon {
          display: grid;
          place-items: center;
          flex: 0 0 auto;
          width: 28px;
          height: 28px;
          margin-top: 2px;
          border-radius: var(--gt-shape-full);
          background: var(--gt-primary-container);
          color: var(--gt-on-primary-container);
        }
        .qc__gh-connectStepBody { flex: 1; min-width: 0; }
        .qc__gh-connectStepTitle { color: var(--gt-on-surface); font: var(--gt-type-title-s); font-size: 13px; }
        .qc__gh-connectStepHint { margin-top: 2px; color: var(--gt-on-surface-variant); font-size: 11.5px; line-height: 1.45; }
        .qc__gh-connectStepActions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--gt-space-2); }
        .qc__gh-stepDisabled .qc__gh-connectStepIcon { background: var(--gt-surface-container-high); color: var(--gt-outline); }
        .qc__gh-stepDisabled .qc__gh-connectStepTitle { color: var(--gt-on-surface-variant); }
        .qc__gh-connectDivider { height: 1px; margin: var(--gt-space-2) 0; background: var(--gt-outline-variant); }
        .qc__gh-codeBox {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          margin-top: 10px;
          padding: var(--gt-space-2) 10px;
          border: 1px dashed var(--gt-primary);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-bright);
        }
        .qc__gh-Code {
          flex: 1;
          color: var(--gt-primary);
          font: 700 18px/1.3 var(--gt-font-mono);
          letter-spacing: 4px;
          text-align: center;
          user-select: all;
        }

        /* ── Carga, skeleton y busy ── */
        .qc__gh-spinner {
          display: inline-block;
          width: 12px;
          height: 12px;
          margin-right: 6px;
          border: 2px solid color-mix(in srgb, var(--gt-primary) 24%, transparent);
          border-top-color: var(--gt-primary);
          border-radius: var(--gt-shape-full);
          vertical-align: -2px;
          animation: qc__gh-spin .9s linear infinite;
        }
        .qc__gh-spinner.qc__gh-spinnerOnDark {
          border-color: color-mix(in srgb, var(--gt-on-primary) 45%, transparent);
          border-top-color: var(--gt-on-primary);
        }
        .qc__gh-spinnerLg { flex: 0 0 auto; width: 22px; height: 22px; margin: 0; border-width: 3px; }
        @keyframes qc__gh-spin { to { transform: rotate(360deg); } }

        .qc__gh-loader { display: flex; flex-direction: column; gap: var(--gt-space-3); padding: var(--gt-space-1) 2px; }
        .qc__gh-loaderRow {
          display: flex;
          align-items: center;
          gap: var(--gt-space-3);
          padding: 10px var(--gt-space-3);
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-m);
          background: var(--gt-surface-container);
        }
        .qc__gh-loaderTitle { color: var(--gt-on-surface); font: var(--gt-type-title-s); font-size: 13px; line-height: 1.25; }
        .qc__gh-loaderSub { margin-top: 2px; color: var(--gt-on-surface-variant); font-size: 11.5px; line-height: 1.3; }
        .qc__gh-skel--rowGroup { display: flex; flex-direction: column; gap: 6px; }
        .qc__gh-skeleton {
          border-radius: var(--gt-shape-s);
          background: linear-gradient(90deg, var(--gt-surface-container-high) 0%, var(--gt-surface-container) 50%, var(--gt-surface-container-high) 100%);
          background-size: 200% 100%;
          animation: qc__gh-shimmer 1.4s ease-in-out infinite;
        }
        .qc__gh-skel--row { height: 38px; margin-bottom: var(--gt-space-2); }
        @keyframes qc__gh-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .qc__gh-busy { position: relative; pointer-events: none; }
        .qc__gh-busy::after {
          content: '';
          position: absolute;
          inset: 0;
          z-index: 4;
          background: var(--gt-scrim);
        }

        .qc__gh-hint { margin: 0; color: var(--gt-on-surface-variant); font-size: 11.5px; }
        .qc__gh-log {
          display: none;
          max-height: 110px;
          overflow: auto;
          padding: var(--gt-space-2) 10px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-container);
          color: var(--gt-on-surface);
          font-size: 11.5px;
          white-space: pre-wrap;
        }
        .qc__gh-log.qc__gh-visible { display: block; }
        .qc__gh-log.qc__gh-error { border-color: transparent; background: var(--gt-error-container); color: var(--gt-on-error-container); }
        .qc__gh-log.qc__gh-ok { border-color: transparent; background: var(--gt-success-container); color: var(--gt-on-success-container); }

        /* ── Toasts (GasUi.toast) anclados al panel ── */
        .gt-toast-stack.qc__gh-toastStack {
          position: absolute;
          top: auto;
          bottom: var(--gt-space-3);
          left: var(--gt-space-3);
          right: var(--gt-space-3);
          z-index: calc(var(--gt-z-modal) + 1);
          padding: 0;
        }

        /* ── Modales (gt-scrim + gt-dialog) ── */
        .qc__gh-modal {
          display: flex;
          flex-direction: column;
          gap: var(--gt-space-3);
          max-height: min(520px, calc(100vh - 160px));
        }
        .qc__gh-modal--wide { width: min(460px, 100%); }
        .qc__gh-modal .gt-dialog__title { margin: 0; }
        .qc__gh-modal .gt-dialog__actions { flex: 0 0 auto; margin-top: var(--gt-space-1); }
        .qc__gh-modalTextWrap { flex: 1; min-height: 0; margin: var(--gt-space-1) 0; padding-right: var(--gt-space-1); overflow-y: auto; }
        .qc__gh-radioRow { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gt-space-2); }
        .qc__gh-radio {
          display: flex;
          align-items: flex-start;
          gap: var(--gt-space-2);
          padding: 10px;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          color: var(--gt-on-surface);
          font-size: 12px;
          cursor: pointer;
        }
        .qc__gh-radio:hover { background: var(--gt-state-hover); }
        .qc__gh-radio input { display: none; }
        .qc__gh-radioCircle {
          position: relative;
          flex: 0 0 auto;
          box-sizing: border-box;
          width: 16px;
          height: 16px;
          margin-top: 1px;
          border: 2px solid var(--gt-on-surface-variant);
          border-radius: var(--gt-shape-full);
        }
        .qc__gh-radio input:checked + .qc__gh-radioCircle { border-color: var(--gt-primary); }
        .qc__gh-radio input:checked + .qc__gh-radioCircle::after {
          content: '';
          position: absolute;
          top: 2px;
          left: 2px;
          width: 8px;
          height: 8px;
          border-radius: var(--gt-shape-full);
          background: var(--gt-primary);
        }
        .qc__gh-radio:has(input:checked) { border-color: var(--gt-primary); background: var(--gt-secondary-container); }
        .qc__gh-radio strong { display: block; font-weight: 600; line-height: 1.3; }
        .qc__gh-radioHint { display: block; margin-top: 2px; color: var(--gt-on-surface-variant); font-size: 11px; }

        /* Modal de pull. */
        .qc__gh-pullSummary {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          padding: var(--gt-space-2) 10px;
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface-container);
          color: var(--gt-on-surface);
          font-size: 12.5px;
        }
        .qc__gh-pullSummary .qc__gh-ico { color: var(--gt-primary); }
        .qc__gh-pullSummaryCount { font-weight: 600; }
        .qc__gh-pullList {
          max-height: 220px;
          margin: var(--gt-space-2) 0;
          overflow-y: auto;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-s);
          background: var(--gt-surface);
        }
        .qc__gh-pullItem {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          padding: 6px 10px;
          border-bottom: 1px solid var(--gt-outline-variant);
          font-size: 12px;
          line-height: 1.3;
        }
        .qc__gh-pullItem:last-child { border-bottom: none; }
        .qc__gh-pullStatus { width: 18px; height: 18px; }
        .qc__gh-pullPath {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          color: var(--gt-on-surface);
          font: 400 11.5px/1.4 var(--gt-font-mono);
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .qc__gh-pullPath.qc__gh-muted { color: var(--gt-on-surface-variant); }
        .qc__gh-pullDelta { flex: 0 0 auto; color: var(--gt-on-surface-variant); font: 400 10.5px/1.4 var(--gt-font-mono); }
        .qc__gh-pullNote {
          margin-top: 10px;
          padding: var(--gt-space-2) 10px;
          border-left: 3px solid var(--gt-primary);
          border-radius: var(--gt-shape-xs);
          background: var(--gt-primary-container);
          color: var(--gt-on-primary-container);
          font-size: 11.5px;
          line-height: 1.45;
        }
        .qc__gh-pullNote--first { margin-top: 0; }
        .qc__gh-pullNote.warn { border-left-color: var(--gt-error); background: var(--gt-error-container); color: var(--gt-on-error-container); }
        .qc__gh-pullNote strong { font-weight: 600; }
        .qc__gh-pullCheckRow {
          display: flex;
          align-items: center;
          gap: var(--gt-space-2);
          margin-top: 10px;
          color: var(--gt-on-surface);
          font-size: 12px;
          cursor: pointer;
          user-select: none;
        }
        .qc__gh-pullCheckRow input { margin: 0; accent-color: var(--gt-primary); cursor: pointer; }

        /* ── Progreso de push / pull ── */
        .qc__gh-progress {
          position: absolute;
          left: var(--gt-space-3);
          right: var(--gt-space-3);
          bottom: var(--gt-space-3);
          z-index: 10;
          overflow: hidden;
          border: 1px solid var(--gt-outline-variant);
          border-radius: var(--gt-shape-m);
          background: var(--gt-surface-bright);
          box-shadow: var(--gt-elevation-2);
          color: var(--gt-on-surface);
          font-size: 12.5px;
          animation: gt-fade-in var(--gt-motion-duration) var(--gt-motion-standard);
        }
        .qc__gh-progressHead {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px var(--gt-space-3);
          cursor: pointer;
          user-select: none;
        }
        .qc__gh-progressHead:hover { background: var(--gt-state-hover); }
        .qc__gh-progressIcon { display: grid; place-items: center; flex: 0 0 auto; width: 18px; height: 18px; color: var(--gt-primary); }
        .qc__gh-progressDone .qc__gh-progressIcon { color: var(--gt-success); }
        .qc__gh-progressError .qc__gh-progressIcon { color: var(--gt-error); }
        .qc__gh-progressIcon .qc__gh-spinner { width: 14px; height: 14px; margin: 0; border-width: 2px; }
        .qc__gh-progressTitle {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          font-weight: 600;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .qc__gh-progressMeta { color: var(--gt-on-surface-variant); font-size: 11.5px; font-weight: 400; }
        .qc__gh-progressActions { display: flex; align-items: center; flex: 0 0 auto; gap: 2px; }
        .qc__gh-progressChevron {
          color: var(--gt-on-surface-variant);
          transition: transform var(--gt-motion-duration) var(--gt-motion-standard);
        }
        .qc__gh-progressOpen .qc__gh-progressChevron { transform: rotate(180deg); }
        .qc__gh-progressBody {
          display: none;
          max-height: 220px;
          overflow-y: auto;
          padding: var(--gt-space-2) var(--gt-space-1);
          border-top: 1px solid var(--gt-outline-variant);
        }
        .qc__gh-progressOpen .qc__gh-progressBody { display: block; }
        .qc__gh-progressPhase { display: flex; align-items: flex-start; gap: var(--gt-space-2); padding: 6px 10px; border-radius: var(--gt-shape-xs); }
        .qc__gh-progressPhase + .qc__gh-progressPhase { margin-top: 2px; }
        .qc__gh-progressPhaseIcon { display: grid; place-items: center; flex: 0 0 auto; width: 18px; height: 18px; margin-top: 1px; }
        .qc__gh-progressPhaseIcon .qc__gh-ico { font-size: 16px; }
        .qc__gh-progressPhase.pending .qc__gh-progressPhaseIcon { color: var(--gt-outline); }
        .qc__gh-progressPhase.active .qc__gh-progressPhaseIcon { color: var(--gt-primary); }
        .qc__gh-progressPhase.done .qc__gh-progressPhaseIcon { color: var(--gt-success); }
        .qc__gh-progressPhase.error .qc__gh-progressPhaseIcon { color: var(--gt-error); }
        .qc__gh-progressPhaseText { flex: 1; min-width: 0; line-height: 1.35; }
        .qc__gh-progressPhaseLabel { color: var(--gt-on-surface); font-weight: 500; }
        .qc__gh-progressPhaseHint { color: var(--gt-on-surface-variant); font-size: 11.5px; }
        .qc__gh-progressPhase.pending .qc__gh-progressPhaseLabel,
        .qc__gh-progressPhase.pending .qc__gh-progressPhaseHint { color: var(--gt-on-surface-variant); }
        .qc__gh-progressFiles {
          margin-top: var(--gt-space-1);
          padding-left: 0;
          list-style: none;
          counter-reset: qc-gh-file;
          color: var(--gt-on-surface-variant);
          font: 400 11px/1.5 var(--gt-font-mono);
        }
        .qc__gh-progressFiles li {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 1px 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          counter-increment: qc-gh-file;
        }
        .qc__gh-progressFiles li::before {
          content: counter(qc-gh-file) ".";
          display: inline-block;
          flex: 0 0 auto;
          min-width: 2.5ch;
          color: var(--gt-on-surface-variant);
          font-variant-numeric: tabular-nums;
          text-align: right;
        }
        .qc__gh-progressFiles li .qc__gh-ico { font-size: 12px; }
        .qc__gh-progressFiles li.qc__gh-progressFile-done { color: var(--gt-on-surface); }
        .qc__gh-progressFiles li.qc__gh-progressFile-done .qc__gh-ico { color: var(--gt-success); }
        .qc__gh-progressFiles li.qc__gh-progressFile-error .qc__gh-ico { color: var(--gt-error); }

        @media (prefers-reduced-motion: reduce) {
          :host, .qc__gh-dropdown, .qc__gh-progress { animation: none; }
          .qc__gh-spinner, .qc__gh-skeleton, .qc__gh-spin .qc__gh-ico { animation-duration: 3s; }
        }`;
