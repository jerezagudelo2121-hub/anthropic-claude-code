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

/* ---------- Sonido: efectos y música sintetizados (WebAudio, sin archivos) ---------- */

const snd = {
  ctx: null, master: null, music: null,
  sfxOn: localStorage.getItem("pixelterra-sfx") !== "0",
  musicOn: localStorage.getItem("pixelterra-music") !== "0",
  theme: null, timer: null, beat: 0,
};

function audio() {
  if (!snd.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    snd.ctx = new AC();
    snd.master = snd.ctx.createGain();
    snd.master.gain.value = 0.55;
    snd.master.connect(snd.ctx.destination);
    snd.music = snd.ctx.createGain();
    snd.music.gain.value = snd.musicOn ? 0.22 : 0;
    snd.music.connect(snd.master);
  }
  if (snd.ctx.state !== "running") snd.ctx.resume().catch(() => {});
  return snd.ctx;
}
addEventListener("pointerdown", audio, true);
addEventListener("keydown", audio, true);

function tone(freq, dur, { type = "square", vol = 0.12, slide = 0, delay = 0, out = null } = {}) {
  const c = snd.ctx;
  if (!c || (!out && !snd.sfxOn)) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out || snd.master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, { vol = 0.15, freq = 1200, delay = 0 } = {}) {
  const c = snd.ctx;
  if (!c || !snd.sfxOn) return;
  const t = c.currentTime + delay;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf; f.type = "lowpass"; f.frequency.value = freq; g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(snd.master);
  src.start(t);
}

const SFX = {
  step: () => noise(0.06, { vol: 0.05, freq: 900 }),
  rustle: () => noise(0.12, { vol: 0.09, freq: 2600 }),
  hit: () => { noise(0.07, { vol: 0.18, freq: 700 }); tone(140, 0.08, { type: "triangle", vol: 0.15 }); },
  break: () => { noise(0.22, { vol: 0.22, freq: 1100 }); tone(220, 0.18, { type: "square", vol: 0.07, slide: -150 }); },
  pickup: () => { tone(660, 0.07, { vol: 0.08 }); tone(990, 0.09, { vol: 0.08, delay: 0.07 }); },
  place: () => { noise(0.08, { vol: 0.18, freq: 500 }); tone(110, 0.1, { type: "triangle", vol: 0.15 }); },
  craft: () => [523, 659, 784].forEach((f, i) => tone(f, 0.1, { vol: 0.08, delay: i * 0.06 })),
  heal: () => [392, 523, 659, 784].forEach((f, i) => tone(f, 0.18, { type: "sine", vol: 0.12, delay: i * 0.09 })),
  encounter: () => [220, 330, 440, 660, 880].forEach((f, i) => tone(f, 0.08, { vol: 0.09, delay: i * 0.05 })),
  attack: () => { noise(0.1, { vol: 0.2, freq: 1800 }); tone(300, 0.15, { vol: 0.1, slide: -220 }); },
  superHit: () => { noise(0.18, { vol: 0.28, freq: 2400 }); tone(500, 0.2, { vol: 0.12, slide: -400 }); },
  faint: () => tone(440, 0.6, { type: "triangle", vol: 0.15, slide: -380 }),
  shake: () => { tone(180, 0.05, { type: "triangle", vol: 0.18 }); noise(0.05, { vol: 0.12, freq: 600 }); },
  caught: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.14, { vol: 0.1, delay: i * 0.11 })),
  levelUp: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.12, { vol: 0.1, delay: i * 0.08 })),
  quest: () => [659, 784, 988, 1319].forEach((f, i) => tone(f, 0.16, { type: "triangle", vol: 0.14, delay: i * 0.1 })),
  deny: () => tone(150, 0.15, { vol: 0.08 }),
  click: () => tone(880, 0.03, { vol: 0.05 }),
};
function sfx(name) { if (snd.ctx && snd.sfxOn && SFX[name]) SFX[name](); }

// Música: melodías cortas en bucle (escala pentatónica), una para el mundo y otra para combatir.
const THEMES = {
  day: { bpm: 104, wave: "triangle", lead: [0, 2, 4, 7, 4, 2, 0, -3, 0, 2, 4, 9, 7, 4, 2, 4], bass: [-12, -12, -5, -5, -7, -7, -5, -5], root: 392 },
  night: { bpm: 80, wave: "sine", lead: [0, -3, 0, 2, 0, -5, -3, 0, 4, 2, 0, -3, -5, -3, 0, -1], bass: [-15, -15, -10, -10, -12, -12, -8, -8], root: 330 },
  battle: { bpm: 150, wave: "square", lead: [0, 0, 3, 0, 5, 3, 7, 5, 0, 0, 3, 0, 8, 7, 5, 3], bass: [-12, -12, -9, -9, -7, -7, -5, -5], root: 330 },
  boss: { bpm: 160, wave: "sawtooth", lead: [0, 1, 0, 6, 0, 1, 0, 7, 0, 1, 0, 6, 5, 3, 1, 0], bass: [-12, -12, -11, -11, -12, -12, -6, -6], root: 294 },
};
const semis = (root, n) => root * Math.pow(2, n / 12);

function playTheme(name) {
  if (snd.theme === name) return;
  snd.theme = name;
  clearInterval(snd.timer);
  snd.beat = 0;
  const th = THEMES[name];
  if (!th) return;
  const stepMs = 60000 / th.bpm / 2;
  snd.timer = setInterval(() => {
    if (!snd.ctx || !snd.musicOn || document.hidden) return;
    const i = snd.beat++ % th.lead.length;
    const n = th.lead[i];
    if (n !== null) tone(semis(th.root, n), stepMs / 1000 * 0.9, { type: th.wave, vol: name === "battle" || name === "boss" ? 0.05 : 0.07, out: snd.music });
    if (i % 2 === 0) tone(semis(th.root, th.bass[(i / 2) % th.bass.length]), stepMs / 1000 * 1.8, { type: "triangle", vol: 0.09, out: snd.music });
  }, stepMs);
}

function setMusic(on) {
  snd.musicOn = on;
  localStorage.setItem("pixelterra-music", on ? "1" : "0");
  if (snd.music) snd.music.gain.value = on ? 0.22 : 0;
}
function setSfx(on) {
  snd.sfxOn = on;
  localStorage.setItem("pixelterra-sfx", on ? "1" : "0");
}

/* ---------- Datos del juego ---------- */

const T = { WATER: 0, SAND: 1, GRASS: 2, TALL: 3, TREE: 4, STONE: 5, COAL: 6, IRON: 7, GEM: 8, FLOWER: 9, PLANKS: 10, BRICK: 11, BENCH: 12, FIRE: 13, DIRT: 14, DEEP: 15, ALTAR: 16 };
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
  magma: { name: "Puño de magma", type: "fuego", pow: 70 },
  temblor: { name: "Temblor", type: "roca", pow: 90 },
};

/* Criaturas. art: operaciones de dibujo en una rejilla de 24×24 (se perfilan solas).
 *   ["e", cx, cy, rx, ry, color]  elipse      ["r", x, y, w, h, color]  rectángulo
 *   ["t", x1, y1, x2, y2, x3, y3, color]  triángulo   ["o", x, y, color]  ojo (1 píxel) */
