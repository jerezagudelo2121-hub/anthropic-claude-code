"use strict";

/* Pixelterra: explora un mundo de bloques, fabrica herramientas y captura criaturas.
 * Juego original (criaturas, nombres y gráficos propios), dibujado en un <canvas>.
 * Todo el arte se genera con código; la partida se guarda en el navegador. */

const $ = (s) => document.querySelector(s);
const SAVE_KEY = "pixelterra-v1";
const W = 192, H = 192;                  // tamaño del mundo en casillas
const TS = 16;                           // tamaño de una casilla en píxeles de arte
const DAY_SECONDS = 240;                 // un día completo dura 4 minutos
const STEP_MS = 150;                     // tiempo por paso

/* ---------- Utilidades ---------- */

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = Math.random;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function valueNoise(seed) {
  const r = mulberry32(seed);
  const size = 256, perm = new Float32Array(size * size);
  for (let i = 0; i < perm.length; i++) perm[i] = r();
  const at = (x, y) => perm[((y & 255) << 8) | (x & 255)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return (x, y, scale, octaves = 4) => {
    let v = 0, amp = 1, total = 0, f = 1 / scale;
    for (let o = 0; o < octaves; o++) {
      v += sample(x * f, y * f) * amp;
      total += amp; amp *= 0.5; f *= 2;
    }
    return v / total;
  };
}

/* ---------- Datos del juego ---------- */

const T = { WATER: 0, SAND: 1, GRASS: 2, TALL: 3, TREE: 4, STONE: 5, COAL: 6, IRON: 7, GEM: 8, FLOWER: 9, PLANKS: 10, BRICK: 11, BENCH: 12, FIRE: 13, DIRT: 14, DEEP: 15 };
const WALKABLE = new Set([T.SAND, T.GRASS, T.TALL, T.FLOWER, T.DIRT]);

// Qué se obtiene al romper cada bloque. tool: nivel de pico necesario (0 = a mano).
const MINE = {
  [T.TREE]: { item: "madera", n: 2, hits: 3, tool: 0, leaves: T.GRASS },
  [T.STONE]: { item: "piedra", n: 1, hits: 3, tool: 1, leaves: T.DIRT },
  [T.COAL]: { item: "carbon", n: 1, hits: 3, tool: 1, leaves: T.DIRT },
  [T.IRON]: { item: "hierro", n: 1, hits: 4, tool: 2, leaves: T.DIRT },
  [T.GEM]: { item: "gema", n: 1, hits: 5, tool: 3, leaves: T.DIRT },
  [T.PLANKS]: { item: "tablas", n: 1, hits: 2, tool: 0, leaves: T.DIRT },
  [T.BRICK]: { item: "ladrillo", n: 1, hits: 3, tool: 1, leaves: T.DIRT },
};

const ITEMS = {
  madera: { name: "Madera", desc: "Se consigue talando árboles." },
  tablas: { name: "Tablas", desc: "Bloque de construcción.", place: T.PLANKS },
  palo: { name: "Palo", desc: "Para fabricar herramientas." },
  piedra: { name: "Piedra", desc: "Se puede colocar como bloque.", place: T.STONE },
  carbon: { name: "Carbón", desc: "Combustible para hogueras." },
  hierro: { name: "Hierro", desc: "Para picos y cubos mejores." },
  gema: { name: "Gema", desc: "Rara. Para supercubos." },
  baya: { name: "Baya", desc: "Se encuentra en la hierba y en las flores." },
  pocion: { name: "Poción", desc: "Cura 30 PS a una criatura." },
  cubo: { name: "Cubo", desc: "Para capturar criaturas." },
  supercubo: { name: "Supercubo", desc: "Captura mucho mejor." },
  pico_madera: { name: "Pico de madera", desc: "Permite picar piedra y carbón.", tool: 1 },
  pico_piedra: { name: "Pico de piedra", desc: "Permite picar hierro.", tool: 2 },
  pico_hierro: { name: "Pico de hierro", desc: "Permite picar gemas.", tool: 3 },
  banco: { name: "Banco de trabajo", desc: "Ponlo y fabrica recetas avanzadas a su lado.", place: T.BENCH },
  hoguera: { name: "Hoguera", desc: "Úsala (A) para curar al equipo y fijar tu regreso.", place: T.FIRE },
  ladrillo: { name: "Ladrillo", desc: "Bloque de construcción resistente.", place: T.BRICK },
};

const RECIPES = [
  { out: "tablas", n: 4, need: { madera: 1 } },
  { out: "palo", n: 4, need: { tablas: 2 } },
  { out: "banco", n: 1, need: { tablas: 4 } },
  { out: "pico_madera", n: 1, need: { tablas: 3, palo: 2 } },
  { out: "pocion", n: 1, need: { baya: 2 } },
  { out: "hoguera", n: 1, need: { madera: 2, carbon: 1 } },
  { out: "cubo", n: 3, need: { tablas: 1, piedra: 1 }, bench: true },
  { out: "pico_piedra", n: 1, need: { piedra: 3, palo: 2 }, bench: true },
  { out: "ladrillo", n: 2, need: { piedra: 2 }, bench: true },
  { out: "pico_hierro", n: 1, need: { hierro: 3, palo: 2 }, bench: true },
  { out: "supercubo", n: 2, need: { hierro: 1, gema: 1 }, bench: true },
];

const TYPES = {
  normal: { name: "Normal", color: "#d8d2c2" },
  fuego: { name: "Fuego", color: "#ff8a3d" },
  agua: { name: "Agua", color: "#5ab8ff" },
  planta: { name: "Planta", color: "#7fd36b" },
  electrico: { name: "Eléctrico", color: "#ffe14a" },
  roca: { name: "Roca", color: "#b9a77f" },
};
// Eficacia: ataque → defensa
const EFFECT = {
  fuego: { planta: 2, agua: 0.5, roca: 0.5, fuego: 0.5 },
  agua: { fuego: 2, roca: 2, planta: 0.5, agua: 0.5 },
  planta: { agua: 2, roca: 2, fuego: 0.5, planta: 0.5 },
  electrico: { agua: 2, roca: 0.5, planta: 0.5, electrico: 0.5 },
  roca: { fuego: 2, electrico: 2, planta: 0.5, agua: 0.5 },
  normal: { roca: 0.5 },
};

const MOVES = {
  placaje: { name: "Placaje", type: "normal", pow: 40 },
  aranazo: { name: "Arañazo", type: "normal", pow: 40 },
  picotazo: { name: "Picotazo", type: "normal", pow: 45 },
  destello: { name: "Destello", type: "normal", pow: 55 },
  ascuas: { name: "Ascuas", type: "fuego", pow: 45 },
  llamarada: { name: "Llamarada", type: "fuego", pow: 80 },
  burbuja: { name: "Burbuja", type: "agua", pow: 45 },
  torrente: { name: "Torrente", type: "agua", pow: 80 },
  hoja: { name: "Hoja afilada", type: "planta", pow: 45 },
  raices: { name: "Látigo de raíz", type: "planta", pow: 80 },
  chispa: { name: "Chispa", type: "electrico", pow: 45 },
  trueno: { name: "Trueno", type: "electrico", pow: 80 },
  pedrada: { name: "Pedrada", type: "roca", pow: 45 },
  avalancha: { name: "Avalancha", type: "roca", pow: 80 },
};

/* Criaturas. art: operaciones de dibujo en una rejilla de 24×24 (se perfilan solas).
 *   ["e", cx, cy, rx, ry, color]  elipse      ["r", x, y, w, h, color]  rectángulo
 *   ["t", x1, y1, x2, y2, x3, y3, color]  triángulo   ["o", x, y, color]  ojo (1 píxel) */
const SPECIES = {
  brasito: { name: "Brasito", type: "fuego", base: { hp: 45, atk: 56, def: 42, spd: 55 }, learn: [[1, "placaje"], [1, "ascuas"], [14, "llamarada"]],
    art: [["t", 3, 16, 7, 6, 9, 15, "#ffcc33"], ["e", 4, 8, 2, 3, "#ff5a1f"], ["e", 11, 15, 6, 5, "#ff8a3d"], ["e", 16, 10, 4, 4, "#ff8a3d"], ["e", 11, 17, 3, 2, "#ffd27a"], ["r", 7, 19, 3, 3, "#e0662a"], ["r", 13, 19, 3, 3, "#e0662a"], ["o", 17, 9, "#1b1b1b"], ["r", 18, 11, 2, 1, "#a8361a"]] },
  gotin: { name: "Gotín", type: "agua", base: { hp: 52, atk: 46, def: 52, spd: 45 }, learn: [[1, "placaje"], [1, "burbuja"], [14, "torrente"]],
    art: [["t", 12, 2, 5, 13, 19, 13, "#5ab8ff"], ["e", 12, 15, 7, 6, "#5ab8ff"], ["e", 9, 12, 1, 2, "#d7f1ff"], ["o", 10, 15, "#123"], ["o", 14, 15, "#123"], ["r", 11, 18, 3, 1, "#2a5f99"]] },
  brotin: { name: "Brotín", type: "planta", base: { hp: 50, atk: 48, def: 54, spd: 43 }, learn: [[1, "placaje"], [1, "hoja"], [14, "raices"]],
    art: [["r", 11, 8, 2, 4, "#3fae46"], ["t", 12, 9, 4, 4, 9, 11, "#3fae46"], ["t", 12, 9, 20, 4, 15, 11, "#56c45a"], ["e", 12, 16, 6, 5, "#7fd36b"], ["o", 10, 15, "#132"], ["o", 14, 15, "#132"], ["r", 8, 17, 1, 1, "#ff9aa2"], ["r", 16, 17, 1, 1, "#ff9aa2"]] },
  plumi: { name: "Plumi", type: "normal", base: { hp: 40, atk: 46, def: 36, spd: 70 }, learn: [[1, "picotazo"], [6, "aranazo"]],
    art: [["t", 11, 7, 13, 3, 14, 8, "#e74c3c"], ["e", 12, 14, 6, 6, "#f2efe6"], ["e", 8, 15, 3, 4, "#d8d2c2"], ["t", 17, 12, 21, 13, 17, 14, "#ffb02e"], ["o", 15, 12, "#1b1b1b"], ["r", 10, 20, 1, 2, "#ffb02e"], ["r", 13, 20, 1, 2, "#ffb02e"]] },
  musguito: { name: "Musguito", type: "planta", base: { hp: 44, atk: 42, def: 48, spd: 40 }, learn: [[1, "placaje"], [5, "hoja"], [18, "raices"]],
    art: [["r", 8, 9, 1, 4, "#3b5a24"], ["r", 15, 9, 1, 4, "#3b5a24"], ["e", 12, 16, 8, 5, "#5f8f3a"], ["e", 9, 13, 3, 2, "#8fd16b"], ["e", 15, 13, 3, 2, "#8fd16b"], ["r", 6, 20, 2, 2, "#3b5a24"], ["r", 11, 20, 2, 2, "#3b5a24"], ["r", 16, 20, 2, 2, "#3b5a24"], ["o", 10, 16, "#111"], ["o", 14, 16, "#111"]] },
  chispin: { name: "Chispín", type: "electrico", base: { hp: 38, atk: 52, def: 36, spd: 76 }, learn: [[1, "aranazo"], [3, "chispa"], [16, "trueno"]],
    art: [["t", 5, 13, 8, 6, 10, 13, "#e0a800"], ["t", 9, 11, 12, 3, 15, 11, "#e0a800"], ["t", 14, 12, 18, 6, 19, 13, "#e0a800"], ["e", 12, 15, 7, 5, "#ffe14a"], ["o", 10, 15, "#222"], ["o", 14, 15, "#222"], ["r", 7, 17, 2, 1, "#4aa8ff"], ["r", 16, 17, 2, 1, "#4aa8ff"]] },
  corali: { name: "Corali", type: "agua", base: { hp: 46, atk: 56, def: 62, spd: 32 }, learn: [[1, "aranazo"], [4, "burbuja"], [16, "torrente"]],
    art: [["e", 4, 12, 3, 3, "#ff7b6b"], ["e", 20, 12, 3, 3, "#ff7b6b"], ["r", 9, 9, 1, 4, "#b3443a"], ["r", 14, 9, 1, 4, "#b3443a"], ["e", 12, 16, 7, 4, "#ff7b6b"], ["r", 6, 20, 1, 2, "#b3443a"], ["r", 9, 20, 1, 2, "#b3443a"], ["r", 14, 20, 1, 2, "#b3443a"], ["r", 17, 20, 1, 2, "#b3443a"], ["o", 9, 8, "#111"], ["o", 14, 8, "#111"]] },
  pedron: { name: "Pedrón", type: "roca", base: { hp: 56, atk: 56, def: 72, spd: 22 }, learn: [[1, "placaje"], [4, "pedrada"], [18, "avalancha"]],
    art: [["r", 3, 11, 3, 7, "#8a8a8a"], ["r", 18, 11, 3, 7, "#8a8a8a"], ["r", 6, 8, 12, 13, "#9a9a9a"], ["e", 12, 8, 6, 3, "#a9a9a9"], ["r", 9, 15, 1, 3, "#6e6e6e"], ["r", 14, 17, 2, 1, "#6e6e6e"], ["o", 10, 11, "#5ff2e0"], ["o", 14, 11, "#5ff2e0"]] },
  topin: { name: "Topín", type: "roca", base: { hp: 46, atk: 52, def: 52, spd: 42 }, learn: [[1, "aranazo"], [6, "pedrada"], [20, "avalancha"]],
    art: [["e", 12, 15, 7, 6, "#8b5e3c"], ["e", 12, 17, 2, 1, "#ffb3a1"], ["r", 4, 18, 3, 2, "#e8d6b0"], ["r", 17, 18, 3, 2, "#e8d6b0"], ["e", 12, 10, 4, 1, "#c9a76a"], ["o", 10, 14, "#111"], ["o", 14, 14, "#111"]] },
  cenizo: { name: "Cenizo", type: "fuego", base: { hp: 48, atk: 60, def: 42, spd: 62 }, learn: [[1, "aranazo"], [4, "ascuas"], [16, "llamarada"]],
    art: [["e", 5, 13, 3, 5, "#ff7a2e"], ["e", 4, 9, 2, 2, "#ffd27a"], ["e", 12, 16, 5, 4, "#7a7f8a"], ["t", 10, 9, 11, 3, 13, 8, "#7a7f8a"], ["t", 14, 8, 16, 3, 18, 9, "#7a7f8a"], ["e", 14, 10, 4, 4, "#7a7f8a"], ["e", 16, 12, 2, 1, "#b9bdc6"], ["o", 13, 10, "#ff7a2e"], ["o", 16, 10, "#ff7a2e"]] },
  lumi: { name: "Lumi", type: "normal", base: { hp: 42, atk: 52, def: 42, spd: 66 }, learn: [[1, "destello"], [10, "placaje"]], night: true,
    art: [["e", 12, 12, 8, 8, "#fff3b066"], ["t", 9, 16, 15, 16, 12, 23, "#fff3b0"], ["e", 12, 12, 5, 6, "#fff3b0"], ["o", 10, 11, "#3a2f00"], ["o", 14, 11, "#3a2f00"], ["r", 3, 4, 1, 1, "#ffffff"], ["r", 20, 6, 1, 1, "#ffffff"], ["r", 19, 19, 1, 1, "#ffffff"]] },
  voltibicho: { name: "Voltibicho", type: "electrico", base: { hp: 46, atk: 54, def: 48, spd: 56 }, learn: [[1, "placaje"], [5, "chispa"], [18, "trueno"]], night: true,
    art: [["t", 12, 3, 10, 10, 14, 10, "#ffe14a"], ["e", 12, 15, 7, 5, "#3d4bd9"], ["r", 12, 10, 1, 10, "#1f2a8a"], ["e", 9, 14, 1, 1, "#ffe14a"], ["e", 15, 16, 1, 1, "#ffe14a"], ["r", 6, 19, 2, 2, "#1f2a8a"], ["r", 16, 19, 2, 2, "#1f2a8a"], ["o", 8, 17, "#fff"], ["o", 16, 17, "#fff"]] },
};
const STARTERS = ["brasito", "gotin", "brotin"];

/* ---------- Arte: rejilla de píxeles con perfilado automático ---------- */

function rasterize(ops, size) {
  const g = new Array(size * size).fill(null);
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < size && y < size) g[y * size + x] = c; };
  const sign = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);
  for (const op of ops) {
    const [k] = op;
    if (k === "r") for (let y = op[2]; y < op[2] + op[4]; y++) for (let x = op[1]; x < op[1] + op[3]; x++) set(x, y, op[5]);
    else if (k === "e") {
      const [, cx, cy, rx, ry, c] = op;
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x + 0.5 - cx - 0.5) / (rx + 0.5), dy = (y + 0.5 - cy - 0.5) / (ry + 0.5);
        if (dx * dx + dy * dy <= 1) set(x, y, c);
      }
    } else if (k === "t") {
      const [, x1, y1, x2, y2, x3, y3, c] = op;
      for (let y = Math.min(y1, y2, y3); y <= Math.max(y1, y2, y3); y++) for (let x = Math.min(x1, x2, x3); x <= Math.max(x1, x2, x3); x++) {
        const px = x + 0.5, py = y + 0.5;
        const d1 = sign(px, py, x1, y1, x2, y2), d2 = sign(px, py, x2, y2, x3, y3), d3 = sign(px, py, x3, y3, x1, y1);
        if (!(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)))) set(x, y, c);
      }
    } else if (k === "o") set(op[1], op[2], op[3]);
  }
  return g;
}

