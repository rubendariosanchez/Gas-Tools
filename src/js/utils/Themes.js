/**
 * Lista maestra de temas para el editor.
 * Incluye paletas de colores específicas para temas populares y 
 * generación automática para el resto de la librería.
 */
/**
 * Lista maestra de temas para el editor.
 * Cada tema incluye su paleta de colores real (Fondo, Keyword, Texto, String).
 */
export const THEME_LIST = [
  // --- Temas Principales ---
  { protected: true, text: "Monokai", value: "monokai", colors: "#272822,#f92672,#f8f8f2,#e6db74" },
  { protected: true, text: "Dracula", value: "dracula", colors: "#282a36,#ff79c6,#f8f8f2,#f1fa8c" },
  { protected: true, text: "GitHub Light", value: "github", colors: "#ffffff,#0550ae,#24292f,#0a3069" },
  { protected: true, text: "Cobalt", value: "cobalt", colors: "#002240,#ff9d00,#ffffff,#ffee80" },
  { protected: true, text: "Night Owl", value: "night-owl", colors: "#011627,#c792ea,#d6deeb,#ecc48d" },
  { protected: true, text: "Solarized Dark", value: "solarized-dark", colors: "#002b36,#268bd2,#839496,#2aa198" },
  { protected: true, text: "Solarized Light", value: "solarized-light", colors: "#fdf6e3,#268bd2,#657b83,#2aa198" },
  { protected: true, text: "Tomorrow Night", value: "tomorrow-night", colors: "#1d1f21,#b294bb,#c5c8c6,#b5bd68" },

  // --- Temas Adicionales ---
  { protected: true, text: "Active4D", value: "active4d", colors: "#ffffff,#0000ff,#000000,#666666" },
  { protected: true, text: "All Hallows Eve", value: "all-hallows-eve", colors: "#000000,#ccbb44,#ffffff,#663333" },
  { protected: true, text: "Amy", value: "amy", colors: "#200020,#7070ff,#d0d0d0,#008000" },
  { protected: true, text: "Birds of Paradise", value: "birds-of-paradise", colors: "#3b3c32,#ef5d32,#e6e1dc,#6ad81a" },
  { protected: true, text: "Blackboard", value: "blackboard", colors: "#0c1021,#fbde2d,#f8f8f8,#61ce3c" },
  { protected: true, text: "Brilliance Black", value: "brilliance-black", colors: "#0d0d0d,#33ff33,#cccccc,#ff33ff" },
  { protected: true, text: "Brilliance Dull", value: "brilliance-dull", colors: "#050505,#5e5e5e,#a1a1a1,#858585" },
  { protected: true, text: "Chrome DevTools", value: "chrome-devtools", colors: "#ffffff,#881280,#303942,#1a1aa6" },
  { protected: true, text: "Clouds Midnight", value: "clouds-midnight", colors: "#191919,#927c5d,#929292,#5d90cd" },
  { protected: true, text: "Clouds", value: "clouds", colors: "#fbface,#af8a5d,#444444,#5d90cd" },
  { protected: true, text: "Dawn", value: "dawn", colors: "#f9f9f9,#794938,#080808,#0b6125" },
  { protected: true, text: "Dreamweaver", value: "dreamweaver", colors: "#ffffff,#0000ff,#000000,#008000" },
  { protected: true, text: "Eiffel", value: "eiffel", colors: "#ffffff,#0100b6,#000000,#008000" },
  { protected: true, text: "Espresso Libre", value: "espresso-libre", colors: "#2a211c,#43a8ed,#ffffff,#049b0a" },
  { protected: true, text: "Idle", value: "idle", colors: "#ffffff,#0000ff,#000000,#008000" },
  { protected: true, text: "Katzenmilch", value: "katzenmilch", colors: "#e0e0e0,#674917,#0e0e0e,#025f69" },
  { protected: true, text: "Kuroir Theme", value: "kuroir-theme", colors: "#e8e9e8,#24292e,#363636,#cd3228" },
  { protected: true, text: "Lazy", value: "lazy", colors: "#ffffff,#3b5bb5,#000000,#671d91" },
  { protected: true, text: "MagicWB Amiga", value: "magicwb--amiga-", colors: "#969696,#000000,#ffffff,#0000ff" },
  { protected: true, text: "Merbivore Soft", value: "merbivore-soft", colors: "#1c1c1c,#fc6f09,#e6e1dc,#58c554" },
  { protected: true, text: "Merbivore", value: "merbivore", colors: "#161616,#fc6f09,#e6e1dc,#58c554" },
  { protected: true, text: "Monokai Bright", value: "monokai-bright", colors: "#272822,#f92672,#f8f8f2,#e6db74" },
  { protected: true, text: "Oceanic Next", value: "oceanic-next", colors: "#1b2b34,#c594c5,#d8dee9,#99c794" },
  { protected: true, text: "Pastels on Dark", value: "pastels-on-dark", colors: "#211e1e,#72aaca,#dadada,#4ee161" },
  { protected: true, text: "Slush and Poppies", value: "slush-and-poppies", colors: "#f1f1f1,#000000,#444444,#0080a0" },
  { protected: true, text: "Spacecadet", value: "spacecadet", colors: "#0d0d0d,#5f5a60,#dde6cf,#a1a1a1" },
  { protected: true, text: "Sunburst", value: "sunburst", colors: "#000000,#3387cc,#ffffff,#65b042" },
  { protected: true, text: "Textmate Mac Classic", value: "textmate--mac-classic-", colors: "#ffffff,#0000ff,#000000,#036a07" },
  { protected: true, text: "Tomorrow Night Blue", value: "tomorrow-night-blue", colors: "#002451,#bbdaff,#ffffff,#d1f1a9" },
  { protected: true, text: "Tomorrow Night Bright", value: "tomorrow-night-bright", colors: "#000000,#c397d8,#ffffff,#b9ca4a" },
  { protected: true, text: "Tomorrow Night Eighties", value: "tomorrow-night-eighties", colors: "#2d2d2d,#cc99cc,#cccccc,#99cc99" },
  { protected: true, text: "Tomorrow", value: "tomorrow", colors: "#ffffff,#8959a8,#4d4d4c,#718c00" },
  { protected: true, text: "Twilight", value: "twilight", colors: "#141414,#f9ee98,#f8f8f8,#8f9d6a" },
  { protected: true, text: "Upstream Sunburst", value: "upstream-sunburst", colors: "#000000,#3387cc,#ffffff,#65b042" },
  { protected: true, text: "Vibrant Ink", value: "vibrant-ink", colors: "#000000,#ff6600,#ffffff,#44ff11" },
  { protected: true, text: "Xcode Default", value: "xcode-default", colors: "#ffffff,#c41a16,#000000,#1c00cf" },
  { protected: true, text: "Zenburnesque", value: "zenburnesque", colors: "#404040,#dca3a3,#cccccc,#709070" },
  { protected: true, text: "iPlastic", value: "iplastic", colors: "#eeeeee,#0000ff,#000000,#008000" },
  { protected: true, text: "idleFingers", value: "idlefingers", colors: "#323232,#cc7833,#ffffff,#a5c261" },
  { protected: true, text: "krTheme", value: "krtheme", colors: "#0b0a09,#948564,#e6e1dc,#a5c261" },
  { protected: true, text: "MonoIndustrial", value: "monoindustrial", colors: "#222c28,#a39e9b,#ffffff,#648c82" }
];