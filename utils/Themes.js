/**
 * Lista maestra de temas para el editor.
 * Incluye paletas de colores específicas para temas populares y 
 * generación automática para el resto de la librería.
 */
export const THEME_LIST = [
  // --- Temas con Paletas de Colores Específicas ---
  { text: "VS Code Dark", value: "vs-dark", colors: "#1e1e1e,#569cd6,#d4d4d4,#ce9178" },
  { text: "Default Light", value: "vs", colors: "#ffffff,#0000ff,#000000,#a31515" },
  { text: "Monokai", value: "monokai", colors: "#272822,#f92672,#a6e22e,#e6db74" },
  { text: "GitHub Light", value: "github", colors: "#ffffff,#0550ae,#24292f,#0a3069" },
  { text: "Cobalt", value: "cobalt", colors: "#002240,#ff9d00,#ffffff,#ffee80" },
  { text: "Night Owl", value: "night-owl", colors: "#011627,#c792ea,#d6deeb,#ecc48d" },
  { text: "Dracula", value: "dracula", colors: "#282a36,#ff79c6,#f8f8f2,#f1fa8c" },
  { text: "Solarized Dark", value: "solarized-dark", colors: "#002b36,#268bd2,#839496,#2aa198" },
  { text: "Solarized Light", value: "solarized-light", colors: "#fdf6e3,#268bd2,#657b83,#2aa198" },
  { text: "Tomorrow Night", value: "tomorrow-night", colors: "#1d1f21,#b294bb,#c5c8c6,#b5bd68" }
].concat([
  // --- Generación Automática del resto de la lista ---
  "active4d", 
  "all-hallows-eve", 
  "amy", 
  "birds-of-paradise", 
  "blackboard", 
  "brilliance-black", 
  "brilliance-dull", 
  "chrome-devtools", 
  "clouds-midnight", 
  "clouds", 
  "dawn", 
  "dreamweaver", 
  "eiffel", 
  "espresso-libre", 
  "idle", 
  "katzenmilch", 
  "kuroir-theme", 
  "lazy", 
  "magicwb--amiga-", 
  "merbivore-soft", 
  "merbivore", 
  "monokai-bright", 
  "oceanic-next", 
  "pastels-on-dark", 
  "slush-and-poppies", 
  "spacecadet", 
  "sunburst", 
  "textmate--mac-classic-", 
  "tomorrow-night-blue", 
  "tomorrow-night-bright", 
  "tomorrow-night-eighties", 
  "tomorrow", 
  "twilight", 
  "upstream-sunburst", 
  "vibrant-ink", 
  "xcode-default", 
  "zenburnesque", 
  "iplastic", 
  "idlefingers", 
  "krtheme", 
  "monoindustrial"
].map(v => ({ 
  // Formatear texto: reemplazar guiones por espacios y capitalizar primera letra
  text: v.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), 
  value: v, 
  // Color gris neutro por defecto para los puntos de la paleta
  colors: "#2d2d2d,#9ca3af,#666666,#444444" 
})));