function gridToCanvas(g, size, scale, outline) {
  const c = document.createElement("canvas");
  c.width = c.height = size * scale;
  const ctx = c.getContext("2d");
  const filled = (x, y) => x >= 0 && y >= 0 && x < size && y < size && g[y * size + x];
  if (outline) {
    ctx.fillStyle = outline;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!filled(x, y) && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const col = g[y * size + x];
    if (col) { ctx.fillStyle = col; ctx.fillRect(x * scale, y * scale, scale, scale); }
  }
  return c;
}

const monArt = {};
function monCanvas(sp) {
  if (!monArt[sp]) monArt[sp] = gridToCanvas(rasterize(SPECIES[sp].art, 24), 24, 2, "#1a1a1a");
  return monArt[sp];
}

function drawMonInto(canvas, sp) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(monCanvas(sp), 0, 0, canvas.width, canvas.height);
}

/* ---------- Arte: casillas del mundo (16×16) ---------- */

function makeTile(fn, seed) {
  const c = document.createElement("canvas");
  c.width = c.height = TS;
  const ctx = c.getContext("2d");
  const r = mulberry32(seed);
  const px = (x, y, col, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };
  fn(px, r, ctx);
  return c;
}

function speckle(px, r, base, cols, n) {
  px(0, 0, base, TS, TS);
  for (let i = 0; i < n; i++) px(Math.floor(r() * TS), Math.floor(r() * TS), cols[Math.floor(r() * cols.length)]);
}