const SPECIES = {
  brasito: { name: "Brasito", type: "fuego", base: { hp: 45, atk: 56, def: 42, spd: 55 }, learn: [[1, "placaje"], [1, "ascuas"], [14, "llamarada"]], evo: { lvl: 16, to: "fogaro" },
    art: [["t", 3, 16, 7, 6, 9, 15, "#ffcc33"], ["e", 4, 8, 2, 3, "#ff5a1f"], ["e", 11, 15, 6, 5, "#ff8a3d"], ["e", 16, 10, 4, 4, "#ff8a3d"], ["e", 11, 17, 3, 2, "#ffd27a"], ["r", 7, 19, 3, 3, "#e0662a"], ["r", 13, 19, 3, 3, "#e0662a"], ["o", 17, 9, "#1b1b1b"], ["r", 18, 11, 2, 1, "#a8361a"]] },
  gotin: { name: "Gotín", type: "agua", base: { hp: 52, atk: 46, def: 52, spd: 45 }, learn: [[1, "placaje"], [1, "burbuja"], [14, "torrente"]], evo: { lvl: 16, to: "marejo" },
    art: [["t", 12, 2, 5, 13, 19, 13, "#5ab8ff"], ["e", 12, 15, 7, 6, "#5ab8ff"], ["e", 9, 12, 1, 2, "#d7f1ff"], ["o", 10, 15, "#123"], ["o", 14, 15, "#123"], ["r", 11, 18, 3, 1, "#2a5f99"]] },
  brotin: { name: "Brotín", type: "planta", base: { hp: 50, atk: 48, def: 54, spd: 43 }, learn: [[1, "placaje"], [1, "hoja"], [14, "raices"]], evo: { lvl: 16, to: "arbolon" },
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
// Evoluciones de las tres iniciales (nivel 16) y el jefe final.
Object.assign(SPECIES, {
  fogaro: { name: "Fogaro", type: "fuego", base: { hp: 68, atk: 82, def: 62, spd: 78 }, learn: [[1, "aranazo"], [1, "ascuas"], [14, "llamarada"], [24, "magma"]],
    art: [["t", 1, 19, 5, 10, 7, 18, "#ffcc33"], ["e", 3, 9, 2, 3, "#ff3a1f"], ["e", 12, 15, 7, 7, "#ff6a2a"], ["e", 12, 17, 4, 4, "#ffd27a"], ["t", 10, 5, 11, 0, 13, 5, "#ffcc33"], ["t", 15, 5, 17, 0, 18, 5, "#ffcc33"], ["e", 14, 7, 5, 4, "#ff6a2a"], ["r", 4, 12, 2, 5, "#ff6a2a"], ["r", 19, 12, 2, 5, "#ff6a2a"], ["r", 8, 20, 3, 3, "#c84a1a"], ["r", 14, 20, 3, 3, "#c84a1a"], ["o", 12, 7, "#1b1b1b"], ["o", 16, 7, "#1b1b1b"], ["r", 15, 9, 3, 1, "#a8361a"]] },
  marejo: { name: "Marejo", type: "agua", base: { hp: 78, atk: 66, def: 76, spd: 62 }, learn: [[1, "placaje"], [1, "burbuja"], [14, "torrente"]],
    art: [["t", 1, 17, 6, 11, 7, 19, "#2a6fb5"], ["t", 23, 17, 18, 11, 17, 19, "#2a6fb5"], ["t", 3, 11, 12, 1, 21, 11, "#5ab8ff"], ["e", 12, 14, 9, 7, "#3f9de8"], ["e", 12, 17, 5, 3, "#a8dcff"], ["e", 7, 6, 2, 2, "#e8f7ff"], ["e", 17, 5, 2, 2, "#e8f7ff"], ["o", 9, 12, "#0d2a4a"], ["o", 15, 12, "#0d2a4a"], ["r", 11, 15, 3, 1, "#1d4f80"]] },
  arbolon: { name: "Arbolón", type: "planta", base: { hp: 76, atk: 72, def: 82, spd: 52 }, learn: [[1, "placaje"], [1, "hoja"], [14, "raices"]],
    art: [["r", 3, 12, 4, 2, "#7a4f2a"], ["r", 17, 12, 4, 2, "#7a4f2a"], ["e", 3, 11, 1, 1, "#62c56a"], ["e", 21, 11, 1, 1, "#62c56a"], ["r", 7, 9, 10, 13, "#7a4f2a"], ["r", 9, 10, 1, 10, "#8f6136"], ["e", 12, 6, 9, 5, "#3f9e45"], ["e", 9, 4, 3, 2, "#62c56a"], ["e", 16, 7, 2, 1, "#62c56a"], ["r", 7, 21, 3, 2, "#5a3a1e"], ["r", 14, 21, 3, 2, "#5a3a1e"], ["o", 10, 13, "#ffe14a"], ["o", 14, 13, "#ffe14a"]] },
  obsidion: { name: "Guardián Obsidiano", type: "roca", boss: true, base: { hp: 120, atk: 80, def: 90, spd: 45 }, learn: [[1, "pedrada"], [1, "magma"], [1, "avalancha"], [1, "temblor"]],
    art: [["r", 1, 9, 3, 9, "#3a2f55"], ["r", 20, 9, 3, 9, "#3a2f55"], ["r", 4, 6, 16, 15, "#2b2240"], ["e", 12, 6, 6, 4, "#3a2f55"], ["t", 5, 5, 7, 0, 9, 5, "#8a7aa8"], ["t", 15, 5, 17, 0, 19, 5, "#8a7aa8"], ["t", 6, 8, 7, 3, 8, 8, "#b48cff"], ["r", 8, 10, 1, 6, "#ff7a2e"], ["r", 15, 12, 1, 5, "#ff7a2e"], ["r", 11, 17, 3, 1, "#ff7a2e"], ["r", 5, 21, 4, 2, "#1d1630"], ["r", 15, 21, 4, 2, "#1d1630"], ["o", 10, 6, "#ff3a3a"], ["o", 14, 6, "#ff3a3a"]] },
});
const BESTIARY = Object.keys(SPECIES).filter((sp) => !SPECIES[sp].boss);
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
  [T.ALTAR]: [0, 1].map((f) => makeTile((px, r) => {
    speckle(px, r, "#2b2240", ["#231b36", "#352a4f"], 30);
    px(2, 2, "#4a3d6e", 12, 12); px(3, 3, "#1d1630", 10, 10);
    px(7, 4, f ? "#d6b8ff" : "#b48cff", 2, 8); px(5, 7, f ? "#d6b8ff" : "#b48cff", 6, 2);
    px(7, 7, "#ff7a2e", 2, 2);
  }, 19 + f)),
};

/* ---------- Arte extra: variantes del suelo y árboles grandes ---------- */

// Número pseudoaleatorio estable para cada casilla (para elegir variantes sin parpadeos).
function hash(x, y, k = 0) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(k, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const GROUND_VARIANTS = {
  [T.GRASS]: [
    TILE_ART[T.GRASS][0],
    makeTile((px, r) => { speckle(px, r, "#5fae4f", ["#57a248", "#6bbb5a", "#4f9a42"], 34); px(3, 11, "#9a9a8a", 2, 1); px(4, 10, "#b5b5a5"); px(11, 4, "#9a9a8a"); }, 31),
    makeTile((px, r) => { speckle(px, r, "#62b252", ["#57a248", "#71c25f", "#4f9a42"], 30); px(9, 9, "#f2efe6", 3, 1); px(9, 10, "#c9483a", 3, 1); px(10, 11, "#e8e0cc", 1, 2); }, 32),
    makeTile((px, r) => { speckle(px, r, "#5aa94b", ["#4f9a42", "#6bbb5a"], 30); for (const [x, y] of [[3, 3], [12, 6], [6, 12]]) { px(x, y, "#3e8a3a", 3, 1); px(x + 1, y - 1, "#3e8a3a"); px(x + 1, y + 1, "#3e8a3a"); } }, 33),
    makeTile((px, r) => { speckle(px, r, "#5fae4f", ["#57a248", "#6bbb5a"], 26); px(4, 6, "#ffffff"); px(12, 10, "#ffd23f"); px(8, 13, "#ffffff"); }, 34),
  ],
  [T.SAND]: [
    TILE_ART[T.SAND][0],
    makeTile((px, r) => { speckle(px, r, "#e8d48f", ["#dcc67f", "#f3e2a6"], 28); px(5, 6, "#ffd8c8", 2, 2); px(6, 5, "#f0b8a8"); }, 35),
    makeTile((px, r) => { speckle(px, r, "#ead796", ["#dcc67f", "#f3e2a6", "#cbb46a"], 34); px(11, 10, "#a89a7a", 2, 1); px(3, 12, "#a89a7a"); }, 36),
  ],
  [T.DIRT]: [
    TILE_ART[T.DIRT][0],
    makeTile((px, r) => { speckle(px, r, "#856543", ["#7d5f3d", "#967451", "#6e5235"], 36); px(4, 9, "#9a9a8a", 2, 2); px(12, 4, "#6b5034", 2, 1); }, 37),
  ],
  [T.TALL]: [
    TILE_ART[T.TALL][0],
    makeTile((px, r) => {
      speckle(px, r, "#4a9140", ["#4a9140", "#57a248"], 16);
      for (let i = 0; i < 10; i++) { const x = 1 + ((i * 3 + 2) % 14), y = 3 + ((i * 5) % 10); px(x, y, "#2a702a", 1, 5); px(x + 1, y + 1, "#8ad874", 1, 3); }
    }, 38),
  ],
};

function treeArt(ops) { return gridToCanvas(rasterize(ops, 32), 32, 1, "#13361a"); }
const TREES = [
  treeArt([["e", 16, 21, 9, 4, "#23652a"], ["r", 14, 22, 4, 9, "#6b4426"], ["r", 15, 22, 1, 9, "#8a5a32"], ["r", 12, 30, 8, 1, "#5a381f"],
    ["e", 16, 13, 12, 10, "#2c7a32"], ["e", 10, 11, 6, 5, "#3f9a40"], ["e", 21, 10, 6, 5, "#3f9a40"], ["e", 15, 7, 6, 4, "#4fae4a"], ["e", 16, 18, 9, 3, "#25682b"],
    ["e", 9, 9, 2, 1, "#7fd06a"], ["e", 19, 6, 2, 1, "#7fd06a"], ["e", 14, 5, 2, 1, "#8ee07a"]]),
  treeArt([["r", 15, 24, 3, 7, "#5a381f"], ["r", 16, 24, 1, 7, "#7a4f2a"], ["t", 16, 26, 4, 27, 28, 27, "#1f5e3a"],
    ["t", 16, 13, 5, 26, 27, 26, "#23683f"], ["t", 16, 7, 7, 19, 25, 19, "#2b7a48"], ["t", 16, 1, 9, 12, 23, 12, "#358a54"],
    ["t", 16, 3, 13, 10, 16, 10, "#56b070"], ["t", 15, 10, 11, 17, 15, 17, "#3f9a5a"]]),
  treeArt([["r", 14, 22, 4, 9, "#6b4426"], ["r", 15, 22, 1, 9, "#8a5a32"], ["e", 16, 13, 12, 10, "#3a8a36"], ["e", 11, 10, 6, 5, "#4fae4a"], ["e", 21, 11, 5, 4, "#4fae4a"], ["e", 16, 7, 5, 3, "#63c25a"],
    ["r", 9, 12, 2, 2, "#e23b3b"], ["r", 20, 9, 2, 2, "#e23b3b"], ["r", 14, 17, 2, 2, "#e23b3b"], ["r", 22, 15, 2, 2, "#e23b3b"], ["r", 17, 12, 2, 2, "#ff6a5a"], ["e", 13, 6, 2, 1, "#8ee07a"]]),
];
GROUND_VARIANTS[T.STONE] = [
  TILE_ART[T.STONE][0],
  makeTile((px, r) => { stoneBase(px, r); px(3, 3, "#5f8a4a", 3, 2); px(4, 2, "#78a35c", 2, 1); px(11, 12, "#5f8a4a", 2, 1); }, 41),
  makeTile((px, r) => { stoneBase(px, r); px(4, 9, "#6a6a6a", 1, 4); px(5, 12, "#6a6a6a", 3, 1); px(10, 3, "#6a6a6a", 1, 3); px(11, 5, "#6a6a6a", 2, 1); }, 42),
  makeTile((px, r) => { speckle(px, r, "#7f7f86", ["#73737a", "#8c8c93"], 40); px(2, 2, "#9a9aa2", 6, 5); px(3, 3, "#b0b0b8", 4, 1); px(2, 6, "#5c5c63", 6, 1); px(9, 9, "#9a9aa2", 5, 4); px(10, 10, "#b0b0b8", 3, 1); px(9, 12, "#5c5c63", 5, 1); }, 43),
];
const treeVariant = (x, y) => { const h = hash(x, y, 7) % 10; return h < 6 ? 0 : h < 9 ? 1 : 2; };

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
  upgradeState();
  save();
}

// Añade lo que falte a partidas guardadas con versiones anteriores del juego.
function upgradeState() {
  S.seen = S.seen || {};
  S.stats = S.stats || { got: {}, crafted: {}, placed: {}, caught: 0, wins: 0 };
  S.quest = S.quest || 0;
  if (!S.boss) S.boss = placeAltar();
  explored = S.explored ? decodeBits(S.explored) : new Uint8Array((W * H) >> 3);
  markExplored(S.player.x, S.player.y);
}

// El altar del jefe: en la zona de montaña más grande, rodeado de roca (hay que picar para llegar).
function placeAltar() {
  let best = null, bestScore = -1;
  for (let y = 8; y < H - 8; y += 3) for (let x = 8; x < W - 8; x += 3) {
    let score = 0;
    for (let j = -5; j <= 5; j += 1) for (let i = -5; i <= 5; i += 1) {
      const t = tileAt(x + i, y + j);
      if (t === T.STONE || t === T.COAL || t === T.IRON || t === T.GEM) score++;
    }
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  if (!best) best = { x: W / 2 + 20, y: H / 2 + 20 };
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) setTile(best.x + i, best.y + j, T.DIRT);
  setTile(best.x, best.y, T.ALTAR);
  return { x: best.x, y: best.y, defeated: false };
}

/* Mapa explorado: un bit por casilla. */
let explored = null;
function markExplored(cx, cy, r = 7) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    const i = idx(x, y);
    explored[i >> 3] |= 1 << (i & 7);
  }
}
const isExplored = (x, y) => explored && (explored[idx(x, y) >> 3] >> (idx(x, y) & 7)) & 1;
function encodeBits(a) {
  let s = "";
  for (let i = 0; i < a.length; i += 4096) s += String.fromCharCode.apply(null, a.subarray(i, i + 4096));
  return btoa(s);
}
function decodeBits(b64) {
  const bin = atob(b64), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

function track(kind, id, n = 1) {
  const bucket = S.stats[kind];
  if (typeof bucket === "object") bucket[id] = (bucket[id] || 0) + n;
  else S.stats[kind] = (S.stats[kind] || 0) + (n || 1);
  checkQuests();
}

function encodeWorld() {
  let s = "";
  for (let i = 0; i < world.length; i += 4096) s += String.fromCharCode.apply(null, world.subarray(i, i + 4096));
  return btoa(s);
}

function save() {
  if (!S) return;
  try {
    if (explored) S.explored = encodeBits(explored);
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
    if (world.length !== W * H) return false;
    upgradeState();
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- Inventario ---------- */

const count = (id) => S.inv[id] || 0;
function addItem(id, n = 1, gathered = true) {
  S.inv[id] = count(id) + n;
  renderHotbar();
  if (gathered) track("got", id, n);
}
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

/* ---------- Misiones: guían la partida hasta el jefe final ---------- */

const got = (id) => (S.stats.got[id] || 0);
const QUESTS = [
  { text: "Tala madera", goal: 3, prog: () => got("madera"), reward: { pocion: 1 }, tip: "Ponte delante de un árbol y pulsa A varias veces." },
  { text: "Fabrica un banco de trabajo", goal: 1, prog: () => S.stats.crafted.banco || 0, reward: { cubo: 2 }, tip: "🛠️ → Tablas → Banco de trabajo. Ponlo en el suelo con B." },
  { text: "Fabrica un pico de madera", goal: 1, prog: () => S.stats.crafted.pico_madera || 0, reward: { baya: 3 }, tip: "Necesitas tablas y palos." },
  { text: "Captura una criatura", goal: 1, prog: () => S.stats.caught || 0, reward: { cubo: 3 }, tip: "Debilítala en combate y lánzale un cubo." },
  { text: "Enciende una hoguera", goal: 1, prog: () => S.stats.placed.hoguera || 0, reward: { pocion: 2 }, tip: "2 madera + 1 carbón (pica piedra negra con el pico)." },
  { text: "Consigue hierro", goal: 3, prog: () => got("hierro"), reward: { supercubo: 1 }, tip: "Las vetas naranjas de la montaña. Necesitas pico de piedra." },
  { text: "Fabrica un pico de hierro", goal: 1, prog: () => S.stats.crafted.pico_hierro || 0, reward: { pocion: 3 }, tip: "En el banco: 3 hierro + 2 palos." },
  { text: "Consigue una gema", goal: 1, prog: () => got("gema"), reward: { supercubo: 2 }, tip: "Las vetas turquesa, en lo más alto de la montaña." },
  { text: "Descubre criaturas", goal: 8, prog: () => Object.keys(S.seen).filter((k) => !SPECIES[k].boss).length, reward: { pocion: 3, supercubo: 1 }, tip: "Explora de día y de noche, en la hierba, junto al agua y en la montaña." },
  { text: "Derrota al Guardián Obsidiano", goal: 1, prog: () => (S.boss.defeated ? 1 : 0), reward: { gema: 3 }, tip: "Su altar está en la cumbre (míralo en el 🗺️ mapa). Ve con tu equipo a nivel 25 o más." },
];

function checkQuests() {
  let q = QUESTS[S.quest];
  while (q && q.prog() >= q.goal) {
    for (const [id, n] of Object.entries(q.reward)) addItem(id, n, false);
    const reward = Object.entries(q.reward).map(([id, n]) => `${n} ${ITEMS[id].name}`).join(", ");
    S.quest++;
    sfx("quest");
    toast(`🎯 ¡Misión cumplida: ${q.text}! Premio: ${reward}`, 3500);
    q = QUESTS[S.quest];
  }
  renderQuest();
}

function renderQuest() {
  const el = $("#quest");
  if (!el || !S) return;
  const q = QUESTS[S.quest];
  if (!q) { el.textContent = "🏆 ¡Has completado Pixelterra!"; return; }
  el.textContent = `🎯 ${q.text}${q.goal > 1 ? ` (${Math.min(q.prog(), q.goal)}/${q.goal})` : ""}`;
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
  scale = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) / (TS * 10.5 / ZOOMS[zoomLevel])));
  viewW = canvas.width; viewH = canvas.height;
  ctx.imageSmoothingEnabled = false;
}
addEventListener("resize", resize);

