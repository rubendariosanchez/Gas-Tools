"use strict";

/**
 * @fileoverview Herramientas del modo agente (tool calling) para el chat.
 *
 * Define las herramientas que se ofrecen al modelo y las ejecuta contra el
 * editor (`GasRemoteEditor`). Ninguna herramienta escribe en el proyecto:
 * `propose_edit` y `create_file` solo acumulan cambios en un ChangeSet que
 * el usuario revisa y acepta después (igual que el motor de bloques).
 *
 * Uso:
 *   const exec = GasAgentTools.createExecutor({ editor, editBlocks: GasEditBlocks, lineDiff: GasLineDiff, applier: GasEditApplier });
 *   // exec.definitions → para LLM_CHAT_REQUEST.tools
 *   const { content, step } = await exec.execute({ name, args });
 *   exec.changeSet() → { files: [...] } (mismo formato que el motor de bloques)
 */
const GasAgentTools = (() => {
  const MAX_READ_CHARS = 60000;
  const MAX_SEARCH_RESULTS = 60;

  /** Definiciones (JSON Schema) que se envían al proveedor. */
  const DEFINITIONS = Object.freeze([
    {
      name: 'list_files',
      description: 'List all files of the Apps Script project with their type and line count.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'read_file',
      description: 'Read the full content of a project file. Use the exact path returned by list_files (e.g. "Core/CalcTools.gs").',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path as listed by list_files.' } },
        required: ['path'],
      },
    },
    {
      name: 'search_project',
      description: 'Search all project files for a text (case-insensitive). Returns matching lines as "path:line: text".',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to search for.' } },
        required: ['query'],
      },
    },
    {
      name: 'propose_edit',
      description: 'Propose changes to an existing file as search/replace pairs. "search" must copy existing lines verbatim (including indentation) and be unique; use an empty "replace" to delete. The user reviews and accepts the changes; nothing is written immediately.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: { search: { type: 'string' }, replace: { type: 'string' } },
              required: ['search', 'replace'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
    {
      name: 'create_file',
      description: 'Propose a NEW project file with its full content. Path must end in .gs or .html (e.g. "Utils/Dates.gs"). The user reviews and accepts it.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  ]);

  /**
   * @param {{editor: Object, editBlocks: Object, lineDiff?: Object, applier?: Object}} deps
   *   editor: GasRemoteEditor (listFiles/readFile/getProject); editBlocks: GasEditBlocks;
   *   applier: GasEditApplier (por defecto el global si está cargado).
   */
  function createExecutor({ editor, editBlocks, lineDiff, applier = (typeof GasEditApplier !== 'undefined' ? GasEditApplier : null) }) {
    const fileCache = new Map();         // path → {text, versionId} (una sola lectura por ejecución)
    const changes = new Map();           // path → entrada del ChangeSet
    let fileList = null;

    const listFiles_ = async () => {
      if (!fileList) {
        const res = await editor.listFiles();
        fileList = res?.available ? (res.files || []) : [];
      }
      return fileList;
    };

    const readFile_ = async (path) => {
      if (changes.get(path)?.proposed != null) return changes.get(path).proposed;   // edits encadenados
      if (fileCache.has(path)) return fileCache.get(path).text;
      const res = await editor.readFile(path);
      if (!res?.available || !res.found) return null;
      fileCache.set(path, { text: res.text || '', versionId: res.versionId });
      return res.text || '';
    };

    /** Resuelve hunks: con `applier` se conocen los aplicados y los fuzzy. */
    const resolve_ = (text, hunks) => {
      if (!applier?.resolveHunks) {
        const r = editBlocks.applyHunks(text, hunks);
        const bad = new Set(r.failed.map((f) => f.index));
        return { ...r, ok: hunks.filter((_, i) => !bad.has(i)), fuzzy: 0 };
      }
      const r = applier.resolveHunks(text, hunks);
      const done = new Set(r.edits.map((e) => e.index));
      return {
        proposed: r.proposed,
        applied: r.edits.length,
        failed: r.failed,
        ok: hunks.filter((_, i) => done.has(i)),
        fuzzy: r.edits.filter((e) => e.tier === 'fuzzy').length,
      };
    };

    /** Textos del proyecto en un solo viaje (getProject) o archivo a archivo. */
    const projectTexts_ = async () => {
      if (typeof editor.getProject === 'function') {
        const res = await editor.getProject();
        if (res?.available) {
          return (res.files || []).map((f) => ({ name: f.name, text: changes.get(f.name)?.proposed ?? f.text ?? '' }));
        }
      }
      const out = [];
      for (const f of await listFiles_()) {
        const text = await readFile_(f.name);
        if (text != null) out.push({ name: f.name, text });
      }
      return out;
    };

    const stats_ = (original, proposed) => {
      if (!lineDiff?.diffLines) return { added: 0, removed: 0 };
      return lineDiff.stats(lineDiff.diffLines(original, proposed));
    };

    const handlers = {
      async list_files() {
        const files = await listFiles_();
        if (!files.length) return { content: 'No editor available or the project has no files.', step: { kind: 'list' } };
        return {
          content: files.map((f) => `${f.name} (${f.type}, ${f.lines} lines)`).join('\n'),
          step: { kind: 'list', count: files.length },
        };
      },

      async read_file({ path }) {
        const text = await readFile_(path);
        if (text == null) return { content: `Error: file "${path}" not found. Call list_files to get exact paths.`, step: { kind: 'read', path, error: true } };
        const body = text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…[truncated]` : text;
        return { content: body || '(empty file)', step: { kind: 'read', path } };
      },

      async search_project({ query }) {
        const q = String(query || '').toLowerCase();
        if (!q) return { content: 'Error: empty query.', step: { kind: 'search', query, error: true } };
        const results = [];
        for (const { name, text } of await projectTexts_()) {
          text.split(/\r?\n/).forEach((line, i) => {
            if (results.length < MAX_SEARCH_RESULTS && line.toLowerCase().includes(q)) {
              results.push(`${name}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
        return {
          content: results.length ? results.join('\n') : `No matches for "${query}".`,
          step: { kind: 'search', query, count: results.length },
        };
      },

      async propose_edit({ path, edits }) {
        const original = await readFile_(path);
        if (original == null) return { content: `Error: file "${path}" not found. Use create_file for new files.`, step: { kind: 'edit', path, error: true } };
        const hunks = (Array.isArray(edits) ? edits : []).map((e) => ({ search: String(e?.search ?? ''), replace: String(e?.replace ?? '') }));
        const prev = changes.get(path);
        const base = prev?.original ?? original;
        const { proposed, applied, failed, ok, fuzzy } = resolve_(original, hunks);
        // Solo los hunks aplicados se guardan para el rebase al aceptar
        const batches = [...(prev?.batches || []), ...(ok.length ? [ok] : [])];
        changes.set(path, {
          path, kind: 'edit', original: base, proposed, ...stats_(base, proposed), failed, status: 'pending',
          mode: 'hunks', batches, baseVersionId: prev ? prev.baseVersionId : fileCache.get(path)?.versionId,
          fuzzy: (prev?.fuzzy || 0) + fuzzy,
        });
        const feedback = failed.length && editBlocks.formatFeedback ? `\n${editBlocks.formatFeedback(failed, original)}` : '';
        return {
          content: `Applied ${applied} of ${hunks.length} edits to ${path} (pending user review).${feedback}`,
          step: { kind: 'edit', path, applied, failed: failed.length },
        };
      },

      async create_file({ path, content }) {
        const clean = String(path || '').trim();
        if (!clean) return { content: 'Error: missing path.', step: { kind: 'create', path, error: true } };
        const exists = (await listFiles_()).some((f) => f.name === clean);
        if (exists) return { content: `Error: "${clean}" already exists. Use propose_edit instead.`, step: { kind: 'create', path: clean, error: true } };
        const proposed = String(content ?? '');
        changes.set(clean, { path: clean, kind: 'create', original: '', proposed, ...stats_('', proposed), failed: [], status: 'pending' });
        return { content: `Proposed new file ${clean} (pending user review).`, step: { kind: 'create', path: clean } };
      },
    };

    return {
      definitions: DEFINITIONS,
      /** Ejecuta una llamada del modelo. Nunca lanza: los errores vuelven como texto. */
      async execute({ name, args }) {
        const handler = handlers[name];
        if (!handler) return { content: `Error: unknown tool "${name}".`, step: { kind: 'unknown', name, error: true } };
        try {
          return await handler(args && typeof args === 'object' ? args : {});
        } catch (err) {
          return { content: `Error: ${err?.message || err}`, step: { kind: name, error: true } };
        }
      },
      changeSet() {
        return { files: [...changes.values()] };
      },
    };
  }

  return Object.freeze({ DEFINITIONS, createExecutor });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GasAgentTools };