function stoneBase(px, r) {
  speckle(px, r, "#8c8c8c", ["#7d7d7d", "#9b9b9b", "#848484"], 40);
  px(0, 0, "#a8a8a8", TS, 1); px(0, 0, "#a0a0a0", 1, TS);
  px(0, TS - 1, "#5e5e5e", TS, 1); px(TS - 1, 0, "#666", 1, TS);
  px(0, 7, "#777", TS, 1); px(7, 0, "#777", 1, 7); px(11, 8, "#777", 1, 8);
}

function ore(px, r, col, hi) {
  stoneBase(px, r);
  for (let i = 0; i < 5; i++) {
    const x = 2 + Math.floor(r() * 11), y = 2 + Math.floor(r() * 11);
    px(x, y, col, 2, 2); px(x, y, hi);
  }
}

const TILE_ART = {
  [T.WATER]: [0, 1].map((f) => makeTile((px, r) => {
    speckle(px, r, "#3a8fd6", ["#3585cc", "#4199df"], 20);
    for (let i = 0; i < 3; i++) { const y = 3 + i * 5, x = (f * 4 + i * 5) % 12; px(x, y, "#9fd6ff", 4, 1); }
  }, 11 + f)),
  [T.DEEP]: [0, 1].map((f) => makeTile((px, r) => {
    speckle(px, r, "#2a6fb5", ["#2766ab", "#3078bd"], 20);
    for (let i = 0; i < 2; i++) { const y = 5 + i * 6, x = (f * 5 + i * 7) % 12; px(x, y, "#5aa8e8", 3, 1); }
  }, 21 + f)),
  [T.SAND]: [makeTile((px, r) => speckle(px, r, "#e8d48f", ["#dcc67f", "#f3e2a6", "#d6bf74"], 30), 3)],
  [T.GRASS]: [makeTile((px, r) => speckle(px, r, "#5fae4f", ["#57a248", "#6bbb5a", "#4f9a42"], 34), 4)],
  [T.TALL]: [makeTile((px, r) => {
    speckle(px, r, "#4f9a42", ["#4a9140", "#57a248"], 20);
    for (let i = 0; i < 9; i++) { const x = 1 + ((i * 5) % 14), y = 4 + ((i * 7) % 9); px(x, y, "#2f7a2f", 1, 4); px(x + 1, y + 1, "#7fd06a", 1, 3); }
  }, 5)],
  [T.TREE]: [makeTile((px, r, ctx) => {
    speckle(px, r, "#5fae4f", ["#57a248", "#6bbb5a"], 20);
    px(6, 10, "#6b4426", 4, 6); px(7, 10, "#8a5a32", 1, 6);
    ctx.fillStyle = "#1f5e25"; ctx.beginPath(); ctx.arc(8, 7, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#2f7d32"; ctx.beginPath(); ctx.arc(7, 6, 5.5, 0, Math.PI * 2); ctx.fill();
    px(4, 3, "#4fa34f", 2, 2); px(9, 5, "#4fa34f", 2, 1); px(6, 8, "#4fa34f", 1, 1);
  }, 6)],
  [T.STONE]: [makeTile((px, r) => stoneBase(px, r), 7)],
  [T.COAL]: [makeTile((px, r) => ore(px, r, "#1e1e1e", "#3a3a3a"), 8)],
  [T.IRON]: [makeTile((px, r) => ore(px, r, "#d9a066", "#f0c493"), 9)],
  [T.GEM]: [makeTile((px, r) => ore(px, r, "#2fd8c8", "#c8fff8"), 10)],
  [T.FLOWER]: [makeTile((px, r) => {
    speckle(px, r, "#5fae4f", ["#57a248", "#6bbb5a"], 24);
    for (const [x, y, c] of [[3, 4, "#ff5a6e"], [10, 3, "#ffd23f"], [6, 10, "#ffffff"], [12, 11, "#ff5a6e"]]) { px(x, y + 1, "#2f7a2f", 1, 2); px(x - 1, y, c, 3, 1); px(x, y - 1, c, 1, 3); px(x, y, "#ffef9a"); }
  }, 12)],
  [T.PLANKS]: [makeTile((px) => {
    px(0, 0, "#b8864b", TS, TS);
    for (let y = 0; y < TS; y += 4) { px(0, y, "#8a5f30", TS, 1); px(0, y + 1, "#c99a60", TS, 1); }
    px(5, 1, "#8a5f30", 1, 3); px(11, 5, "#8a5f30", 1, 3); px(3, 9, "#8a5f30", 1, 3); px(9, 13, "#8a5f30", 1, 3);
  }, 13)],
  [T.BRICK]: [makeTile((px) => {
    px(0, 0, "#a65a45", TS, TS);
    for (let y = 0; y < TS; y += 4) { px(0, y, "#d9d0c4", TS, 1); const o = (y / 4) % 2 ? 4 : 0; for (let x = o; x < TS; x += 8) px(x, y, "#d9d0c4", 1, 4); }
  }, 14)],
  [T.BENCH]: [makeTile((px) => {
    px(0, 0, "#8a5f30", TS, TS); px(1, 1, "#c99a60", 14, 6); px(1, 7, "#6b4426", 14, 1);
    px(2, 8, "#6b4426", 2, 7); px(12, 8, "#6b4426", 2, 7); px(4, 3, "#9a9a9a", 4, 1); px(5, 2, "#6b4426", 1, 4); px(10, 2, "#c0c0c0", 3, 2);
  }, 15)],
  [T.FIRE]: [0, 1].map((f) => makeTile((px, r) => {
    speckle(px, r, "#8a6a45", ["#7d5f3d", "#967451"], 20);
    px(3, 12, "#6b4426", 10, 2); px(5, 11, "#8a5a32", 6, 2);
    const h = f ? 9 : 8;
    px(5, 12 - h + 2, "#ff6a1f", 6, h - 1); px(6, 12 - h, "#ffb02e", 4, h - 2); px(7, 12 - h + 2, "#fff1a1", 2, h - 5);
  }, 16 + f)),
  [T.DIRT]: [makeTile((px, r) => speckle(px, r, "#8a6a45", ["#7d5f3d", "#967451", "#a07c55"], 34), 18)],
};

/* ---------- Arte: personaje e iconos ---------- */

function playerFrame(dir, step) {
  // Personaje original: pelo castaño, camiseta verde azulada, pantalón azul.
  const c = document.createElement("canvas");
  c.width = c.height = TS;
  const x = c.getContext("2d");
  const px = (a, b, col, w = 1, h = 1) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
  const skin = "#f1c7a0", hair = "#5a3a22", shirt = "#2bb3a3", pants = "#2f4c9a", shoe = "#3a2a20";
  px(4, 1, hair, 8, 3);                    // pelo
  px(4, 4, skin, 8, 4);                    // cara
  if (dir === "up") px(4, 4, hair, 8, 3);
  else if (dir === "down") { px(6, 5, "#1b1b1b"); px(9, 5, "#1b1b1b"); px(4, 3, hair, 8, 1); }
  else if (dir === "left") { px(5, 5, "#1b1b1b"); px(9, 3, hair, 3, 3); }
  else { px(10, 5, "#1b1b1b"); px(4, 3, hair, 3, 3); }
  px(3, 8, shirt, 10, 4);                  // camiseta
  px(3, 8, "#1f8f83", 1, 4); px(12, 8, "#1f8f83", 1, 4);
  px(2 + (step ? 0 : 0), 9, skin, 1, 3); px(13, 9, skin, 1, 3);
  const l = step === 1 ? 1 : 0, rgt = step === 2 ? 1 : 0;
  px(4, 12, pants, 4, 3 - l); px(8, 12, pants, 4, 3 - rgt);
  px(4, 15 - l, shoe, 4, 1); px(8, 15 - rgt, shoe, 4, 1);
  return c;
}
const PLAYER = {};
for (const d of ["up", "down", "left", "right"]) PLAYER[d] = [0, 1, 2].map((s) => playerFrame(d, s));

const ICON_ART = {
  madera: [["r", 3, 5, 10, 7, "#8a5a32"], ["r", 3, 5, 10, 1, "#a8743f"], ["e", 3, 8, 1, 3, "#c99a60"], ["r", 3, 8, 1, 1, "#8a5a32"]],
  palo: [["t", 3, 13, 12, 3, 13, 4, "#8a5a32"], ["t", 3, 13, 4, 14, 13, 4, "#6b4426"]],
  carbon: [["e", 8, 9, 5, 4, "#2a2a2a"], ["r", 6, 7, 2, 1, "#555"]],
  hierro: [["r", 3, 6, 10, 5, "#d9a066"], ["r", 3, 6, 10, 1, "#f0c493"], ["r", 3, 10, 10, 1, "#a8743f"]],
  gema: [["t", 8, 2, 3, 7, 13, 7, "#5ff2e0"], ["t", 3, 7, 13, 7, 8, 14, "#2fd8c8"], ["r", 6, 5, 2, 1, "#e0fffb"]],
  baya: [["e", 8, 9, 4, 4, "#e23b4e"], ["r", 8, 3, 1, 3, "#2f7a2f"], ["r", 9, 3, 3, 1, "#4fa34f"], ["r", 6, 7, 1, 1, "#ffb3bd"]],
  pocion: [["r", 7, 2, 2, 3, "#d0d0d0"], ["e", 8, 10, 4, 4, "#ff5a8a"], ["r", 6, 7, 1, 1, "#ffd0e0"], ["r", 6, 5, 4, 1, "#a0a0a0"]],
  cubo: [["r", 3, 3, 10, 10, "#e23b3b"], ["r", 3, 8, 10, 5, "#f2f2f2"], ["r", 3, 7, 10, 2, "#2a2a2a"], ["r", 7, 6, 2, 4, "#f2f2f2"]],
  supercubo: [["r", 3, 3, 10, 10, "#3b6be2"], ["r", 3, 8, 10, 5, "#f2f2f2"], ["r", 3, 7, 10, 2, "#2a2a2a"], ["r", 7, 6, 2, 4, "#ffe14a"]],
  pico_madera: [["t", 3, 13, 12, 4, 13, 5, "#8a5a32"], ["t", 4, 3, 14, 6, 13, 3, "#c99a60"]],
  pico_piedra: [["t", 3, 13, 12, 4, 13, 5, "#8a5a32"], ["t", 4, 3, 14, 6, 13, 3, "#9a9a9a"]],
  pico_hierro: [["t", 3, 13, 12, 4, 13, 5, "#8a5a32"], ["t", 4, 3, 14, 6, 13, 3, "#e8e8f0"]],
  hoguera: [["r", 3, 11, 10, 2, "#6b4426"], ["t", 8, 3, 4, 11, 12, 11, "#ff6a1f"], ["t", 8, 6, 6, 11, 10, 11, "#ffd23f"]],
};
const iconCache = {};
function itemIcon(id) {
  if (iconCache[id]) return iconCache[id];
  const it = ITEMS[id];
  let c;
  if (it.place !== undefined) c = TILE_ART[it.place][0];
  else c = gridToCanvas(rasterize(ICON_ART[id] || [["r", 4, 4, 8, 8, "#888"]], 16), 16, 1, "#1a1a1a");
  return (iconCache[id] = c);
}

/* ---------- Mundo ---------- */

let world = null;      // Uint8Array W*H
const idx = (x, y) => y * W + x;
const tileAt = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? T.DEEP : world[idx(x, y)]);
const setTile = (x, y, t) => { if (x >= 0 && y >= 0 && x < W && y < H) world[idx(x, y)] = t; };