const anim = { fromX: 0, fromY: 0, start: 0, moving: false, step: 0 };

/* Efectos del mundo (en coordenadas de casilla). */
const particles = [];  // { x, y, vx, vy, life, max, color }
const floaters = [];   // { x, y, text, life }
let shakeUntil = 0;
const TILE_COLORS = {
  [T.TREE]: ["#6b4426", "#2f7d32", "#4fa34f"], [T.STONE]: ["#8c8c8c", "#6e6e6e", "#a8a8a8"],
  [T.COAL]: ["#1e1e1e", "#8c8c8c"], [T.IRON]: ["#d9a066", "#8c8c8c"], [T.GEM]: ["#2fd8c8", "#c8fff8", "#8c8c8c"],
  [T.PLANKS]: ["#b8864b", "#8a5f30"], [T.BRICK]: ["#a65a45", "#d9d0c4"], [T.TALL]: ["#2f7a2f", "#7fd06a"], [T.FLOWER]: ["#ff5a6e", "#ffd23f", "#4fa34f"],
};
function burst(x, y, tile, n = 10) {
  const cols = TILE_COLORS[tile] || ["#fff"];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 2.5;
    particles.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, life: 0, max: 0.45 + Math.random() * 0.3, color: pick(cols) });
  }
}
function floatText(x, y, text) { floaters.push({ x: x + 0.5, y: y + 0.2, text, life: 0 }); }
function shake(ms = 180) { shakeUntil = performance.now() + ms; }

