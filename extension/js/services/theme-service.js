"use strict";

/**
 * @fileoverview Resolución del tema activo para el background.
 * Separado de `llm-providers.js` para mantener una responsabilidad por archivo.
 */

// Importa el nombre de la propiedad global usada como clave en chrome.storage
import { G_PROPERTY_NAME } from '../../../src/js/utils/Variables.js';
// Importa la lista de temas predefinidos (protegidos)
import { THEME_LIST } from '../../../src/js/utils/Themes.js';
// Importa el helper de IndexedDB para temas personalizados
import { DB } from '../../../src/js/utils/Storage.js';

/**
 * Resuelve el tema activo desde chrome.storage y, si es necesario, desde IndexedDB.
 * Si el tema es protegido y no tiene datos incrustados, los descarga como JSON.
 *
 * @async
 * @returns {Promise<Object|null>} Entrada del tema activo, o `null` si no se encuentra o falla.
 */
export async function getActiveTheme() {
  try {
    const result = await new Promise((resolve) =>
      chrome.storage.sync.get([G_PROPERTY_NAME], resolve)
    );

    // Obtiene el ID del tema activo; usa 'vs-dark' si no hay ninguno configurado
    const activeId = result[G_PROPERTY_NAME]?.themes?.active ?? 'vs-dark';

    // Busca primero en los temas protegidos; si no aparece, consulta IndexedDB
    let themeEntry =
      THEME_LIST.find((t) => t.value === activeId) ??
      (await DB.getAll('themes')).find((t) => t.value === activeId);

    if (!themeEntry) return null;

    // Si el tema es protegido pero aún no tiene datos JSON, los descarga
    if (themeEntry.protected && !themeEntry.data) {
      const data = await fetchThemeJson_(themeEntry.text);
      // Copia para no mutar la referencia original de THEME_LIST
      themeEntry = { ...themeEntry, data };
    }

    return themeEntry;
  } catch (err) {
    console.error('[ThemeService] Error al resolver el tema activo:', err);
    return null;
  }
}

/**
 * Descarga el JSON de definición de un tema desde la carpeta `/themes`.
 * Cachea en memoria: el SW puede reiniciarse, pero mientras viva evita
 * re-leer el mismo archivo en cada NOTIFY_UPDATE.
 *
 * @param {string} themeText - Nombre del tema (sin extensión).
 * @returns {Promise<Object|null>}
 */
const G_THEME_JSON_CACHE = new Map();

async function fetchThemeJson_(themeText) {
  if (G_THEME_JSON_CACHE.has(themeText)) return G_THEME_JSON_CACHE.get(themeText);
  const url = chrome.runtime.getURL(`themes/${themeText}.json`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    G_THEME_JSON_CACHE.set(themeText, json);
    return json;
  } catch (err) {
    console.error(`[ThemeService] No se pudo cargar el JSON del tema "${themeText}":`, err);
    return null;
  }
}