function generateWorld(seed) {
  const n1 = valueNoise(seed), n2 = valueNoise(seed + 99), n3 = valueNoise(seed + 777);
  const r = mulberry32(seed + 5);
  const w = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // Isla: los bordes bajan hacia el mar.
    const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
    const edge = Math.max(0, Math.sqrt(dx * dx + dy * dy) - 0.55) * 1.6;
    const e = n1(x, y, 42) - edge;
    const m = n2(x, y, 26);
    const d = n3(x, y, 9);
    let t;
    if (e < 0.26) t = T.DEEP;
    else if (e < 0.33) t = T.WATER;
    else if (e < 0.37) t = T.SAND;
    else if (e > 0.66) {
      // Montaña: roca maciza con minerales y algunos claros con hierba.
      if (d > 0.62) t = r() < 0.6 ? T.TALL : T.DIRT;
      else {
        const v = r();
        const deep = e > 0.74;
        t = v < 0.07 ? T.COAL : v < 0.105 ? T.IRON : deep && v < 0.125 ? T.GEM : T.STONE;
      }
    } else {
      if (m > 0.6 && r() < 0.55) t = T.TREE;
      else if (d > 0.58) t = T.TALL;
      else if (r() < 0.02) t = T.FLOWER;
      else if (r() < 0.012) t = T.TREE;
      else t = T.GRASS;
    }
    w[idx(x, y)] = t;
  }
  return w;
}

function findSpawn() {
  // Casilla de hierba más cercana al centro, con un claro alrededor.
  for (let rad = 0; rad < 90; rad++) {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
      const x = W / 2 + dx, y = H / 2 + dy;
      if (tileAt(x, y) === T.GRASS) {
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
          const t = tileAt(x + i, y + j);
          if (t !== T.WATER && t !== T.DEEP && !WALKABLE.has(t)) setTile(x + i, y + j, T.GRASS);
        }
        return { x, y };
      }
    }
  }
  return { x: W / 2, y: H / 2 };
}

/* ---------- Criaturas ---------- */

function statsOf(mon) {
  const b = SPECIES[mon.sp].base, l = mon.lvl;
  return {
    maxhp: Math.floor((b.hp * 2 * l) / 100) + l + 10,
    atk: Math.floor((b.atk * 2 * l) / 100) + 5,
    def: Math.floor((b.def * 2 * l) / 100) + 5,
    spd: Math.floor((b.spd * 2 * l) / 100) + 5,
  };
}