/* Criaturas que pasean por la hierba alta (si te tocan, empieza el combate). */
const roamers = [];   // { mon, x, y, fromX, fromY, start, next, dir }
function updateRoamers(now) {
  const { x: px, y: py } = S.player;
  for (let i = roamers.length - 1; i >= 0; i--) {
    const r = roamers[i];
    if (Math.abs(r.x - px) > 16 || Math.abs(r.y - py) > 16) { roamers.splice(i, 1); continue; }
    if (now > r.next) {
      r.next = now + 700 + Math.random() * 1400;
      const [dx, dy] = pick(Object.values(DIRS));
      const nx = r.x + dx, ny = r.y + dy, t = tileAt(nx, ny);
      if ((t === T.TALL || t === T.GRASS || t === T.FLOWER || t === T.DIRT) && !roamers.some((o) => o.x === nx && o.y === ny)) {
        r.fromX = r.x; r.fromY = r.y; r.start = now; r.x = nx; r.y = ny; r.dir = dx < 0 ? -1 : dx > 0 ? 1 : r.dir;
      }
    }
    if (r.x === px && r.y === py && !modalOpen()) {
      roamers.splice(i, 1);
      return startWildBattle(r.mon);
    }
  }
  // Aparecen nuevas criaturas cerca, en hierba alta, sin salir encima del jugador.
  if (roamers.length < 6 && Math.random() < 0.02) {
    const x = px + Math.floor(Math.random() * 21) - 10, y = py + Math.floor(Math.random() * 21) - 10;
    if (tileAt(x, y) === T.TALL && Math.abs(x - px) + Math.abs(y - py) > 4) {
      roamers.push({ mon: makeWild(), x, y, fromX: x, fromY: y, start: 0, next: now + 500, dir: 1 });
    }
  }
}
/* ---------- Ambiente: bichos, hojas, nubes y lluvia ---------- */

const amb = { bugs: [], leaves: [], drops: [], clouds: [], splashes: [], rainGain: null };
const isRock = (t) => t === T.STONE || t === T.COAL || t === T.IRON || t === T.GEM;
const raining = () => S && S.weather === "rain";

function newDayWeather() {
  // Llueve aproximadamente uno de cada cuatro días.
  S.weather = Math.random() < 0.25 ? "rain" : "sun";
  if (S.weather === "rain") toast("🌧️ Empieza a llover…", 2500);
}

function updateAmbient(dt, now) {
  const { x: px, y: py } = S.player;
  const night = isNight();
  // Mariposas de día y luciérnagas de noche alrededor del jugador.
  const want = raining() ? 0 : night ? 16 : 6;
  while (amb.bugs.length < want) {
    const x = px + (Math.random() * 18 - 9), y = py + (Math.random() * 18 - 9);
    const t = tileAt(Math.floor(x), Math.floor(y));
    if (t === T.WATER || t === T.DEEP || isRock(t)) break;
    amb.bugs.push({ x, y, vx: 0, vy: 0, a: Math.random() * 6, night, color: pick(night ? ["#d8ff7a"] : ["#ffffff", "#ffd23f", "#ff9ad5", "#9ad0ff"]) });
  }
  for (let i = amb.bugs.length - 1; i >= 0; i--) {
    const b = amb.bugs[i];
    if (b.night !== night || amb.bugs.length > want || Math.abs(b.x - px) > 12 || Math.abs(b.y - py) > 12) { amb.bugs.splice(i, 1); continue; }
    b.a += dt * (b.night ? 1.2 : 3);
    b.vx += (Math.random() - 0.5) * dt * 3; b.vy += (Math.random() - 0.5) * dt * 3;
    b.vx *= 0.97; b.vy *= 0.97;
    b.x += b.vx * dt + Math.cos(b.a) * dt * 0.3; b.y += b.vy * dt + Math.sin(b.a * 1.3) * dt * 0.3;
  }
  // Hojas que caen de los árboles cercanos.
  if (!night && Math.random() < dt * 1.5) {
    const tx = px + Math.floor(Math.random() * 15 - 7), ty = py + Math.floor(Math.random() * 15 - 7);
    if (tileAt(tx, ty) === T.TREE) amb.leaves.push({ x: tx + 0.3 + Math.random() * 0.4, y: ty - 0.4, t: 0, s: Math.random() * 6, color: pick(["#4fae4a", "#7fd06a", "#d9b24a"]) });
  }
  for (let i = amb.leaves.length - 1; i >= 0; i--) {
    const l = amb.leaves[i];
    l.t += dt; l.y += dt * 0.5; l.x += Math.sin(l.t * 3 + l.s) * dt * 0.6;
    if (l.t > 2.2) amb.leaves.splice(i, 1);
  }
  // Nubes que pasan (sus sombras se ven en el suelo).
  if (!amb.clouds.length) for (let i = 0; i < 4; i++) amb.clouds.push({ x: px + Math.random() * 30 - 15, y: py + Math.random() * 30 - 15, r: 3 + Math.random() * 3 });
  for (const c of amb.clouds) {
    c.x += dt * 0.35; c.y += dt * 0.12;
    if (c.x - px > 18) { c.x = px - 18; c.y = py + Math.random() * 24 - 12; }
    if (Math.abs(c.y - py) > 18) c.y = py + Math.random() * 24 - 12;
  }
  // Lluvia: gotas en pantalla y salpicaduras en el suelo.
  if (raining()) {
    while (amb.drops.length < 140) amb.drops.push({ x: Math.random(), y: Math.random(), v: 0.9 + Math.random() * 0.6 });
    for (const d of amb.drops) { d.y += d.v * dt * 1.4; d.x -= d.v * dt * 0.25; if (d.y > 1.05) { d.y = -0.05; d.x = Math.random() * 1.2; } }
    if (Math.random() < dt * 30) amb.splashes.push({ x: px + Math.random() * 14 - 7, y: py + Math.random() * 20 - 10, t: 0 });
  } else amb.drops.length = 0;
  for (let i = amb.splashes.length - 1; i >= 0; i--) { amb.splashes[i].t += dt; if (amb.splashes[i].t > 0.35) amb.splashes.splice(i, 1); }
  rainSound(raining() && !modalOpen());
}

// Sonido de lluvia: ruido filtrado en bucle.
function rainSound(on) {
  const c = snd.ctx;
  if (!c) return;
  if (!amb.rainGain) {
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; src.loop = true; f.type = "highpass"; f.frequency.value = 900; g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(snd.master); src.start();
    amb.rainGain = g;
  }
  amb.rainGain.gain.setTargetAtTime(on && snd.sfxOn ? 0.05 : 0, c.currentTime, 0.4);
}

/* Zoom de la cámara: doble toque en el mapa para alejar o acercar. */
const ZOOMS = [1, 0.8, 0.62];
let zoomLevel = (Number(localStorage.getItem("pixelterra-zoom")) || 0) % ZOOMS.length;
function cycleZoom() {
  zoomLevel = (zoomLevel + 1) % ZOOMS.length;
  localStorage.setItem("pixelterra-zoom", zoomLevel);
  resize();
  sfx("click");
  toast(["🔍 Cámara normal", "🔍 Cámara lejos", "🔍 Cámara muy lejos"][zoomLevel], 1200);
}

