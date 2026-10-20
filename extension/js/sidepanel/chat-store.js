"use strict";

/**
 * @fileoverview Historial de conversaciones del chat, por proyecto.
 *
 * Se guarda en `chrome.storage.local` con la clave `gasToolsChats:<scriptId>`:
 *   [{ id, title, updatedAt, messages }]  (más reciente primero)
 * Límites: MAX_CONVERSATIONS por proyecto y un tope de tamaño total; los
 * textos grandes (contexto expandido, contenidos de archivos de un
 * ChangeSet) se recortan para no inflar el storage.
 */
class GasChatStore {
  static KEY_PREFIX = 'gasToolsChats:';
  static MAX_CONVERSATIONS = 30;
  static MAX_MESSAGE_CHARS = 40000;
  static MAX_EXPANDED_CHARS = 20000;
  static MAX_TOTAL_CHARS = 2_000_000;

  /**
   * @param {{get:Function, set:Function}} [storage] `chrome.storage.local` (inyectable para tests).
   */
  constructor(storage = (typeof chrome !== 'undefined' ? chrome.storage?.local : null)) {
    this._storage = storage;
  }

  _key_(scriptId) {
    return `${GasChatStore.KEY_PREFIX}${scriptId || 'default'}`;
  }

  /** @returns {Promise<Array>} conversaciones del proyecto (más reciente primero). */
  async list(scriptId) {
    if (!this._storage) return [];
    try {
      const key = this._key_(scriptId);
      const r = await this._storage.get([key]);
      return Array.isArray(r?.[key]) ? r[key] : [];
    } catch (_) {
      return [];
    }
  }

  async get(scriptId, id) {
    return (await this.list(scriptId)).find((c) => c.id === id) || null;
  }

  /**
   * Crea o actualiza una conversación. Las conversaciones vacías no se guardan.
   * @param {string} scriptId
   * @param {{id?:string, title?:string, messages:Array}} conversation
   * @returns {Promise<Object|null>} La conversación guardada (con id).
   */
  async save(scriptId, conversation) {
    const messages = (conversation?.messages || []).map((m) => GasChatStore.trimMessage(m)).filter(Boolean);
    if (!messages.some((m) => m.role === 'user')) return null;

    const entry = {
      id: conversation.id || GasChatStore.newId(),
      title: conversation.title || GasChatStore.titleFrom(messages),
      updatedAt: Date.now(),
      messages,
    };

    const list = (await this.list(scriptId)).filter((c) => c.id !== entry.id);
    list.unshift(entry);
    let next = list.slice(0, GasChatStore.MAX_CONVERSATIONS);
    while (next.length > 1 && JSON.stringify(next).length > GasChatStore.MAX_TOTAL_CHARS) next = next.slice(0, -1);

    await this._storage?.set({ [this._key_(scriptId)]: next });
    return entry;
  }

  async remove(scriptId, id) {
    const list = (await this.list(scriptId)).filter((c) => c.id !== id);
    await this._storage?.set({ [this._key_(scriptId)]: list });
  }

  static newId() {
    return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Título = primer mensaje del usuario, sin etiquetas @ y en una línea. */
  static titleFrom(messages) {
    const first = (messages || []).find((m) => m.role === 'user')?.content || '';
    const text = String(first).replace(/@(selection|file|project)\b/g, '').replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 57)}…` : (text || 'New chat');
  }

  /** Copia del mensaje apta para persistir (recorta textos grandes). */
  static trimMessage(msg) {
    if (!msg || typeof msg !== 'object' || !msg.role) return null;
    const cut = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s);
    const out = { ...msg, content: cut(msg.content ?? '', GasChatStore.MAX_MESSAGE_CHARS) };
    if (out._expanded) {
      out._expanded = out._expanded.length > GasChatStore.MAX_EXPANDED_CHARS ? undefined : out._expanded;
    }
    if (out._changes?.files) {
      // El original/propuesto completo (ni los hunks) no hace falta para releer el historial;
      // se conservan ruta, tipo, estado y estadísticas.
      out._changes = {
        ...out._changes,
        files: out._changes.files.map(({ original: _o, proposed: _p, batches: _b, ...rest }) => ({ ...rest, stale: true })),
      };
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { GasChatStore };