function movesFor(sp, lvl) {
  const learned = SPECIES[sp].learn.filter(([l]) => l <= lvl).map(([, m]) => m);
  return [...new Set(learned)].slice(-4);
}

function makeMon(sp, lvl) {
  const mon = { sp, lvl, xp: 0, hp: 0, moves: movesFor(sp, lvl) };
  mon.hp = statsOf(mon).maxhp;
  return mon;
}

const xpNeeded = (lvl) => lvl * 12 + 8;

/* ---------- Estado y guardado ---------- */

let S = null; // estado de la partida

function newGame(starter) {
  const seed = Math.floor(Math.random() * 1e9);
  world = generateWorld(seed);
  const spawn = findSpawn();
  S = {
    seed, day: 1, time: 0.25,
    player: { x: spawn.x, y: spawn.y, dir: "down" },
    home: { ...spawn },
    inv: { cubo: 5, pocion: 2 },
    sel: null,
    party: [makeMon(starter, 5)],
    box: [],
    seen: { [starter]: true },
  };
  save();
}

function encodeWorld() {
  let s = "";
  for (let i = 0; i < world.length; i += 4096) s += String.fromCharCode.apply(null, world.subarray(i, i + 4096));
  return btoa(s);
}

function save() {
  if (!S) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...S, world: encodeWorld() }));
  } catch (e) { /* almacenamiento lleno o modo privado */ }
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    const bin = atob(data.world);
    world = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) world[i] = bin.charCodeAt(i);
    delete data.world;
    S = data;
    return world.length === W * H;
  } catch (e) {
    return false;
  }
}

/* ---------- Inventario ---------- */

const count = (id) => S.inv[id] || 0;
function addItem(id, n = 1) { S.inv[id] = count(id) + n; renderHotbar(); }
function takeItem(id, n = 1) {
  S.inv[id] = count(id) - n;
  if (S.inv[id] <= 0) { delete S.inv[id]; if (S.sel === id) S.sel = null; }
  renderHotbar();
}
function toolLevel() {
  return Math.max(0, ...Object.keys(S.inv).map((id) => (ITEMS[id] && ITEMS[id].tool) || 0));
}
function nearBench() {
  const { x, y } = S.player;
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (tileAt(x + i, y + j) === T.BENCH) return true;
  return false;
}

/* ---------- Pantalla y bucle ---------- */

const canvas = $("#world");
const ctx = canvas.getContext("2d");
let scale = 3, viewW = 0, viewH = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  // Unas 10–11 casillas en el lado corto de la pantalla.
  scale = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) / (TS * 10.5)));
  viewW = canvas.width; viewH = canvas.height;
  ctx.imageSmoothingEnabled = false;
}
addEventListener("resize", resize);

const anim = { fromX: 0, fromY: 0, start: 0, moving: false, step: 0 };
const mining = { x: -1, y: -1, hits: 0 };
let lastTime = performance.now();
let paused = true;
let lastSave = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (!paused) {
    S.time += dt / DAY_SECONDS;
    if (S.time >= 1) { S.time -= 1; S.day++; }
    updateMovement(now);
    if (holdA && now - lastA > 230) doAction();
    if (now - lastSave > 10000) { save(); lastSave = now; }
  }
  render(now);
  requestAnimationFrame(loop);
}

const isNight = () => S.time > 0.62 || S.time < 0.05;

function darkness() {
  // 0 de día, ~0.62 en plena noche, con amanecer y anochecer suaves.
  const t = S.time;
  if (t >= 0.05 && t <= 0.55) return 0;
  if (t > 0.55 && t <= 0.68) return ((t - 0.55) / 0.13) * 0.62;
  if (t > 0.68 || t < 0.0) return 0.62;
  return 0.62 * (1 - t / 0.05);
}

function render(now) {
  if (!S) { ctx.fillStyle = "#0b140e"; ctx.fillRect(0, 0, viewW, viewH); return; }
  const size = TS * scale;
  // Posición interpolada del jugador (movimiento suave entre casillas).
  let px = S.player.x, py = S.player.y;
  if (anim.moving) {
    const k = clamp((now - anim.start) / STEP_MS, 0, 1);
    px = anim.fromX + (S.player.x - anim.fromX) * k;
    py = anim.fromY + (S.player.y - anim.fromY) * k;
  }
  const camX = px * size + size / 2 - viewW / 2, camY = py * size + size / 2 - viewH / 2;
  const x0 = Math.floor(camX / size) - 1, y0 = Math.floor(camY / size) - 1;
  const cols = Math.ceil(viewW / size) + 3, rows = Math.ceil(viewH / size) + 3;
  const frame = Math.floor(now / 500) % 2;
  ctx.fillStyle = "#2a6fb5";
  ctx.fillRect(0, 0, viewW, viewH);
  const fires = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const tx = x0 + i, ty = y0 + j, t = tileAt(tx, ty);
    const art = TILE_ART[t];
    const dx = Math.round(tx * size - camX), dy = Math.round(ty * size - camY);
    ctx.drawImage(art[art.length > 1 ? frame : 0], dx, dy, size, size);
    if (t === T.FIRE) fires.push([dx + size / 2, dy + size / 2]);
  }
  // Grietas en el bloque que se está rompiendo.
  if (mining.hits > 0) {
    const dx = Math.round(mining.x * size - camX), dy = Math.round(mining.y * size - camY);
    ctx.fillStyle = "#0008";
    const k = mining.hits;
    ctx.fillRect(dx + size * 0.3, dy + size * 0.2, scale, size * 0.25 * k);
    ctx.fillRect(dx + size * 0.55, dy + size * 0.45, size * 0.18 * k, scale);
    ctx.fillRect(dx + size * 0.2, dy + size * 0.65, size * 0.12 * k, scale);
  }
  // Casilla de delante.
  const f = facing();
  ctx.strokeStyle = "#ffffffaa";
  ctx.lineWidth = Math.max(1, scale / 2);
  ctx.strokeRect(Math.round(f.x * size - camX) + 1, Math.round(f.y * size - camY) + 1, size - 2, size - 2);
  // Jugador.
  const pf = PLAYER[S.player.dir][anim.moving ? 1 + (anim.step % 2) : 0];
  const ppx = Math.round(px * size - camX), ppy = Math.round(py * size - camY);
  const tallUnder = tileAt(S.player.x, S.player.y) === T.TALL && !anim.moving;
  ctx.drawImage(pf, 0, 0, TS, tallUnder ? 11 : TS, ppx, ppy, size, tallUnder ? size * 11 / 16 : size);
  // Noche: oscuridad con luz alrededor del jugador y de las hogueras.
  const dark = darkness();
  if (dark > 0) {
    if (!render.night) render.night = document.createElement("canvas");
    const n = render.night;
    if (n.width !== viewW || n.height !== viewH) { n.width = viewW; n.height = viewH; }
    const c = n.getContext("2d");
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, viewW, viewH);
    c.fillStyle = `rgba(8, 12, 40, ${dark})`;
    c.fillRect(0, 0, viewW, viewH);
    c.globalCompositeOperation = "destination-out";
    const glow = (x, y, rad) => {
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g; c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
    };
    glow(ppx + size / 2, ppy + size / 2, size * 2.6);
    for (const [x, y] of fires) glow(x, y, size * (3.4 + Math.sin(now / 180) * 0.15));
    ctx.drawImage(n, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    for (const [x, y] of fires) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 2.5);
      g.addColorStop(0, "rgba(255,150,40,.25)"); g.addColorStop(1, "rgba(255,150,40,0)");
      ctx.fillStyle = g; ctx.fillRect(x - size * 2.5, y - size * 2.5, size * 5, size * 5);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  // Reloj.
  const label = (isNight() ? "🌙 Noche " : "☀️ Día ") + S.day;
  if (render.label !== label) { $("#clock").textContent = label; render.label = label; }
}

/* ---------- Movimiento ---------- */

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
let heldDir = null;
let turnUntil = 0;

function facing() {
  const [dx, dy] = DIRS[S.player.dir];
  return { x: S.player.x + dx, y: S.player.y + dy };
}