const mining = { x: -1, y: -1, hits: 0 };
let lastTime = performance.now();
let paused = true;
let lastSave = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (!paused) {
    S.time += dt / DAY_SECONDS;
    if (S.time >= 1) { S.time -= 1; S.day++; newDayWeather(); }
    updateAmbient(dt, now);
    updateMovement(now);
    if (!modalOpen()) updateRoamers(now);
    if (holdA && now - lastA > 230) doAction();
    if (now - lastSave > 10000) { save(); lastSave = now; }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 9 * dt;
    if (p.life > p.max) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    floaters[i].life += dt;
    if (floaters[i].life > 1.1) floaters.splice(i, 1);
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

function dawnDusk() {
  // Luz cálida al amanecer y al atardecer (0–1).
  const t = S.time;
  if (t > 0.03 && t < 0.14) return 1 - Math.abs(t - 0.085) / 0.055;
  if (t > 0.5 && t < 0.64) return 1 - Math.abs(t - 0.57) / 0.07;
  return 0;
}

function vignette() {
  const v = vignette.c || (vignette.c = document.createElement("canvas"));
  if (v.width !== viewW || v.height !== viewH) {
    v.width = viewW; v.height = viewH;
    const c = v.getContext("2d");
    const g = c.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.35, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.35)");
    c.fillStyle = g; c.fillRect(0, 0, viewW, viewH);
  }
  return v;
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
  let camX = Math.round(px * size + size / 2 - viewW / 2), camY = Math.round(py * size + size / 2 - viewH / 2);
  if (now < shakeUntil) { camX += Math.round((Math.random() - 0.5) * scale * 3); camY += Math.round((Math.random() - 0.5) * scale * 3); }
  const sx = (wx) => Math.round(wx * size - camX), sy = (wy) => Math.round(wy * size - camY);
  const x0 = Math.floor(camX / size) - 1, y0 = Math.floor(camY / size) - 1;
  const cols = Math.ceil(viewW / size) + 3, rows = Math.ceil(viewH / size) + 4;
  const frame = Math.floor(now / 500) % 2;
  ctx.fillStyle = "#2a6fb5";
  ctx.fillRect(0, 0, viewW, viewH);
  const fires = [], objects = [];

  // 1) Suelo.
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const tx = x0 + i, ty = y0 + j, t = tileAt(tx, ty);
    const dx = sx(tx), dy = sy(ty);
    if (t === T.TREE) {
      // Los árboles se dibujan después, por profundidad; aquí solo el césped de debajo.
      ctx.drawImage(GROUND_VARIANTS[T.GRASS][hash(tx, ty) % 4], dx, dy, size, size);
      objects.push({ y: ty + 1, kind: "tree", tx, ty });
      continue;
    }
    const variants = GROUND_VARIANTS[t];
    if (t === T.TALL) {
      ctx.drawImage(GROUND_VARIANTS[T.GRASS][0], dx, dy, size, size);
      const sway = Math.round(Math.sin(now / 420 + tx * 0.9 + ty * 0.5) * scale * (raining() ? 1.1 : 0.6));
      ctx.drawImage(variants[hash(tx, ty) % 2], dx + sway, dy, size, size);
    } else if (variants) {
      const h = hash(tx, ty);
      ctx.drawImage(variants[t === T.GRASS ? (h % 7 < 3 ? 0 : 1 + (h % 4)) % variants.length : h % variants.length], dx, dy, size, size);
    } else {
      const art = TILE_ART[t];
      ctx.drawImage(art[art.length > 1 ? frame : 0], dx, dy, size, size);
    }
    if (t === T.WATER || t === T.DEEP) {
      // Espuma en la orilla y brillos en el agua.
      ctx.fillStyle = "#e8f7ffb0";
      const land = (xx, yy) => { const n = tileAt(xx, yy); return n !== T.WATER && n !== T.DEEP; };
      const w = Math.max(1, scale);
      if (land(tx, ty - 1)) ctx.fillRect(dx, dy, size, w);
      if (land(tx, ty + 1)) ctx.fillRect(dx, dy + size - w, size, w);
      if (land(tx - 1, ty)) ctx.fillRect(dx, dy, w, size);
      if (land(tx + 1, ty)) ctx.fillRect(dx + size - w, dy, w, size);
      if (hash(tx, ty, Math.floor(now / 350)) % 19 === 0) {
        ctx.fillStyle = "#ffffffd0";
        const h = hash(tx, ty, 3);
        ctx.fillRect(dx + (h % 12) * scale, dy + ((h >> 4) % 12) * scale, scale * 2, scale);
      }
    } else if (isRock(t)) {
      // Montaña con relieve: borde de luz arriba y acantilado delante.
      if (!isRock(tileAt(tx, ty - 1))) { ctx.fillStyle = "#ffffff30"; ctx.fillRect(dx, dy, size, scale); }
      if (!isRock(tileAt(tx, ty + 1))) {
        const fh = Math.round(size * 0.38);
        ctx.fillStyle = "#3f3f46"; ctx.fillRect(dx, dy + size - fh, size, fh);
        ctx.fillStyle = "#2c2c33";
        for (let k = 2; k < 16; k += 5) ctx.fillRect(dx + ((k + hash(tx, ty) % 3) * scale), dy + size - fh, scale, fh);
        ctx.fillStyle = "#00000033"; ctx.fillRect(dx, dy + size, size, Math.round(size * 0.22));
      }
    } else if (t === T.BRICK || t === T.PLANKS) {
      if (WALKABLE.has(tileAt(tx, ty + 1))) { ctx.fillStyle = "#0000002a"; ctx.fillRect(dx, dy + size, size, Math.round(size * 0.18)); }
    }
    if (t === T.FIRE || t === T.ALTAR) fires.push([dx + size / 2, dy + size / 2]);
  }

  // Sombras de las nubes.
  if (!isNight()) {
    for (const c of amb.clouds) {
      const cx = sx(c.x), cy = sy(c.y), r = c.r * size;
      if (cx < -r || cy < -r || cx > viewW + r || cy > viewH + r) continue;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, "rgba(10,20,40,.13)"); g.addColorStop(1, "rgba(10,20,40,0)");
      ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
  // Salpicaduras de lluvia.
  for (const sp of amb.splashes) {
    ctx.strokeStyle = `rgba(220,235,255,${0.6 - sp.t * 1.6})`;
    ctx.lineWidth = Math.max(1, scale / 2);
    ctx.beginPath(); ctx.ellipse(sx(sp.x), sy(sp.y), size * 0.12 * (1 + sp.t * 4), size * 0.05 * (1 + sp.t * 4), 0, 0, Math.PI * 2); ctx.stroke();
  }
  // Grietas en el bloque que se está rompiendo.
  if (mining.hits > 0) {
    const dx = sx(mining.x), dy = sy(mining.y);
    ctx.fillStyle = "#0009";
    const k = mining.hits;
    ctx.fillRect(dx + size * 0.3, dy + size * 0.2, scale, size * 0.25 * k);
    ctx.fillRect(dx + size * 0.55, dy + size * 0.45, size * 0.18 * k, scale);
    ctx.fillRect(dx + size * 0.2, dy + size * 0.65, size * 0.12 * k, scale);
  }
  // Casilla de delante (esquinas, más discreto que un marco).
  const f = facing();
  {
    const fx = sx(f.x), fy = sy(f.y), L = Math.round(size * 0.28), w = Math.max(2, scale);
    ctx.fillStyle = `rgba(255,255,255,${0.55 + Math.sin(now / 200) * 0.2})`;
    for (const [ax, ay, hx, hy] of [[fx, fy, 1, 1], [fx + size, fy, -1, 1], [fx, fy + size, 1, -1], [fx + size, fy + size, -1, -1]]) {
      ctx.fillRect(hx > 0 ? ax : ax - L, hy > 0 ? ay : ay - w, L, w);
      ctx.fillRect(hx > 0 ? ax : ax - w, hy > 0 ? ay : ay - L, w, L);
    }
  }

  // 2) Objetos con profundidad: árboles, criaturas y jugador, ordenados por su base.
  for (const r of roamers) {
    const k = clamp((now - r.start) / 260, 0, 1);
    objects.push({ y: r.fromY + (r.y - r.fromY) * k + 1, kind: "mon", r, x: r.fromX + (r.x - r.fromX) * k, yy: r.fromY + (r.y - r.fromY) * k });
  }
  objects.push({ y: py + 1.001, kind: "player" });
  objects.sort((a, b) => a.y - b.y);
  const ppx = sx(px), ppy = sy(py);
  for (const o of objects) {
    if (o.kind === "tree") {
      const w = size * 1.7, dx = sx(o.tx) + size / 2 - w / 2, dy = sy(o.ty) + size - w;
      if (dx > viewW || dy > viewH || dx + w < 0 || dy + w < 0) continue;
      // Si el jugador está detrás de la copa, se vuelve un poco transparente.
      const behind = S.player.y < o.ty && S.player.y >= o.ty - 1 && Math.abs(S.player.x - o.tx) <= 1;
      ctx.fillStyle = "#0000002e";
      ctx.beginPath(); ctx.ellipse(sx(o.tx) + size / 2, sy(o.ty) + size * 0.92, size * 0.55, size * 0.16, 0, 0, Math.PI * 2); ctx.fill();
      if (behind) ctx.globalAlpha = 0.55;
      const sway = raining() ? Math.sin(now / 300 + o.tx) * scale * 0.8 : Math.sin(now / 900 + o.tx * 1.7) * scale * 0.4;
      ctx.drawImage(TREES[treeVariant(o.tx, o.ty)], Math.round(dx + sway), Math.round(dy), Math.round(w), Math.round(w));
      ctx.globalAlpha = 1;
    } else if (o.kind === "mon") {
      const rx = sx(o.x), ry = sy(o.yy);
      if (rx < -size || ry < -size || rx > viewW || ry > viewH) continue;
      const bob = Math.round(Math.abs(Math.sin(now / 200 + o.r.x)) * scale * 1.5);
      ctx.fillStyle = "#0000003a";
      ctx.beginPath(); ctx.ellipse(rx + size / 2, ry + size * 0.92, size * 0.32, size * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(Math.round(rx + size / 2), 0);
      ctx.scale(o.r.dir, 1);
      ctx.drawImage(monCanvas(o.r.mon.sp), -size * 0.48, Math.round(ry + size * 0.04 - bob), size * 0.96, size * 0.96);
      ctx.restore();
    } else {
      const pf = PLAYER[S.player.dir][anim.moving ? 1 + (anim.step % 2) : 0];
      ctx.fillStyle = "#00000040";
      ctx.beginPath(); ctx.ellipse(ppx + size / 2, ppy + size * 0.96, size * 0.3, size * 0.09, 0, 0, Math.PI * 2); ctx.fill();
      const tallUnder = tileAt(S.player.x, S.player.y) === T.TALL && !anim.moving;
      const hop = anim.moving ? Math.round(Math.abs(Math.sin(((now - anim.start) / STEP_MS) * Math.PI)) * scale) : 0;
      ctx.drawImage(pf, 0, 0, TS, tallUnder ? 11 : TS, ppx, ppy - hop, size, tallUnder ? size * 11 / 16 : size);
    }
  }

  // Hojas que caen, partículas y textos flotantes.
  for (const l of amb.leaves) {
    ctx.globalAlpha = clamp(2.2 - l.t, 0, 1);
    ctx.fillStyle = l.color;
    ctx.fillRect(sx(l.x), sy(l.y), scale * 2, scale);
  }
  ctx.globalAlpha = 1;
  for (const p of particles) {
    ctx.globalAlpha = 1 - p.life / p.max;
    ctx.fillStyle = p.color;
    ctx.fillRect(sx(p.x), sy(p.y), scale * 2, scale * 2);
  }
  ctx.globalAlpha = 1;
  // Mariposas (de día).
  for (const b of amb.bugs) {
    if (b.night) continue;
    const bx = sx(b.x), by = sy(b.y), flap = Math.sin(now / 70 + b.a * 5) > 0;
    ctx.fillStyle = b.color;
    ctx.fillRect(bx - scale * (flap ? 2 : 1), by, scale * (flap ? 2 : 1), scale * 2);
    ctx.fillRect(bx + scale, by, scale * (flap ? 2 : 1), scale * 2);
    ctx.fillStyle = "#2a2a2a"; ctx.fillRect(bx, by, scale, scale * 2);
  }

  // Lluvia: cielo gris y gotas.
  if (raining()) {
    ctx.fillStyle = "rgba(40,55,80,.3)";
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.strokeStyle = "rgba(210,228,255,.75)";
    ctx.lineWidth = Math.max(2, scale * 0.7);
    ctx.beginPath();
    for (const d of amb.drops) {
      const x = d.x * viewW, y = d.y * viewH;
      ctx.moveTo(x, y); ctx.lineTo(x - size * 0.12, y + size * 0.4);
    }
    ctx.stroke();
  }
  // Amanecer y atardecer: luz cálida.
  const warm = dawnDusk();
  if (warm > 0) {
    ctx.fillStyle = `rgba(255,140,60,${warm * 0.2})`;
    ctx.fillRect(0, 0, viewW, viewH);
  }

  // Noche: oscuridad con luz alrededor del jugador, las hogueras y las luciérnagas.
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
    // Luciérnagas.
    for (const b of amb.bugs) {
      if (!b.night) continue;
      const bx = sx(b.x), by = sy(b.y), a = 0.35 + Math.sin(now / 300 + b.a * 4) * 0.35;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, size * 0.45);
      g.addColorStop(0, `rgba(210,255,120,${a})`); g.addColorStop(1, "rgba(210,255,120,0)");
      ctx.fillStyle = g; ctx.fillRect(bx - size * 0.45, by - size * 0.45, size * 0.9, size * 0.9);
      ctx.fillStyle = `rgba(240,255,200,${a + 0.3})`; ctx.fillRect(bx, by, scale, scale);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  // Textos flotantes por encima de todo.
  if (floaters.length) {
    ctx.font = `800 ${Math.round(size * 0.32)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const fl of floaters) {
      const fx = fl.x * size - camX, fy = (fl.y - fl.life * 0.8) * size - camY;
      ctx.globalAlpha = clamp(1.4 - fl.life * 1.3, 0, 1);
      ctx.fillStyle = "#000"; ctx.fillText(fl.text, fx + scale, fy + scale);
      ctx.fillStyle = "#fff"; ctx.fillText(fl.text, fx, fy);
    }
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(vignette(), 0, 0);
  // Reloj (y música de día o de noche).
  const label = (isNight() ? "🌙 Noche " : "☀️ Día ") + S.day + (raining() ? " 🌧️" : "");
  if (render.label !== label) {
    $("#clock").textContent = label;
    render.label = label;
    if ($("#battle").hidden) playTheme(isNight() ? "night" : "day");
  }
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
  const under = tileAt(S.player.x, S.player.y);
  if (under === T.SAND || under === T.DIRT) for (let i = 0; i < 3; i++) particles.push({ x: S.player.x + 0.5, y: S.player.y + 0.92, vx: (Math.random() - 0.5) * 1.5, vy: -0.6 - Math.random(), life: 0, max: 0.35, color: under === T.SAND ? "#f3e2a6" : "#a07c55" });
  S.player.x = nx; S.player.y = ny;
  mining.hits = 0;
}

function onStep() {
  const t = tileAt(S.player.x, S.player.y);
  markExplored(S.player.x, S.player.y);
  sfx(t === T.TALL ? "rustle" : "step");
  if (t === T.TALL && rand() < 0.06) startWildBattle();
}

/* ---------- Acciones: A (usar) y B (poner) ---------- */

let holdA = false, lastA = 0;

function doAction() {
  lastA = performance.now();
  if (modalOpen()) return;
  const f = facing();
  const t = tileAt(f.x, f.y);
  if (t === T.FIRE) return restAtFire(f);
  if (t === T.BENCH) { sfx("click"); return openPanel("craft"); }
  if (t === T.ALTAR) return challengeBoss();
  if (t === T.TALL || t === T.FLOWER) {
    setTile(f.x, f.y, T.GRASS);
    burst(f.x, f.y, t, 6);
    sfx("rustle");
    if (rand() < (t === T.FLOWER ? 0.6 : 0.25)) { addItem("baya"); floatText(f.x, f.y, "+1 Baya"); sfx("pickup"); }
    return;
  }
  const m = MINE[t];
  if (!m) return;
  if (toolLevel() < m.tool) {
    const need = ["", "un pico de madera", "un pico de piedra", "un pico de hierro"][m.tool];
    sfx("deny");
    return toast(`Necesitas ${need}`);
  }
  if (mining.x !== f.x || mining.y !== f.y) { mining.x = f.x; mining.y = f.y; mining.hits = 0; }
  mining.hits++;
  vibrate(8);
  sfx("hit");
  burst(f.x, f.y, t, 3);
  if (mining.hits >= Math.max(1, m.hits - toolLevel())) {
    setTile(f.x, f.y, m.leaves);
    burst(f.x, f.y, t, 14);
    shake(120);
    sfx("break");
    setTimeout(() => sfx("pickup"), 120);
    addItem(m.item, m.n);
    floatText(f.x, f.y, `+${m.n} ${ITEMS[m.item].name}`);
    mining.hits = 0;
  }
}

function doPlace() {
  if (modalOpen()) return;
  const id = S.sel;
  if (!id || !count(id)) return toast("Elige arriba un bloque para poner (tablas, piedra, banco…)");
  const f = facing();
  const t = tileAt(f.x, f.y);
  if (!WALKABLE.has(t) || roamers.some((r) => r.x === f.x && r.y === f.y)) { sfx("deny"); return toast("No se puede poner ahí"); }
  setTile(f.x, f.y, ITEMS[id].place);
  takeItem(id);
  sfx("place");
  track("placed", id);
  vibrate(10);
  if (id === "hoguera") toast("Hoguera encendida. Úsala con A para descansar.");
}

function restAtFire(f) {
  for (const mon of S.party) mon.hp = statsOf(mon).maxhp;
  sfx("heal");
  floatText(f.x, f.y, "💖");
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
  if (panelKind === "map") return renderMapPanel(box);
  if (panelKind === "quests") return renderQuestsPanel(box);
  if (panelKind === "victory") return renderVictory(box);
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
        addItem(rec.out, rec.n, false);
        sfx("craft");
        track("crafted", rec.out, rec.n);
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

function renderMapPanel(box) {
  $("#panel-title").textContent = "🗺️ Mapa";
  const c = document.createElement("canvas");
  c.className = "map";
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const img = x.createImageData(W, H);
  const COL = {
    [T.WATER]: [58, 143, 214], [T.DEEP]: [42, 111, 181], [T.SAND]: [232, 212, 143], [T.GRASS]: [95, 174, 79], [T.TALL]: [62, 138, 58],
    [T.TREE]: [31, 94, 37], [T.STONE]: [140, 140, 140], [T.COAL]: [90, 90, 90], [T.IRON]: [190, 140, 100], [T.GEM]: [80, 200, 190],
    [T.FLOWER]: [120, 180, 90], [T.PLANKS]: [184, 134, 75], [T.BRICK]: [166, 90, 69], [T.BENCH]: [160, 110, 60], [T.FIRE]: [255, 140, 40],
    [T.DIRT]: [138, 106, 69], [T.ALTAR]: [150, 90, 220],
  };
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = (yy * W + xx) * 4;
    const col = isExplored(xx, yy) ? COL[tileAt(xx, yy)] || [0, 0, 0] : [16, 24, 18];
    img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  const dot = (px, py, col, r) => { x.fillStyle = "#000"; x.fillRect(px - r - 1, py - r - 1, r * 2 + 3, r * 2 + 3); x.fillStyle = col; x.fillRect(px - r, py - r, r * 2 + 1, r * 2 + 1); };
  dot(S.home.x, S.home.y, "#ff8a3d", 1);
  // El altar del jefe se marca a partir de la misión de la gema (o si ya lo has visto).
  if (S.quest >= 7 || isExplored(S.boss.x, S.boss.y)) dot(S.boss.x, S.boss.y, S.boss.defeated ? "#4ade80" : "#ff3a3a", 2);
  dot(S.player.x, S.player.y, "#ffffff", 2);
  box.append(c);
  const legend = document.createElement("p");
  legend.className = "hint";
  legend.innerHTML = "⬜ Tú · 🟧 Tu hoguera · 🟥 Altar del Guardián (aparece al llegar a la misión de la gema). Lo oscuro aún no lo has explorado.";
  box.append(legend);
  const opts = document.createElement("div");
  opts.className = "toggles";
  opts.innerHTML = `<label><input type="checkbox" id="opt-music" ${snd.musicOn ? "checked" : ""}> 🎵 Música</label>
    <label><input type="checkbox" id="opt-sfx" ${snd.sfxOn ? "checked" : ""}> 🔊 Efectos de sonido</label>`;
  box.append(opts);
  $("#opt-music").onchange = (e) => { audio(); setMusic(e.target.checked); };
  $("#opt-sfx").onchange = (e) => { audio(); setSfx(e.target.checked); sfx("click"); };
  const reset = document.createElement("button");
  reset.className = "row-card danger-row";
  reset.innerHTML = "<div class='info'><b>🗑️ Empezar una partida nueva</b><small>Se borra este mundo y tu equipo.</small></div>";
  reset.onclick = () => {
    if (!confirm("¿Seguro? Se borrará tu mundo, tu equipo y tus objetos.")) return;
    localStorage.removeItem(SAVE_KEY);
    S = null;
    location.reload();
  };
  box.append(reset);
}

function renderQuestsPanel(box) {
  $("#panel-title").textContent = "🎯 Misiones";
  QUESTS.forEach((q, i) => {
    const row = document.createElement("div");
    const done = i < S.quest, current = i === S.quest;
    row.className = "quest-row" + (done ? " done" : current ? " current" : " locked");
    const reward = Object.entries(q.reward).map(([id, n]) => `${n} ${ITEMS[id].name}`).join(", ");
    const prog = current && q.goal > 1 ? ` (${Math.min(q.prog(), q.goal)}/${q.goal})` : "";
    row.innerHTML = `<span class="q-ico">${done ? "✅" : current ? "🎯" : "🔒"}</span><div><b>${i < S.quest + 1 ? q.text + prog : "???"}</b>${current ? `<small>${q.tip}</small>` : ""}<small>Premio: ${i < S.quest + 1 ? reward : "?"}</small></div>`;
    box.append(row);
  });
  const seen = Object.keys(S.seen).filter((k) => !SPECIES[k].boss).length;
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = `Bestiario: ${seen} de ${BESTIARY.length} criaturas descubiertas · Victorias: ${S.stats.wins || 0} · Capturas: ${S.stats.caught || 0}`;
  box.append(p);
}

function renderVictory(box) {
  $("#panel-title").textContent = "🏆 ¡Victoria!";
  box.innerHTML = `<div class="victory">
    <canvas id="vic-boss" width="48" height="48"></canvas>
    <h3>¡Has derrotado al Guardián Obsidiano!</h3>
    <p>La cumbre vuelve a estar en calma y Pixelterra está a salvo gracias a ti y a tu equipo.</p>
    <p class="hint">Puedes seguir explorando, completar el bestiario y construir lo que quieras. Tu partida continúa.</p>
    <p class="hint">Pixelterra · juego original hecho para GBA Web.</p>
  </div>`;
  drawMonInto($("#vic-boss"), "obsidion");
  checkQuests();
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

function makeWild() {
  const dist = Math.hypot(S.player.x - W / 2, S.player.y - H / 2);
  const lvl = clamp(Math.round(2 + dist / 11 + (rand() * 2 - 1) + (isNight() ? 2 : 0)), 2, 45);
  return makeMon(pick(wildPool()), lvl);
}

function startWildBattle(foe) {
  if (!leader()) return;
  foe = foe || makeWild();
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

async function battle(foe, opts = {}) {
  B.foe = foe;
  B.boss = !!opts.boss;
  B.ally = leader();
  $("#battle").hidden = false;
  $("#battle").classList.toggle("night", isNight());
  $("#battle").classList.toggle("boss", B.boss);
  drawMonInto($("#foe-sprite"), foe.sp);
  drawMonInto($("#ally-sprite"), B.ally.sp);
  $("#foe-sprite").className = "mon enter";
  $("#ally-sprite").className = "mon enter";
  renderCards();
  menu([]);
  vibrate(30);
  sfx("encounter");
  playTheme(B.boss ? "boss" : "battle");
  await say(B.boss ? `¡El ${SPECIES[foe.sp].name} despierta!` : `¡Un ${SPECIES[foe.sp].name} salvaje aparece!`, B.boss ? 1600 : 1100);
  await say(`¡Adelante, ${SPECIES[B.ally.sp].name}!`, 700);
  mainMenu();
}

function mainMenu() {
  $("#battle-msg").textContent = `¿Qué hará ${SPECIES[B.ally.sp].name}?`;
  const noCatch = B.boss ? "¡No se puede!" : null;
  menu([
    ["⚔️ Luchar", fightMenu],
    ["🧊 Cubo", () => throwCube("cubo"), noCatch || `Tienes ${count("cubo")}`, B.boss || !count("cubo")],
    ...(count("supercubo") && !B.boss ? [["💠 Supercubo", () => throwCube("supercubo"), `Tienes ${count("supercubo")}`]] : []),
    ["🧪 Poción", usePotionBattle, `Tienes ${count("pocion")}`, !count("pocion")],
    ["🐾 Cambiar", switchMenu, "", S.party.filter((m) => m.hp > 0).length < 2],
    ["🏃 Huir", runAway, noCatch || "", B.boss],
  ]);
}

function fightMenu() {
  const ally = B.ally;
  menu([
    ...ally.moves.map((id) => {
      const mv = MOVES[id];
      const eff = (EFFECT[mv.type] && EFFECT[mv.type][SPECIES[B.foe.sp].type]) || 1;
      const hint = eff > 1 ? " · ¡Eficaz!" : eff < 1 ? " · Poco eficaz" : "";
      return [`<span class="mv-dot" style="background:${TYPES[mv.type].color}"></span>${mv.name}`, () => turn({ kind: "move", id }), `${TYPES[mv.type].name} · Poder ${mv.pow}${hint}`];
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

function damage(att, def, moveId, noRandom) {
  const mv = MOVES[moveId];
  const as = statsOf(att), ds = statsOf(def);
  const stab = SPECIES[att.sp].type === mv.type ? 1.3 : 1;
  const eff = (EFFECT[mv.type] && EFFECT[mv.type][SPECIES[def.sp].type]) || 1;
  const crit = !noRandom && rand() < 0.06 ? 1.5 : 1;
  const base = (((2 * att.lvl) / 5 + 2) * mv.pow * (as.atk / ds.def)) / 50 + 2;
  return { dmg: Math.max(1, Math.floor(base * stab * eff * crit * (noRandom ? 0.92 : 0.85 + rand() * 0.15))), eff, crit };
}

function restartAnim(el, cls) {
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
}

function popDamage(el, text, color) {
  const d = document.createElement("div");
  d.className = "dmg";
  d.textContent = text;
  d.style.color = color;
  const r = el.getBoundingClientRect(), a = $("#battle").getBoundingClientRect();
  d.style.left = r.left - a.left + r.width / 2 + "px";
  d.style.top = r.top - a.top + r.height * 0.25 + "px";
  $("#battle").append(d);
  setTimeout(() => d.remove(), 900);
}

async function attack(att, def, moveId, defEl) {
  const mv = MOVES[moveId];
  const attEl = defEl.id === "foe-sprite" ? $("#ally-sprite") : $("#foe-sprite");
  await say(`¡${SPECIES[att.sp].name} usa ${mv.name}!`, 550);
  restartAnim(attEl, attEl.id === "ally-sprite" ? "lungeR" : "lungeL");
  await sleep(180);
  const { dmg, eff, crit } = damage(att, def, moveId);
  def.hp = Math.max(0, def.hp - dmg);
  defEl.style.setProperty("--fx", TYPES[mv.type].color);
  restartAnim(defEl, "hit");
  sfx(eff > 1 || crit > 1 ? "superHit" : "attack");
  popDamage(defEl, `-${dmg}`, eff > 1 ? "#ff5a3a" : "#fff");
  if (eff > 1 || crit > 1) restartAnim($("#battle"), "shake");
  vibrate(eff > 1 ? 40 : 20);
  renderCards();
  if (crit > 1) await say("¡Un golpe crítico!", 700);
  if (eff > 1) await say("¡Es muy eficaz!", 800);
  else if (eff < 1) await say("No es muy eficaz…", 800);
  else await sleep(350);
}

// El rival suele elegir el ataque que más daño hace (a veces se equivoca).
function enemyMove() {
  if (rand() < 0.3) return pick(B.foe.moves);
  return B.foe.moves.reduce((best, m) => (damage(B.foe, B.ally, m, true).dmg > damage(B.foe, B.ally, best, true).dmg ? m : best));
}

async function turn(action) {
  B.busy = true;
  menu([]);
  const ally = B.ally, foe = B.foe;
  if (action.kind === "switch") {
    B.ally = action.mon;
    drawMonInto($("#ally-sprite"), B.ally.sp);
    restartAnim($("#ally-sprite"), "enter");
    renderCards();
    await say(`¡Vuelve! ¡Adelante, ${SPECIES[B.ally.sp].name}!`);
    await attack(foe, B.ally, enemyMove(), $("#ally-sprite"));
  } else if (action.kind === "free") {
    await attack(foe, ally, enemyMove(), $("#ally-sprite"));
  } else {
    const foeMove = enemyMove();
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
    sfx("faint");
    restartAnim($("#foe-sprite"), "faint");
    await say(B.boss ? `¡El ${SPECIES[foe.sp].name} ha caído!` : `¡${SPECIES[foe.sp].name} salvaje se debilita!`);
    track("wins");
    await gainXp(foe);
    if (B.boss) {
      S.boss.defeated = true;
      endBattle();
      return showVictory();
    }
    return endBattle();
  }
  if (B.ally.hp <= 0) {
    sfx("faint");
    restartAnim($("#ally-sprite"), "faint");
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
    restartAnim($("#ally-sprite"), "enter");
    renderCards();
    await say(`¡Adelante, ${SPECIES[next.sp].name}!`);
  }
  B.busy = false;
  mainMenu();
}

async function gainXp(foe) {
  const mon = B.ally;
  const gain = Math.round((foe.lvl * 7 + 6) * (B.boss ? 3 : 1));
  mon.xp += gain;
  await say(`${SPECIES[mon.sp].name} gana ${gain} puntos de experiencia.`, 900);
  // Las demás criaturas del equipo aprenden un poco mirando.
  for (const other of S.party) if (other !== mon && other.hp > 0) other.xp += Math.floor(gain / 3);
  for (const m of S.party) {
    while (m.xp >= xpNeeded(m.lvl)) {
      m.xp -= xpNeeded(m.lvl);
      const before = statsOf(m).maxhp;
      m.lvl++;
      m.hp += statsOf(m).maxhp - before;
      if (m === mon) renderCards();
      sfx("levelUp");
      await say(`¡${SPECIES[m.sp].name} sube al nivel ${m.lvl}!`, 1000);
      for (const [l, mv] of SPECIES[m.sp].learn) {
        if (l === m.lvl && !m.moves.includes(mv)) {
          m.moves.push(mv);
          if (m.moves.length > 4) m.moves.shift();
          await say(`¡Ha aprendido ${MOVES[mv].name}!`, 1000);
        }
      }
    }
    await maybeEvolve(m);
  }
}

async function maybeEvolve(m) {
  const evo = SPECIES[m.sp].evo;
  if (!evo || m.lvl < evo.lvl) return;
  const from = SPECIES[m.sp].name;
  await say(`¿Eh? ¡${from} está evolucionando!`, 1200);
  const el = m === B.ally ? $("#ally-sprite") : null;
  if (el) restartAnim(el, "evolve");
  sfx("caught");
  await sleep(1200);
  const ratio = m.hp / statsOf(m).maxhp;
  m.sp = evo.to;
  m.hp = Math.max(1, Math.round(statsOf(m).maxhp * ratio));
  for (const [l, mv] of SPECIES[m.sp].learn) if (l <= m.lvl && !m.moves.includes(mv)) { m.moves.push(mv); if (m.moves.length > 4) m.moves.shift(); }
  S.seen[m.sp] = true;
  if (el) { drawMonInto(el, m.sp); renderCards(); }
  await say(`¡${from} ha evolucionado en ${SPECIES[m.sp].name}!`, 1500);
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
  el.className = "mon caught";
  sfx("shake");
  for (let i = 0; i < shakes; i++) { await say(["Se mueve…", "Se mueve otra vez…", "¡Casi!"][i], 650); sfx("shake"); vibrate(15); }
  if (shakes === 3) {
    vibrate([30, 60, 30]);
    sfx("caught");
    await say(`¡Has capturado a ${SPECIES[foe.sp].name}!`, 1300);
    const caught = { ...foe, xp: 0 };
    if (S.party.length < 6) S.party.push(caught);
    else { S.box.push(caught); await say("Tu equipo está lleno: se envía a la caja.", 1100); }
    track("caught");
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
  sfx("heal");
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
  playTheme(isNight() ? "night" : "day");
  renderHotbar();
  checkQuests();
  save();
}

/* ---------- Jefe final ---------- */

function challengeBoss() {
  if (S.boss.defeated) { sfx("click"); return toast("El altar está en calma. Pixelterra está a salvo. 🏆"); }
  const best = Math.max(...S.party.map((m) => m.lvl));
  if (best < 20) toast("⚠️ El Guardián es muy fuerte (Nv 30). Mejor ven con criaturas de nivel 25 o más.", 3500);
  setHeld(null);
  holdA = false;
  S.seen.obsidion = true;
  battle(makeMon("obsidion", 30), { boss: true });
}

function showVictory() {
  sfx("quest");
  setTimeout(() => sfx("caught"), 700);
  openPanel("victory");
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
  renderQuest();
  playTheme(isNight() ? "night" : "day");
}

/* ---------- Sin zoom del navegador; doble toque = zoom de la cámara ---------- */

// iOS ignora user-scalable=no: se bloquea a mano el doble toque y el pellizco.
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd < 350 && !e.target.closest(".panel-body, .intro-body, .battle-box")) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());

let lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener("pointerdown", (e) => {
  const now = performance.now();
  if (now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 45) {
    lastTap.t = 0;
    if (!modalOpen()) cycleZoom();
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});

addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
addEventListener("pagehide", save);

resize();
if (load()) start();
else showIntro();
requestAnimationFrame(loop);

window.pixelterra = { get state() { return S; }, tileAt, setTile, T, startWildBattle, save, roamers, B }; // para pruebas