function updateMovement(now) {
  if (anim.moving && now - anim.start >= STEP_MS) {
    anim.moving = false;
    onStep();
  }
  if (anim.moving || !heldDir || modalOpen()) return;
  if (S.player.dir !== heldDir) {
    S.player.dir = heldDir;
    turnUntil = now + 90;   // girar sin moverse si solo tocas un momento
    mining.hits = 0;
    return;
  }
  if (now < turnUntil) return;
  const [dx, dy] = DIRS[heldDir];
  const nx = S.player.x + dx, ny = S.player.y + dy;
  if (!WALKABLE.has(tileAt(nx, ny))) return;
  anim.fromX = S.player.x; anim.fromY = S.player.y;
  anim.start = now; anim.moving = true; anim.step++;
  S.player.x = nx; S.player.y = ny;
  mining.hits = 0;
}

function onStep() {
  const t = tileAt(S.player.x, S.player.y);
  if (t === T.TALL && rand() < 0.11) startWildBattle();
}

/* ---------- Acciones: A (usar) y B (poner) ---------- */

let holdA = false, lastA = 0;

function doAction() {
  lastA = performance.now();
  if (modalOpen()) return;
  const f = facing();
  const t = tileAt(f.x, f.y);
  if (t === T.FIRE) return restAtFire(f);
  if (t === T.BENCH) return openPanel("craft");
  if (t === T.TALL || t === T.FLOWER) {
    setTile(f.x, f.y, T.GRASS);
    if (rand() < (t === T.FLOWER ? 0.6 : 0.25)) { addItem("baya"); toast("+1 Baya"); }
    return;
  }
  const m = MINE[t];
  if (!m) return;
  if (toolLevel() < m.tool) {
    const need = ["", "un pico de madera", "un pico de piedra", "un pico de hierro"][m.tool];
    return toast(`Necesitas ${need}`);
  }
  if (mining.x !== f.x || mining.y !== f.y) { mining.x = f.x; mining.y = f.y; mining.hits = 0; }
  mining.hits++;
  vibrate(8);
  if (mining.hits >= Math.max(1, m.hits - toolLevel())) {
    setTile(f.x, f.y, m.leaves);
    addItem(m.item, m.n);
    toast(`+${m.n} ${ITEMS[m.item].name}`);
    mining.hits = 0;
  }
}

function doPlace() {
  if (modalOpen()) return;
  const id = S.sel;
  if (!id || !count(id)) return toast("Elige arriba un bloque para poner (tablas, piedra, banco…)");
  const f = facing();
  const t = tileAt(f.x, f.y);
  if (!WALKABLE.has(t)) return toast("No se puede poner ahí");
  setTile(f.x, f.y, ITEMS[id].place);
  takeItem(id);
  vibrate(10);
  if (id === "hoguera") toast("Hoguera encendida. Úsala con A para descansar.");
}

function restAtFire(f) {
  for (const mon of S.party) mon.hp = statsOf(mon).maxhp;
  S.home = { x: S.player.x, y: S.player.y };
  save();
  toast("🔥 Tu equipo descansa junto al fuego. ¡Curado! (Partida guardada)");
}

/* ---------- Controles ---------- */

const dpadEl = $("#dpad");
const arms = { up: dpadEl.querySelector(".up"), down: dpadEl.querySelector(".down"), left: dpadEl.querySelector(".left"), right: dpadEl.querySelector(".right") };

function setHeld(dir) {
  if (heldDir === dir) return;
  if (heldDir) arms[heldDir].classList.remove("on");
  heldDir = dir;
  if (dir) arms[dir].classList.add("on");
}

function dirFromPoint(x, y) {
  const r = dpadEl.getBoundingClientRect();
  const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
  if (Math.max(Math.abs(dx), Math.abs(dy)) < r.width * 0.08) return null;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
}

let dpadPointer = null;
dpadEl.addEventListener("pointerdown", (e) => {
  dpadPointer = e.pointerId;
  dpadEl.setPointerCapture(e.pointerId);
  setHeld(dirFromPoint(e.clientX, e.clientY));
});
dpadEl.addEventListener("pointermove", (e) => { if (e.pointerId === dpadPointer) setHeld(dirFromPoint(e.clientX, e.clientY)); });
const dpadUp = (e) => { if (e.pointerId === dpadPointer) { dpadPointer = null; setHeld(null); } };
dpadEl.addEventListener("pointerup", dpadUp);
dpadEl.addEventListener("pointercancel", dpadUp);

function bindButton(el, down, up) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.classList.add("on"); down(); });
  const end = () => { el.classList.remove("on"); if (up) up(); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("pointerleave", end);
}
bindButton($("#btn-a"), () => { holdA = true; doAction(); }, () => (holdA = false));
bindButton($("#btn-b"), () => doPlace());

const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right" };
const keysDown = new Set();
addEventListener("keydown", (e) => {
  if (KEYS[e.code]) { keysDown.add(KEYS[e.code]); setHeld(KEYS[e.code]); e.preventDefault(); }
  else if ((e.code === "KeyZ" || e.code === "Space" || e.code === "Enter") && !e.repeat) { holdA = true; doAction(); }
  else if (e.code === "KeyX" && !e.repeat) doPlace();
});
addEventListener("keyup", (e) => {
  if (KEYS[e.code]) { keysDown.delete(KEYS[e.code]); setHeld([...keysDown].pop() || null); }
  if (e.code === "KeyZ" || e.code === "Space" || e.code === "Enter") holdA = false;
});

function vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }

/* ---------- Interfaz: avisos, barra, paneles ---------- */

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function iconEl(id, size = 30) {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = false;
  x.drawImage(itemIcon(id), 0, 0, 16, 16);
  c.style.width = c.style.height = size + "px";
  return c;
}

function renderHotbar() {
  const bar = $("#hotbar");
  bar.innerHTML = "";
  const placeable = Object.keys(S.inv).filter((id) => ITEMS[id] && ITEMS[id].place !== undefined);
  if (S.sel && !placeable.includes(S.sel)) S.sel = null;
  if (!S.sel && placeable.length) S.sel = placeable[0];
  for (const id of placeable) {
    const b = document.createElement("button");
    b.className = "slot" + (S.sel === id ? " sel" : "");
    b.title = ITEMS[id].name;
    b.append(iconEl(id));
    const n = document.createElement("b");
    n.textContent = count(id);
    b.append(n);
    b.onclick = () => { S.sel = id; renderHotbar(); toast(ITEMS[id].name + " en la mano"); };
    bar.append(b);
  }
  bar.hidden = placeable.length === 0;
}

const modalOpen = () => !$("#panel").hidden || !$("#battle").hidden || !$("#intro").hidden;

let panelKind = null;
function openPanel(kind) {
  if (!$("#battle").hidden) return;
  panelKind = kind;
  setHeld(null);
  $("#panel").hidden = false;
  renderPanel();
}
function closePanel() { $("#panel").hidden = true; panelKind = null; }
$("#panel-close").onclick = closePanel;
$("#panel").addEventListener("pointerdown", (e) => { if (e.target.id === "panel") closePanel(); });
for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => openPanel(b.dataset.open);

function hpBar(hp, max) {
  const p = clamp(hp / max, 0, 1);
  return `<div class="hp"><i class="${p < 0.25 ? "low" : p < 0.5 ? "mid" : ""}" style="width:${p * 100}%"></i></div>`;
}
const typeTag = (t) => `<span class="type" style="background:${TYPES[t].color}">${TYPES[t].name}</span>`;

function monRow(mon, extra) {
  const st = statsOf(mon);
  const row = document.createElement("button");
  row.className = "row-card";
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  drawMonInto(c, mon.sp);
  row.append(c);
  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<b>${SPECIES[mon.sp].name} ${typeTag(SPECIES[mon.sp].type)}</b><small>Nv ${mon.lvl} · PS ${mon.hp}/${st.maxhp}${extra ? " · " + extra : ""}</small>${hpBar(mon.hp, st.maxhp)}`;
  row.append(info);
  return row;
}

function renderPanel() {
  const box = $("#panel-content");
  box.innerHTML = "";
  if (panelKind === "bag") {
    $("#panel-title").textContent = "🎒 Mochila";
    const ids = Object.keys(S.inv);
    if (!ids.length) box.innerHTML = '<p class="hint">Vacía. Tala árboles con A para empezar.</p>';
    const grid = document.createElement("div");
    grid.className = "grid-list";
    for (const id of ids) {
      const it = ITEMS[id];
      const row = document.createElement("button");
      row.className = "row-card" + (S.sel === id ? " sel" : "");
      row.append(iconEl(id, 36));
      const info = document.createElement("div");
      info.className = "info";
      info.innerHTML = `<b>${it.name} ×${count(id)}</b><small>${it.desc}</small>`;
      row.append(info);
      row.onclick = () => {
        if (it.place !== undefined) { S.sel = id; renderHotbar(); closePanel(); toast(it.name + " en la mano. Pulsa B para ponerlo."); }
        else if (id === "pocion") usePotionOutside();
      };
      grid.append(row);
    }
    box.append(grid);
  } else if (panelKind === "craft") {
    $("#panel-title").textContent = "🛠️ Fabricar";
    const bench = nearBench();
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = bench ? "Estás junto a un banco de trabajo: puedes fabricar todo." : "Las recetas con 🪚 necesitan estar junto a un banco de trabajo.";
    box.append(p);
    const grid = document.createElement("div");
    grid.className = "grid-list";
    for (const rec of RECIPES) {
      const can = (!rec.bench || bench) && Object.entries(rec.need).every(([id, n]) => count(id) >= n);
      const row = document.createElement("button");
      row.className = "row-card" + (can ? "" : " disabled");
      row.append(iconEl(rec.out, 36));
      const info = document.createElement("div");
      info.className = "info";
      const need = Object.entries(rec.need).map(([id, n]) => `<span class="${count(id) >= n ? "ok" : "no"}">${n} ${ITEMS[id].name}</span>`).join(" + ");
      info.innerHTML = `<b>${rec.n > 1 ? rec.n + " " : ""}${ITEMS[rec.out].name}${rec.bench ? " 🪚" : ""}</b><div class="recipe-need">${need}</div>`;
      row.append(info);
      row.onclick = () => {
        if (!can) return toast(rec.bench && !bench ? "Necesitas estar junto a un banco de trabajo" : "Te faltan materiales");
        for (const [id, n] of Object.entries(rec.need)) takeItem(id, n);
        addItem(rec.out, rec.n);
        vibrate(15);
        toast(`Fabricado: ${rec.n > 1 ? rec.n + " " : ""}${ITEMS[rec.out].name}`);
        renderPanel();
      };
      grid.append(row);
    }
    box.append(grid);
  } else if (panelKind === "team") {
    $("#panel-title").textContent = "🐾 Equipo";
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Toca una criatura para ponerla la primera (es la que sale a combatir).";
    box.append(p);
    S.party.forEach((mon, i) => {
      const row = monRow(mon, `EXP ${mon.xp}/${xpNeeded(mon.lvl)}`);
      if (i === 0) row.classList.add("sel");
      row.onclick = () => { S.party.splice(i, 1); S.party.unshift(mon); renderPanel(); };
      box.append(row);
    });
    if (S.box.length) {
      const h = document.createElement("h3");
      h.textContent = `📦 Caja (${S.box.length})`;
      box.append(h);
      const p2 = document.createElement("p");
      p2.className = "hint";
      p2.textContent = "Tu equipo tiene hasta 6. Toca una para cambiarla por la última del equipo.";
      box.append(p2);
      S.box.forEach((mon, i) => {
        const row = monRow(mon);
        row.onclick = () => {
          if (S.party.length < 6) S.party.push(S.box.splice(i, 1)[0]);
          else { const out = S.party.pop(); S.party.push(S.box.splice(i, 1)[0]); S.box.push(out); }
          renderPanel();
        };
        box.append(row);
      });
    }
    const seen = Object.keys(S.seen || {}).length;
    const foot = document.createElement("p");
    foot.className = "hint";
    foot.textContent = `Criaturas descubiertas: ${seen} de ${Object.keys(SPECIES).length}`;
    box.append(foot);
  }
}

function usePotionOutside() {
  const mon = S.party.find((m) => m.hp < statsOf(m).maxhp);
  if (!mon) return toast("Tu equipo está bien de salud");
  mon.hp = Math.min(statsOf(mon).maxhp, mon.hp + 30);
  takeItem("pocion");
  toast(`${SPECIES[mon.sp].name} recupera salud`);
  renderPanel();
}

/* ---------- Combate ---------- */

const B = { foe: null, busy: false, ballEl: null };

function wildPool() {
  const { x, y } = S.player;
  let water = false, rock = false;
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
    const t = tileAt(x + i, y + j);
    if (t === T.WATER || t === T.SAND) water = true;
    if (t === T.STONE || t === T.COAL || t === T.IRON || t === T.DIRT) rock = true;
  }
  let pool = rock ? ["pedron", "topin", "cenizo", "brasito", "topin"]
    : water ? ["gotin", "corali", "plumi", "corali"]
      : ["brotin", "musguito", "plumi", "chispin", "musguito", "plumi"];
  if (isNight()) pool = pool.concat(["lumi", "voltibicho", "lumi"]);
  return pool;
}

function startWildBattle() {
  if (!leader()) return;
  const dist = Math.hypot(S.player.x - W / 2, S.player.y - H / 2);
  const lvl = clamp(Math.round(2 + dist / 11 + (rand() * 2 - 1) + (isNight() ? 2 : 0)), 2, 45);
  const foe = makeMon(pick(wildPool()), lvl);
  S.seen = S.seen || {};
  S.seen[foe.sp] = true;
  setHeld(null);
  holdA = false;
  battle(foe);
}

function leader() { return S.party.find((m) => m.hp > 0); }

function renderCards() {
  const foe = B.foe, ally = B.ally;
  const fs = statsOf(foe), as = statsOf(ally);
  $("#foe-card").innerHTML = `${SPECIES[foe.sp].name} ${typeTag(SPECIES[foe.sp].type)} <small>Nv ${foe.lvl}</small>${hpBar(foe.hp, fs.maxhp)}`;
  $("#ally-card").innerHTML = `${SPECIES[ally.sp].name} ${typeTag(SPECIES[ally.sp].type)} <small>Nv ${ally.lvl}</small>${hpBar(ally.hp, as.maxhp)}<small>PS ${ally.hp}/${as.maxhp}</small>`;
}

async function say(msg, ms = 1100) {
  $("#battle-msg").textContent = msg;
  await sleep(ms);
}

function menu(buttons) {
  const m = $("#battle-menu");
  m.innerHTML = "";
  for (const [label, fn, sub, disabled] of buttons) {
    const b = document.createElement("button");
    b.className = "bbtn";
    b.innerHTML = label + (sub ? `<small>${sub}</small>` : "");
    b.disabled = !!disabled;
    b.onclick = () => { if (!B.busy) fn(); };
    m.append(b);
  }
}

async function battle(foe) {
  B.foe = foe;
  B.ally = leader();
  $("#battle").hidden = false;
  $("#battle").classList.toggle("night", isNight());
  drawMonInto($("#foe-sprite"), foe.sp);
  drawMonInto($("#ally-sprite"), B.ally.sp);
  $("#foe-sprite").className = "mon";
  renderCards();
  menu([]);
  vibrate(30);
  await say(`¡Un ${SPECIES[foe.sp].name} salvaje aparece!`);
  await say(`¡Adelante, ${SPECIES[B.ally.sp].name}!`, 700);
  mainMenu();
}

function mainMenu() {
  $("#battle-msg").textContent = `¿Qué hará ${SPECIES[B.ally.sp].name}?`;
  menu([
    ["⚔️ Luchar", fightMenu],
    ["🧊 Cubo", () => throwCube("cubo"), `Tienes ${count("cubo")}`, !count("cubo")],
    ...(count("supercubo") ? [["💠 Supercubo", () => throwCube("supercubo"), `Tienes ${count("supercubo")}`]] : []),
    ["🧪 Poción", usePotionBattle, `Tienes ${count("pocion")}`, !count("pocion")],
    ["🐾 Cambiar", switchMenu, "", S.party.filter((m) => m.hp > 0).length < 2],
    ["🏃 Huir", runAway],
  ]);
}

function fightMenu() {
  const ally = B.ally;
  menu([
    ...ally.moves.map((id) => {
      const mv = MOVES[id];
      return [mv.name, () => turn({ kind: "move", id }), `${TYPES[mv.type].name} · Poder ${mv.pow}`];
    }),
    ["↩️ Atrás", mainMenu],
  ]);
}

function switchMenu() {
  menu([
    ...S.party.filter((m) => m !== B.ally && m.hp > 0).map((m) => [`${SPECIES[m.sp].name} Nv ${m.lvl}`, () => turn({ kind: "switch", mon: m }), `PS ${m.hp}/${statsOf(m).maxhp}`]),
    ["↩️ Atrás", mainMenu],
  ]);
}

function damage(att, def, moveId) {
  const mv = MOVES[moveId];
  const as = statsOf(att), ds = statsOf(def);
  const stab = SPECIES[att.sp].type === mv.type ? 1.3 : 1;
  const eff = (EFFECT[mv.type] && EFFECT[mv.type][SPECIES[def.sp].type]) || 1;
  const crit = rand() < 0.06 ? 1.5 : 1;
  const base = (((2 * att.lvl) / 5 + 2) * mv.pow * (as.atk / ds.def)) / 50 + 2;
  return { dmg: Math.max(1, Math.floor(base * stab * eff * crit * (0.85 + rand() * 0.15))), eff, crit };
}

async function attack(att, def, moveId, defEl) {
  const mv = MOVES[moveId];
  await say(`¡${SPECIES[att.sp].name} usa ${mv.name}!`, 700);
  const { dmg, eff, crit } = damage(att, def, moveId);
  def.hp = Math.max(0, def.hp - dmg);
  defEl.classList.remove("hit"); void defEl.offsetWidth; defEl.classList.add("hit");
  vibrate(20);
  renderCards();
  if (crit > 1) await say("¡Un golpe crítico!", 700);
  if (eff > 1) await say("¡Es muy eficaz!", 800);
  else if (eff < 1) await say("No es muy eficaz…", 800);
  else await sleep(300);
}

function enemyMove() { return pick(B.foe.moves); }

async function turn(action) {
  B.busy = true;
  menu([]);
  const ally = B.ally, foe = B.foe;
  const foeMove = enemyMove();
  if (action.kind === "switch") {
    B.ally = action.mon;
    drawMonInto($("#ally-sprite"), B.ally.sp);
    renderCards();
    await say(`¡Vuelve! ¡Adelante, ${SPECIES[B.ally.sp].name}!`);
    await attack(foe, B.ally, foeMove, $("#ally-sprite"));
  } else if (action.kind === "free") {
    await attack(foe, ally, foeMove, $("#ally-sprite"));
  } else {
    const allyFirst = statsOf(ally).spd >= statsOf(foe).spd;
    const order = allyFirst ? [[ally, foe, action.id, $("#foe-sprite")], [foe, ally, foeMove, $("#ally-sprite")]]
      : [[foe, ally, foeMove, $("#ally-sprite")], [ally, foe, action.id, $("#foe-sprite")]];
    for (const [a, d, m, el] of order) {
      if (a.hp <= 0 || d.hp <= 0) break;
      await attack(a, d, m, el);
    }
  }
  await afterTurn();
}

async function afterTurn() {
  const foe = B.foe;
  if (foe.hp <= 0) {
    await say(`¡${SPECIES[foe.sp].name} salvaje se debilita!`);
    await gainXp(foe);
    return endBattle();
  }
  if (B.ally.hp <= 0) {
    await say(`¡${SPECIES[B.ally.sp].name} se ha debilitado!`);
    const next = leader();
    if (!next) {
      await say("Todo tu equipo está debilitado… Vuelves a tu hoguera.", 1500);
      for (const m of S.party) m.hp = statsOf(m).maxhp;
      S.player.x = S.home.x; S.player.y = S.home.y;
      return endBattle();
    }
    B.ally = next;
    drawMonInto($("#ally-sprite"), next.sp);
    renderCards();
    await say(`¡Adelante, ${SPECIES[next.sp].name}!`);
  }
  B.busy = false;
  mainMenu();
}

async function gainXp(foe) {
  const winners = [B.ally];
  const gain = foe.lvl * 7 + 6;
  for (const mon of winners) {
    mon.xp += gain;
    await say(`${SPECIES[mon.sp].name} gana ${gain} puntos de experiencia.`, 900);
    while (mon.xp >= xpNeeded(mon.lvl)) {
      mon.xp -= xpNeeded(mon.lvl);
      const before = statsOf(mon).maxhp;
      mon.lvl++;
      mon.hp += statsOf(mon).maxhp - before;
      renderCards();
      await say(`¡${SPECIES[mon.sp].name} sube al nivel ${mon.lvl}!`, 1000);
      for (const [l, m] of SPECIES[mon.sp].learn) {
        if (l === mon.lvl && !mon.moves.includes(m)) {
          mon.moves.push(m);
          if (mon.moves.length > 4) mon.moves.shift();
          await say(`¡Ha aprendido ${MOVES[m].name}!`, 1000);
        }
      }
    }
  }
}

async function throwCube(kind) {
  B.busy = true;
  menu([]);
  takeItem(kind);
  const foe = B.foe, st = statsOf(foe);
  await say(`¡Lanzas un ${ITEMS[kind].name}!`, 700);
  const el = $("#foe-sprite");
  const hpFactor = 1 - (2 / 3) * (foe.hp / st.maxhp);
  const chance = clamp(hpFactor * (kind === "supercubo" ? 1.9 : 1.1) * (1 - foe.lvl / 110), 0.05, 0.97);
  const shakes = rand() < chance ? 3 : Math.floor(rand() * 3);
  el.classList.add("caught");
  for (let i = 0; i < shakes; i++) { await say(["Se mueve…", "Se mueve otra vez…", "¡Casi!"][i], 650); vibrate(15); }
  if (shakes === 3) {
    vibrate([30, 60, 30]);
    await say(`¡Has capturado a ${SPECIES[foe.sp].name}!`, 1300);
    const caught = { ...foe, xp: 0 };
    if (S.party.length < 6) S.party.push(caught);
    else { S.box.push(caught); await say("Tu equipo está lleno: se envía a la caja.", 1100); }
    return endBattle();
  }
  el.classList.remove("caught");
  await say("¡Oh, no! Se ha escapado.", 900);
  await turn({ kind: "free" });
}

async function usePotionBattle() {
  B.busy = true;
  menu([]);
  takeItem("pocion");
  const st = statsOf(B.ally);
  B.ally.hp = Math.min(st.maxhp, B.ally.hp + 30);
  renderCards();
  await say(`${SPECIES[B.ally.sp].name} recupera salud.`, 900);
  await turn({ kind: "free" });
}

async function runAway() {
  B.busy = true;
  menu([]);
  const ok = rand() < clamp(0.55 + (statsOf(B.ally).spd - statsOf(B.foe).spd) / 100, 0.3, 0.95);
  if (ok) { await say("¡Escapas sin problemas!", 900); return endBattle(); }
  await say("¡No puedes escapar!", 900);
  await turn({ kind: "free" });
}

function endBattle() {
  B.busy = false;
  $("#battle").hidden = true;
  renderHotbar();
  save();
}

/* ---------- Inicio ---------- */

function showIntro() {
  $("#intro").hidden = false;
  const box = $("#starters");
  box.innerHTML = "";
  for (const sp of STARTERS) {
    const b = document.createElement("button");
    b.className = "starter";
    const c = document.createElement("canvas");
    c.width = c.height = 48;
    drawMonInto(c, sp);
    b.append(c);
    const name = document.createElement("b");
    name.textContent = SPECIES[sp].name;
    b.append(name);
    const t = document.createElement("span");
    t.innerHTML = typeTag(SPECIES[sp].type);
    b.append(t);
    b.onclick = () => {
      newGame(sp);
      $("#intro").hidden = true;
      start();
      toast(`¡${SPECIES[sp].name} se une a tu equipo! Tala un árbol con A para empezar.`, 4000);
    };
    box.append(b);
  }
}

function start() {
  paused = false;
  renderHotbar();
}

addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
addEventListener("pagehide", save);

resize();
if (load()) start();
else showIntro();
requestAnimationFrame(loop);

window.pixelterra = { get state() { return S; }, tileAt, setTile, T, startWildBattle, save }; // para pruebas
