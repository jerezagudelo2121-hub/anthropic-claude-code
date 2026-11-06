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
const RUN_MS = 85;                       // tiempo por paso corriendo

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

/* Criaturas (el dibujo de cada una está en ART, más abajo). */
const SPECIES = {
  brasito: { name: "Brasito", type: "fuego", base: { hp: 45, atk: 56, def: 42, spd: 55 }, learn: [[1, "placaje"], [1, "ascuas"], [14, "llamarada"]], evo: { lvl: 16, to: "fogaro" } },
  gotin: { name: "Gotín", type: "agua", base: { hp: 52, atk: 46, def: 52, spd: 45 }, learn: [[1, "placaje"], [1, "burbuja"], [14, "torrente"]], evo: { lvl: 16, to: "marejo" } },
  brotin: { name: "Brotín", type: "planta", base: { hp: 50, atk: 48, def: 54, spd: 43 }, learn: [[1, "placaje"], [1, "hoja"], [14, "raices"]], evo: { lvl: 16, to: "arbolon" } },
  plumi: { name: "Plumi", type: "normal", base: { hp: 40, atk: 46, def: 36, spd: 70 }, learn: [[1, "picotazo"], [6, "aranazo"]] },
  musguito: { name: "Musguito", type: "planta", base: { hp: 44, atk: 42, def: 48, spd: 40 }, learn: [[1, "placaje"], [5, "hoja"], [18, "raices"]] },
  chispin: { name: "Chispín", type: "electrico", base: { hp: 38, atk: 52, def: 36, spd: 76 }, learn: [[1, "aranazo"], [3, "chispa"], [16, "trueno"]] },
  corali: { name: "Corali", type: "agua", base: { hp: 46, atk: 56, def: 62, spd: 32 }, learn: [[1, "aranazo"], [4, "burbuja"], [16, "torrente"]] },
  pedron: { name: "Pedrón", type: "roca", base: { hp: 56, atk: 56, def: 72, spd: 22 }, learn: [[1, "placaje"], [4, "pedrada"], [18, "avalancha"]] },
  topin: { name: "Topín", type: "roca", base: { hp: 46, atk: 52, def: 52, spd: 42 }, learn: [[1, "aranazo"], [6, "pedrada"], [20, "avalancha"]] },
  cenizo: { name: "Cenizo", type: "fuego", base: { hp: 48, atk: 60, def: 42, spd: 62 }, learn: [[1, "aranazo"], [4, "ascuas"], [16, "llamarada"]] },
  lumi: { name: "Lumi", type: "normal", base: { hp: 42, atk: 52, def: 42, spd: 66 }, learn: [[1, "destello"], [10, "placaje"]], night: true },
  voltibicho: { name: "Voltibicho", type: "electrico", base: { hp: 46, atk: 54, def: 48, spd: 56 }, learn: [[1, "placaje"], [5, "chispa"], [18, "trueno"]], night: true },
};
// Evoluciones de las tres iniciales (nivel 16) y el jefe final.
Object.assign(SPECIES, {
  fogaro: { name: "Fogaro", type: "fuego", base: { hp: 68, atk: 82, def: 62, spd: 78 }, learn: [[1, "aranazo"], [1, "ascuas"], [14, "llamarada"], [24, "magma"]] },
  marejo: { name: "Marejo", type: "agua", base: { hp: 78, atk: 66, def: 76, spd: 62 }, learn: [[1, "placaje"], [1, "burbuja"], [14, "torrente"]] },
  arbolon: { name: "Arbolón", type: "planta", base: { hp: 76, atk: 72, def: 82, spd: 52 }, learn: [[1, "placaje"], [1, "hoja"], [14, "raices"]] },
  obsidion: { name: "Guardián Obsidiano", type: "roca", boss: true, base: { hp: 120, atk: 80, def: 90, spd: 45 }, learn: [[1, "pedrada"], [1, "magma"], [1, "avalancha"], [1, "temblor"]] },
});
// Criaturas nuevas.
Object.assign(SPECIES, {
  hongui: { name: "Hongui", type: "planta", base: { hp: 55, atk: 50, def: 56, spd: 34 }, learn: [[1, "placaje"], [4, "hoja"], [17, "raices"]] },
  tortuli: { name: "Tortuli", type: "agua", base: { hp: 58, atk: 46, def: 66, spd: 30 }, learn: [[1, "placaje"], [3, "burbuja"], [18, "torrente"]] },
  polillux: { name: "Polillux", type: "electrico", base: { hp: 40, atk: 58, def: 38, spd: 74 }, learn: [[1, "aranazo"], [4, "chispa"], [10, "destello"], [17, "trueno"]], night: true },
  voltarin: { name: "Voltarín", type: "electrico", base: { hp: 62, atk: 80, def: 55, spd: 92 }, learn: [[1, "aranazo"], [1, "chispa"], [16, "trueno"], [22, "destello"]] },
});
SPECIES.chispin.evo = { lvl: 20, to: "voltarin" };

/* Dibujo de cada criatura: operaciones en una rejilla de 24×24 (admite medios), que se
 * pintan a 48×48 con volumen, contorno y brillos (ver rasterizeMon). Se dibujan en orden:
 * lo primero queda detrás.
 *   ["e", cx, cy, rx, ry, color]  elipse      ["r", x, y, w, h, color]  rectángulo
 *   ["t", x1, y1, x2, y2, x3, y3, color]  triángulo   ["o", x, y, color]  ojo */
const ART = {
  brasito: [["e", 6, 15, 3, 1.5, "#e0662a"], ["t", 1.5, 15, 3.5, 5, 6.5, 14, "#ffb02e"], ["t", 2.5, 14, 3.8, 7.5, 5.5, 13.5, "#fff1a1"], ["e", 4, 6.5, 1.5, 2, "#ff5a1f"],
    ["r", 8, 18, 3, 4, "#d4541f"], ["e", 11.5, 15, 5.5, 5, "#ff8a3d"], ["e", 12, 17, 3, 2.5, "#ffd9a0"], ["r", 14, 18.5, 3, 3.5, "#e0662a"], ["r", 14, 21.5, 3.5, 1, "#fff3e0"],
    ["t", 13, 7, 14, 2.5, 16, 6, "#ff8a3d"], ["e", 16, 9.5, 4.5, 4, "#ff8a3d"], ["e", 19, 11, 2, 1.5, "#ffb27a"], ["r", 18.5, 12.5, 2, 0.5, "#8a2a10"], ["o", 17, 8, "#1b1b1b"]],
  fogaro: [["e", 5, 17, 3, 1.5, "#c84a1a"], ["t", 0.5, 18, 3, 6, 6, 16, "#ffb02e"], ["t", 1.5, 16.5, 3.2, 9, 5, 15.5, "#fff1a1"], ["r", 7, 19, 4, 4, "#b8401a"],
    ["r", 4, 11, 3, 6, "#e85a20"], ["e", 12, 15, 7, 7, "#ff6a2a"], ["e", 12, 17, 4, 4.5, "#ffd9a0"], ["e", 8.5, 12.5, 1, 1.5, "#ffcc33"], ["r", 13.5, 19, 4, 4, "#d4541f"], ["r", 13.5, 22.5, 4, 1, "#fff3e0"],
    ["t", 10, 5, 10.5, 0, 13, 4, "#ffcc33"], ["t", 15, 4, 17.5, -0.5, 18.5, 4.5, "#ffcc33"], ["e", 14, 7, 5.5, 4.5, "#ff6a2a"], ["r", 18, 10, 3, 6, "#ff6a2a"], ["r", 18, 15, 3, 1, "#fff3e0"],
    ["e", 18, 8.5, 2.5, 1.8, "#ffb27a"], ["r", 17, 10, 3, 0.5, "#8a2a10"], ["o", 12, 6, "#1b1b1b"], ["o", 16, 6, "#1b1b1b"]],
  gotin: [["e", 5, 17, 2, 1.2, "#3f9de8"], ["e", 19, 17, 2, 1.2, "#3f9de8"], ["t", 12, 1.5, 5, 13, 19, 13, "#5ab8ff"], ["e", 12, 15, 7, 6, "#5ab8ff"], ["e", 12, 17.5, 4, 2.5, "#bfe6ff"],
    ["e", 9, 10, 1.2, 2.2, "#e8f7ff"], ["o", 9, 14, "#123"], ["o", 14, 14, "#123"], ["r", 11, 16.5, 2.5, 0.5, "#2a5f99"], ["e", 7.5, 16, 1, 0.6, "#ff9aa2"], ["e", 16, 16, 1, 0.6, "#ff9aa2"]],
  marejo: [["t", 1, 17, 6, 11, 7, 19, "#2a6fb5"], ["t", 23, 17, 18, 11, 17, 19, "#2a6fb5"], ["t", 8, 9, 12, 1, 16, 9, "#5ab8ff"], ["e", 12, 15, 9, 7, "#3f9de8"], ["e", 12, 18, 6, 3.5, "#c4e8ff"],
    ["e", 7, 7.5, 2, 2, "#e8f7ff"], ["e", 17, 6, 2, 2, "#e8f7ff"], ["e", 5, 20, 2.5, 1.2, "#2a6fb5"], ["e", 19, 20, 2.5, 1.2, "#2a6fb5"], ["e", 12, 14, 3, 1.8, "#a8dcff"],
    ["o", 8, 11, "#0d2a4a"], ["o", 15, 11, "#0d2a4a"], ["r", 11, 15, 2.5, 0.5, "#1d4f80"]],
  brotin: [["r", 11.5, 6, 1, 5, "#3f8a3a"], ["t", 12, 8, 3.5, 3, 9, 10.5, "#3fae46"], ["t", 12, 8, 20.5, 3, 15, 10.5, "#56c45a"], ["r", 6.5, 19, 3, 3, "#4f9a42"], ["r", 14.5, 19, 3, 3, "#4f9a42"],
    ["e", 12, 15.5, 6.5, 5.5, "#7fd36b"], ["e", 12, 17.5, 3.5, 2.2, "#c8f0a8"], ["e", 9, 12, 1.3, 0.8, "#b8f09a"], ["o", 9, 14, "#132"], ["o", 14, 14, "#132"],
    ["e", 7.5, 16.5, 1, 0.6, "#ff9aa2"], ["e", 16.5, 16.5, 1, 0.6, "#ff9aa2"], ["r", 11, 17, 2, 0.5, "#2f6a2a"]],
  arbolon: [["r", 2, 12, 5, 2, "#7a4f2a"], ["r", 17, 12, 5, 2, "#7a4f2a"], ["e", 2, 11, 1.5, 1.5, "#62c56a"], ["e", 22, 11, 1.5, 1.5, "#62c56a"], ["r", 7, 9, 10, 13, "#7a4f2a"],
    ["r", 8.5, 10, 1, 11, "#8f6136"], ["r", 14, 14, 1, 7, "#5f3c1e"], ["e", 12, 6, 10, 5.5, "#3f9e45"], ["e", 7, 4, 3.5, 2.5, "#56b85a"], ["e", 16.5, 3.5, 3.5, 2.5, "#56b85a"],
    ["e", 12, 2.5, 3, 1.5, "#72d26e"], ["e", 9, 8, 1, 0.8, "#ff7a8a"], ["e", 17, 8, 1, 0.8, "#ffd23f"], ["r", 7, 21, 4, 2, "#5a3a1e"], ["r", 13, 21, 4, 2, "#5a3a1e"],
    ["e", 9.5, 13, 1.2, 1.2, "#3a2510"], ["e", 14.5, 13, 1.2, 1.2, "#3a2510"], ["o", 9, 12.5, "#ffe14a"], ["o", 14, 12.5, "#ffe14a"], ["r", 10, 17, 4, 1, "#3a2510"]],
  plumi: [["t", 2, 13, 8, 14, 6, 17, "#c9c2b0"], ["r", 10, 19.5, 1, 3, "#ffb02e"], ["r", 13, 19.5, 1, 3, "#ffb02e"], ["e", 12, 14.5, 6, 5.5, "#f2efe6"], ["e", 9, 15.5, 3.5, 3, "#d8d2c2"],
    ["e", 9, 16.5, 2.5, 1.5, "#c2baa6"], ["t", 13, 7, 14, 2.5, 16, 6.5, "#e74c3c"], ["t", 15, 6.5, 17.5, 3, 17, 7, "#ff6a5a"], ["e", 15, 9.5, 4, 3.5, "#f2efe6"],
    ["t", 18.5, 9, 22, 10.3, 18.5, 11.5, "#ffb02e"], ["e", 17, 12, 1, 1.2, "#e74c3c"], ["o", 16, 8, "#1b1b1b"], ["e", 14, 11, 1, 0.6, "#ffc2c2"]],
  musguito: [["r", 6, 19, 2, 2.5, "#3b5a24"], ["r", 11, 19.5, 2, 2.5, "#3b5a24"], ["r", 16, 19, 2, 2.5, "#3b5a24"], ["e", 12, 15.5, 8.5, 5, "#5f8f3a"], ["e", 12, 13, 6, 2.5, "#77a84a"],
    ["e", 8, 12.5, 2.5, 1.5, "#8fd16b"], ["e", 15, 12, 2.5, 1.5, "#8fd16b"], ["e", 12, 11, 1.5, 1, "#a8e07a"], ["e", 5, 15, 1, 0.8, "#ff9ad5"],
    ["e", 19.5, 16, 3, 2.5, "#6b8f3a"], ["r", 19, 9.5, 0.5, 4, "#3b5a24"], ["e", 19, 9, 1, 1, "#ffd23f"], ["o", 20, 15, "#111"], ["r", 21, 17, 1.5, 0.5, "#2b4018"]],
  chispin: [["t", 2, 17, 5, 12, 8, 17, "#c99500"], ["t", 3, 14, 8, 6, 10, 14, "#e0a800"], ["t", 7, 10, 11, 2, 14, 10, "#e0a800"], ["t", 12, 9, 17, 3, 18, 11, "#e0a800"],
    ["r", 8, 18.5, 2, 3, "#b88a00"], ["e", 12, 15, 7, 5, "#ffe14a"], ["e", 13, 17, 3.5, 2, "#fff6b8"], ["r", 14, 18.5, 2, 3, "#c99500"], ["e", 18, 12.5, 3.5, 3, "#ffe14a"],
    ["o", 18, 11, "#222"], ["e", 19.5, 14, 1.2, 0.8, "#4aa8ff"], ["r", 20.5, 13, 1, 0.5, "#222"]],
  voltarin: [["t", 1, 12, 6, 8, 5, 14, "#ffe14a"], ["t", 3, 13, 7, 13, 2, 18, "#ffe14a"], ["t", 6, 11, 9, 4, 12, 11, "#e0a800"], ["t", 10, 10, 13, 2, 16, 10, "#e0a800"],
    ["r", 7, 18, 2.5, 4, "#b88a00"], ["e", 11.5, 14.5, 6.5, 4.5, "#ffe14a"], ["e", 12, 16.5, 4, 2, "#fff6b8"], ["r", 9, 11, 1, 3, "#3d4bd9"], ["r", 12, 10.5, 1, 3, "#3d4bd9"],
    ["r", 15, 18, 2.5, 4, "#c99500"], ["t", 15, 8, 15.5, 3, 18, 7, "#ffe14a"], ["t", 19, 7, 21.5, 3, 21.5, 8.5, "#ffe14a"], ["e", 18, 10, 4, 3.5, "#ffe14a"],
    ["e", 21, 11.5, 2, 1.3, "#fff6b8"], ["o", 18, 9, "#222"], ["e", 19, 12.5, 1, 0.8, "#4aa8ff"]],
  corali: [["r", 5, 19, 1, 3, "#b3443a"], ["r", 8, 19.5, 1, 3, "#b3443a"], ["r", 15, 19.5, 1, 3, "#b3443a"], ["r", 18, 19, 1, 3, "#b3443a"], ["r", 6, 13, 2, 1.5, "#e05a4a"], ["r", 16, 13, 2, 1.5, "#e05a4a"],
    ["e", 3.5, 12, 3, 2.5, "#ff7b6b"], ["r", 1, 11.5, 3, 0.5, "#b3443a"], ["e", 20.5, 12, 3, 2.5, "#ff7b6b"], ["r", 20, 11.5, 3, 0.5, "#b3443a"],
    ["r", 9, 8.5, 1, 4, "#b3443a"], ["r", 14, 8.5, 1, 4, "#b3443a"], ["e", 12, 16, 7, 4.5, "#ff7b6b"], ["e", 12, 14.5, 5, 2, "#ffa395"], ["e", 9, 16, 0.8, 0.8, "#ffd0c8"], ["e", 15, 17, 0.8, 0.8, "#ffd0c8"],
    ["e", 9, 8, 1, 1, "#f2f2f2"], ["e", 14, 8, 1, 1, "#f2f2f2"], ["o", 9, 8, "#111"], ["o", 14, 8, "#111"], ["r", 11, 18, 2.5, 0.5, "#8a2a22"]],
  pedron: [["r", 2.5, 11, 3.5, 7, "#8a8a8a"], ["r", 18, 11, 3.5, 7, "#8a8a8a"], ["e", 4, 18.5, 2, 1.5, "#7a7a7a"], ["e", 20, 18.5, 2, 1.5, "#7a7a7a"], ["r", 7, 20, 3.5, 2.5, "#6e6e6e"], ["r", 13.5, 20, 3.5, 2.5, "#6e6e6e"],
    ["r", 6, 8, 12, 13, "#9a9a9a"], ["e", 12, 8, 6.5, 3.5, "#a9a9a9"], ["e", 9, 15, 1.5, 1.2, "#8a8a8a"], ["e", 15, 17, 1.8, 1.2, "#8a8a8a"], ["e", 15, 5.5, 1.5, 0.8, "#6fa858"],
    ["r", 8.5, 9.5, 7, 2, "#3a3a40"], ["o", 10, 10, "#5ff2e0"], ["o", 13, 10, "#5ff2e0"]],
  topin: [["e", 4.5, 18, 2.5, 1.5, "#e8d6b0"], ["e", 19.5, 18, 2.5, 1.5, "#e8d6b0"], ["e", 12, 15.5, 7, 6, "#8b5e3c"], ["e", 12, 18, 4.5, 3, "#c9a67a"],
    ["e", 12, 9, 4, 2, "#ffd23f"], ["r", 8, 10, 8, 1, "#e0a800"], ["e", 12, 8, 1, 1, "#fff6b8"], ["e", 12, 15, 1.6, 1.2, "#ff9a8a"],
    ["o", 9, 12, "#111"], ["o", 14, 12, "#111"], ["r", 6.5, 15, 2.5, 0.5, "#4a3020"], ["r", 15, 15, 2.5, 0.5, "#4a3020"]],
  cenizo: [["e", 5, 13, 3.5, 5, "#ff7a2e"], ["e", 4, 8.5, 2.5, 2.5, "#ffd27a"], ["r", 8, 18.5, 2, 3.5, "#5f646e"], ["e", 12, 16, 5.5, 4, "#7a7f8a"], ["e", 10, 14.5, 0.8, 0.8, "#ff7a2e"],
    ["r", 14, 18.5, 2, 3.5, "#6a6f7a"], ["e", 15, 15, 2.5, 2.5, "#c9ccd4"], ["t", 12, 8, 12.5, 2.5, 15, 7, "#7a7f8a"], ["t", 16, 7, 18.5, 2.5, 19, 8.5, "#7a7f8a"],
    ["e", 15.5, 10, 4, 3.5, "#7a7f8a"], ["t", 13, 7, 13.2, 4, 14.5, 6.8, "#ff7a2e"], ["e", 19, 11.5, 2.2, 1.4, "#c9ccd4"], ["e", 21, 11, 0.6, 0.6, "#222"],
    ["o", 14, 9, "#ff7a2e"], ["o", 17, 9, "#ff7a2e"]],
  lumi: [["e", 12, 12, 8.5, 8.5, "#fff3b055"], ["r", 11.5, 3.5, 0.5, 3, "#fff3b0"], ["e", 11.5, 3, 1, 1, "#ffffff"], ["t", 9, 16, 15, 16, 12, 23, "#fff3b0"],
    ["e", 12, 12, 5, 6, "#fff3b0"], ["e", 12, 13.5, 3, 3, "#fffbe0"], ["o", 10, 11, "#3a2f00"], ["o", 13, 11, "#3a2f00"],
    ["r", 3, 4, 1, 1, "#ffffff"], ["r", 20, 6, 1, 1, "#ffffff"], ["r", 19, 19, 1, 1, "#ffffff"], ["r", 5, 18, 1, 1, "#ffe9a0"]],
  voltibicho: [["t", 12, 2, 10, 10, 14, 10, "#ffe14a"], ["r", 6, 19, 1.5, 3, "#1f2a8a"], ["r", 11, 20, 1.5, 2.5, "#1f2a8a"], ["r", 16, 19, 1.5, 3, "#1f2a8a"], ["e", 12, 15, 7.5, 5.5, "#3d4bd9"],
    ["r", 11.5, 10, 1, 10, "#1f2a8a"], ["e", 8.5, 12.5, 2, 1, "#7a86ff"], ["e", 15.5, 12.5, 2, 1, "#7a86ff"], ["e", 9, 15, 1, 1, "#ffe14a"], ["e", 15, 16, 1, 1, "#ffe14a"], ["e", 10, 18, 0.7, 0.7, "#ffe14a"],
    ["o", 8, 17, "#fff"], ["o", 15, 17, "#fff"]],
  hongui: [["r", 7.5, 20, 3, 2, "#c9b89a"], ["r", 13.5, 20, 3, 2, "#c9b89a"], ["e", 12, 15.5, 5, 5, "#f2e6cf"], ["e", 12, 13, 7, 1.5, "#e3cfa8"], ["e", 12, 9, 9, 5, "#d9433a"],
    ["e", 8, 7, 1.5, 1.2, "#fff4e8"], ["e", 14, 5.5, 1.8, 1.2, "#fff4e8"], ["e", 17, 9, 1.2, 1, "#fff4e8"], ["e", 10, 10, 1, 0.8, "#fff4e8"],
    ["o", 10, 15, "#2a1a10"], ["o", 13, 15, "#2a1a10"], ["e", 8.5, 17, 0.9, 0.6, "#ff9aa2"], ["e", 15.5, 17, 0.9, 0.6, "#ff9aa2"], ["r", 11, 17.5, 2, 0.5, "#5a3020"]],
  tortuli: [["t", 2, 16, 5, 15, 5, 17, "#3fa08a"], ["e", 6, 19, 2, 1.5, "#3fa08a"], ["e", 17, 19.5, 2, 1.5, "#3fa08a"], ["e", 11, 18, 7.5, 1.5, "#e0c88a"], ["t", 9, 9, 11, 6, 13, 9.5, "#9fd6ff"],
    ["e", 11, 14, 7.5, 5.5, "#2a6fb5"], ["e", 8, 13, 2, 1.5, "#4a8fd6"], ["e", 13, 12, 2, 1.5, "#4a8fd6"], ["e", 11, 16, 2.5, 1.2, "#4a8fd6"],
    ["e", 19, 12, 3, 2.7, "#5cc4a8"], ["o", 20, 11, "#102"], ["r", 20.5, 13.5, 1.5, 0.5, "#2a6050"]],
  polillux: [["t", 12, 14, 4, 20, 9, 21, "#e0a800"], ["t", 12, 14, 20, 20, 15, 21, "#e0a800"], ["t", 12, 12, 1, 3, 3, 16, "#ffe14a"], ["t", 12, 12, 23, 3, 21, 16, "#ffe14a"],
    ["e", 6, 8, 1.5, 1.5, "#4aa8ff"], ["e", 18, 8, 1.5, 1.5, "#4aa8ff"], ["t", 10.5, 8.5, 8, 3, 10, 8, "#5a4a8a"], ["t", 13.5, 8.5, 16, 3, 14, 8, "#5a4a8a"],
    ["e", 12, 14, 2.5, 6, "#5a4a8a"], ["e", 12, 10, 3, 2, "#e8e0ff"], ["o", 10, 10, "#111"], ["o", 13, 10, "#111"]],
  obsidion: [["r", 1, 9, 3.5, 9, "#3a2f55"], ["r", 19.5, 9, 3.5, 9, "#3a2f55"], ["e", 2.5, 18.5, 2.5, 2, "#2b2240"], ["e", 21.5, 18.5, 2.5, 2, "#2b2240"], ["r", 5, 21, 4, 2, "#1d1630"], ["r", 15, 21, 4, 2, "#1d1630"],
    ["r", 4, 6, 16, 15, "#2b2240"], ["t", 5, 5, 7, -0.5, 9, 5, "#8a7aa8"], ["t", 15, 5, 17, -0.5, 19, 5, "#8a7aa8"], ["e", 12, 6, 6.5, 4, "#3a2f55"],
    ["t", 6, 8, 7, 3, 8.5, 8, "#b48cff"], ["t", 17, 9, 18, 4, 19.5, 9, "#b48cff"], ["r", 8, 10, 1, 6, "#ff7a2e"], ["r", 15, 12, 1, 5, "#ff7a2e"], ["r", 11, 17, 3, 1, "#ff7a2e"], ["r", 9, 15, 3, 1, "#ffb02e"],
    ["e", 12, 12, 1.5, 1.5, "#ff3a3a"], ["o", 10, 6, "#ff3a3a"], ["o", 13, 6, "#ff3a3a"]],
};
for (const sp in ART) SPECIES[sp].art = ART[sp];

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

/* Criaturas a 48×48 con volumen: cada forma se sombrea según su relieve (luz arriba a la
 * izquierda) en 4 tonos, con brillo en los ojos, líneas interiores y contorno del color de
 * cada parte (más oscuro), en lugar de un contorno negro plano. */
function parseColor(c) {
  let h = c.slice(1);
  if (h.length <= 4) h = [...h].map((d) => d + d).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [n >> 16, (n >> 8) & 255, n & 255, h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255];
}
const shadeCol = ([r, g, b, a], k) => k >= 0
  ? [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k * 0.85, a]
  // Las sombras tiran un poco hacia el violeta, como en el pixel art clásico.
  : [r * (1 + k), g * (1 + k * 1.08), b * (1 + k * 0.82), a];

function rasterizeMon(ops, back) {
  const N = 48, col = new Array(N * N).fill(null), lit = new Float32Array(N * N), id = new Int16Array(N * N).fill(-1);
  const put = (x, y, c, l, i) => { if (x >= 0 && y >= 0 && x < N && y < N) { const k = y * N + x; col[k] = c; lit[k] = l; id[k] = i; } };
  const sign = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);
  // Vista de espalda: sin ojos ni detalles pequeños de la cara.
  if (back) ops = ops.filter((op) => op[0] !== "o" && !(op[0] === "r" && op[3] * op[4] <= 3) && !(op[0] === "e" && op[3] * op[4] <= 1.2));
  ops.forEach((op, i) => {
    const c = parseColor(op[op.length - 1]);
    if (op[0] === "e") {
      const cx = (op[1] + 0.5) * 2, cy = (op[2] + 0.5) * 2, rx = (op[3] + 0.5) * 2, ry = (op[4] + 0.5) * 2;
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const nz = Math.sqrt(1 - d2);
        put(x, y, c, -0.5 * dx - 0.62 * dy + 0.6 * nz, i);
      }
    } else if (op[0] === "r") {
      const X = op[1] * 2, Y = op[2] * 2, w = op[3] * 2, h = op[4] * 2;
      for (let y = Y; y < Y + h; y++) for (let x = X; x < X + w; x++) {
        const u = (x - X + 0.5) / w, v = (y - Y + 0.5) / h;
        let l = 0.5 + (0.5 - v) * 0.35;
        if (y - Y < 2 && h > 3) l += 0.3;
        if (x - X < 1 && w > 3) l += 0.12;
        if (Y + h - y <= 2 && h > 3) l -= 0.35;
        if (X + w - x <= 1 && w > 3) l -= 0.2;
        put(x, y, c, l, i);
      }
    } else if (op[0] === "t") {
      const P = [op[1], op[2], op[3], op[4], op[5], op[6]].map((v) => v * 2 + 1);
      const ys = [P[1], P[3], P[5]], top = Math.min(...ys), bot = Math.max(...ys);
      for (let y = Math.floor(top); y <= bot; y++) for (let x = Math.floor(Math.min(P[0], P[2], P[4])); x <= Math.max(P[0], P[2], P[4]); x++) {
        const px = x + 0.5, py = y + 0.5;
        const d1 = sign(px, py, P[0], P[1], P[2], P[3]), d2 = sign(px, py, P[2], P[3], P[4], P[5]), d3 = sign(px, py, P[4], P[5], P[0], P[1]);
        if (((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0))) continue;
        put(x, y, c, 0.72 - ((py - top) / Math.max(1, bot - top)) * 0.5, i);
      }
    } else if (op[0] === "o") {
      // Ojo grande (3×4): pupila, brillo blanco arriba y reflejo abajo; si brilla, centro blanco.
      const x = Math.round(op[1] * 2), y = Math.round(op[2] * 2) - 1, dark = c[0] + c[1] + c[2] < 330;
      for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 3; xx++) put(x + xx, y + yy, c, 0.5, 1000 + i);
      if (dark) {
        put(x, y, [255, 255, 255, 255], 0.5, 1000 + i);
        put(x, y + 1, [255, 255, 255, 255], 0.5, 1000 + i);
        put(x + 1, y + 3, shadeCol(c, 0.45), 0.5, 1000 + i);
      } else {
        put(x + 1, y + 1, [255, 255, 255, 255], 0.5, 1000 + i);
        put(x + 1, y + 2, shadeCol(c, 0.5), 0.5, 1000 + i);
      }
    }
  });
  const out = new Uint8ClampedArray(N * N * 4);
  const at = (x, y) => (x >= 0 && y >= 0 && x < N && y < N ? y * N + x : -1);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x;
    let c = col[k];
    if (c) {
      if (id[k] < 1000) {
        const l = lit[k];
        c = l > 0.66 ? shadeCol(c, 0.3) : l > 0.3 ? c : l > 0.06 ? shadeCol(c, -0.22) : shadeCol(c, -0.4);
        // Línea interior: donde una parte queda por delante de otra.
        for (const n of [at(x, y - 1), at(x - 1, y), at(x + 1, y), at(x, y + 1)]) {
          if (n >= 0 && col[n] && id[n] > id[k] && id[n] < 1000 && (Math.abs(col[n][0] - col[k][0]) + Math.abs(col[n][1] - col[k][1]) + Math.abs(col[n][2] - col[k][2])) > 60) {
            c = shadeCol(col[k], -0.5);
            break;
          }
        }
      }
    } else {
      // Contorno: el color de la parte vecina, muy oscurecido.
      let nb = null;
      for (const n of [at(x, y + 1), at(x + 1, y), at(x - 1, y), at(x, y - 1)]) if (n >= 0 && col[n] && col[n][3] > 200) { nb = col[n]; break; }
      if (!nb) continue;
      c = shadeCol(nb, -0.72);
      c = [c[0] * 0.8 + 6, c[1] * 0.8 + 4, c[2] * 0.8 + 14, 255];
    }
    out.set([c[0], c[1], c[2], c[3]], k * 4);
  }
  const cv = document.createElement("canvas");
  cv.width = cv.height = N;
  cv.getContext("2d").putImageData(new ImageData(out, N, N), 0, 0);
  return cv;
}

const monArt = {};
function monCanvas(sp, back) {
  const key = sp + (back ? "-b" : "");
  if (!monArt[key]) monArt[key] = rasterizeMon(SPECIES[sp].art, back);
  return monArt[key];
}

function drawMonInto(canvas, sp, back) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(monCanvas(sp, back), 0, 0, canvas.width, canvas.height);
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

/* Texturas de bloque al estilo "cubos": cada píxel de la casilla tiene su tono (ruido),
 * con pequeños grupos del mismo color, y los bloques sólidos llevan bisel (luz arriba e
 * izquierda, sombra abajo y derecha) para que se lean como cubos. */
function noiseFill(px, r, pal, x0 = 0, y0 = 0, w = TS, h = TS, clump = 0.35) {
  const row = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const above = row[(y - 1) * TS + x], left = row[y * TS + x - 1];
    let c;
    if (left && x > x0 && r() < clump) c = left;
    else if (above && y > y0 && r() < clump * 0.6) c = above;
    else c = pal[Math.floor(Math.pow(r(), 1.3) * pal.length)];
    row[y * TS + x] = c;
    px(x, y, c);
  }
}
function bevel(px, hi, lo) {
  px(0, 0, hi, TS, 1); px(0, 0, hi, 1, TS);
  px(0, TS - 1, lo, TS, 1); px(TS - 1, 0, lo, 1, TS);
}
const STONE_PAL = ["#8a8a8a", "#7e7e7e", "#959595", "#747474", "#9e9e9e", "#6a6a6a"];
function stoneBase(px, r) {
  noiseFill(px, r, STONE_PAL);
  // Manchas más oscuras, como en la piedra de verdad.
  for (let i = 0; i < 4; i++) {
    const x = 1 + Math.floor(r() * 12), y = 1 + Math.floor(r() * 12);
    px(x, y, "#666", 2 + Math.floor(r() * 2), 1); px(x + 1, y + 1, "#5e5e5e", 1 + Math.floor(r() * 2), 1);
  }
  bevel(px, "#b4b4b4", "#4e4e4e");
}
function ore(px, r, cols) {
  stoneBase(px, r);
  // Vetas: grupos de 3–5 píxeles con brillo y sombra.
  const spots = [[3, 3], [9, 2], [5, 8], [11, 9], [2, 12], [8, 12]].sort(() => r() - 0.5).slice(0, 4);
  for (const [sx, sy] of spots) {
    const x = sx + Math.floor(r() * 2), y = sy + Math.floor(r() * 2);
    px(x, y, cols[0], 2, 2); px(x + 2, y + 1, cols[0]); px(x - 1, y + 1, cols[2]);
    px(x, y, cols[1]); px(x + 1, y + 2, cols[2], 2, 1);
  }
}
const GRASS_PAL = ["#5ba33d", "#64ad44", "#6fba4c", "#54983a", "#4b8d34", "#78c255"];
const grassTile = (seed, extra) => makeTile((px, r) => { noiseFill(px, r, GRASS_PAL, 0, 0, TS, TS, 0.3); if (extra) extra(px, r); }, seed);

const TILE_ART = {
  [T.WATER]: [0, 1].map((f) => makeTile((px, r) => {
    noiseFill(px, r, ["#2f63d4", "#3369da", "#2c5ccb", "#3a72e2", "#295ac4"], 0, 0, TS, TS, 0.5);
    for (let i = 0; i < 4; i++) { const y = 1 + i * 4, x = (f * 3 + i * 6) % 13; px(x, y, "#6f9cf0", 3, 1); px(x + 1, y, "#a6c6ff", 1, 1); }
  }, 11 + f)),
  [T.DEEP]: [0, 1].map((f) => makeTile((px, r) => {
    noiseFill(px, r, ["#24489e", "#284fa8", "#213f8f", "#2c56b2"], 0, 0, TS, TS, 0.5);
    for (let i = 0; i < 2; i++) { const y = 4 + i * 7, x = (f * 5 + i * 7) % 12; px(x, y, "#4a76d0", 3, 1); }
  }, 21 + f)),
  [T.SAND]: [makeTile((px, r) => noiseFill(px, r, ["#dccf8f", "#e3d79c", "#d3c482", "#e9dea8", "#cbbb76"]), 3)],
  [T.GRASS]: [grassTile(4)],
  [T.TALL]: [makeTile((px, r) => {
    // Matas de hierba alta (fondo transparente: se pinta sobre el césped).
    for (let i = 0; i < 7; i++) {
      const x = 1 + ((i * 5 + 2) % 14), h = 6 + Math.floor(r() * 5), y = 15 - h;
      px(x, y + 1, "#3f8a2a", 1, h); px(x + 1, y + 3, "#2f6e20", 1, h - 3); px(x, y, "#8fdc6a"); px(x - 1, y + 2, "#5aad3a", 1, 2);
    }
  }, 5)],
  [T.TREE]: [makeTile((px, r) => {
    // Icono: tronco visto de cerca.
    noiseFill(px, r, ["#6b4a2b", "#5c3f24", "#7a5532", "#4f361f"]);
    for (let x = 2; x < TS; x += 4) px(x, 0, "#3e2a17", 1, TS);
    px(0, 0, "#a07a46", TS, 3); noiseFill(px, r, ["#b8915a", "#a8814c", "#c49d64"], 1, 0, 14, 2);
  }, 6)],
  [T.STONE]: [makeTile((px, r) => stoneBase(px, r), 7)],
  [T.COAL]: [makeTile((px, r) => ore(px, r, ["#2b2b2b", "#4a4a4a", "#161616"]), 8)],
  [T.IRON]: [makeTile((px, r) => ore(px, r, ["#d8af93", "#f0d2bc", "#a07a62"]), 9)],
  [T.GEM]: [makeTile((px, r) => ore(px, r, ["#4ee6d8", "#d0fffa", "#1d9c92"]), 10)],
  [T.FLOWER]: [grassTile(12, (px) => {
    for (const [x, y, c, d] of [[3, 4, "#ff4d5e", "#c22a3a"], [11, 3, "#ffd23f", "#d89b00"], [6, 11, "#ffffff", "#c8c8d8"], [12, 11, "#5ab0ff", "#2f6fd0"]]) {
      px(x, y + 1, "#2f6e20", 1, 3); px(x - 1, y, c, 3, 1); px(x, y - 1, c, 1, 3); px(x + 1, y, d); px(x, y + 1, d); px(x, y, "#fff1a1");
    }
  })],
  [T.PLANKS]: [makeTile((px, r) => {
    noiseFill(px, r, ["#a8824c", "#b48d56", "#9c7742", "#bd965e"], 0, 0, TS, TS, 0.75);
    for (let y = 0; y < TS; y += 4) { px(0, y + 3, "#6e5130", TS, 1); px(0, y, "#c9a46a", TS, 1); }
    for (const [x, y] of [[5, 0], [12, 4], [3, 8], [10, 12]]) px(x, y, "#6e5130", 1, 3);
    for (const [x, y] of [[1, 1], [14, 5], [7, 9], [1, 13]]) px(x, y, "#5a4126");
  }, 13)],
  [T.BRICK]: [makeTile((px, r) => {
    px(0, 0, "#b5ab9c", TS, TS);
    for (let row = 0; row < 4; row++) {
      const o = row % 2 ? 4 : 0;
      for (let bx = -o; bx < TS; bx += 8) {
        const base = ["#a4503c", "#984a37", "#ad5a44"][Math.floor(r() * 3)];
        const x = Math.max(0, bx + 1), w = Math.min(TS, bx + 8) - x;
        if (w <= 0) continue;
        noiseFill(px, r, [base, base, "#8e4231", "#b8644d"], x, row * 4, w, 3, 0.6);
        px(x, row * 4, "#c2705a", w, 1);
      }
    }
  }, 14)],
  [T.BENCH]: [makeTile((px, r) => {
    // Banco de trabajo visto desde arriba: tablero con cuadrícula y herramientas.
    noiseFill(px, r, ["#a8824c", "#b48d56", "#9c7742"], 0, 0, TS, TS, 0.75);
    px(0, 0, "#6e5130", TS, 1); px(0, TS - 1, "#4a3620", TS, 1); px(0, 0, "#6e5130", 1, TS); px(TS - 1, 0, "#4a3620", 1, TS);
    px(2, 2, "#c9a46a", 12, 12);
    for (let k = 2; k <= 14; k += 4) { px(k, 2, "#7a5a35", 1, 12); px(2, k, "#7a5a35", 12, 1); }
    px(3, 3, "#9a9a9a", 3, 1); px(4, 4, "#6e5130", 1, 2);       // martillo
    px(11, 11, "#d0d0d0", 2, 2); px(10, 10, "#6e5130");         // sierra
  }, 15)],
  [T.FIRE]: [0, 1].map((f) => makeTile((px, r) => {
    noiseFill(px, r, ["#7a5a3a", "#6e5034", "#86653f", "#5e452c"]);
    px(2, 11, "#5a3e24", 12, 3); px(3, 10, "#7a5532", 10, 1); px(2, 12, "#3e2a17", 12, 1);
    const h = f ? 9 : 8;
    px(4, 12 - h + 2, "#e8541a", 8, h - 1); px(5, 12 - h, "#ff9a1f", 6, h - 1); px(6, 12 - h + 2, "#ffd84a", 4, h - 4); px(7, 12 - h + 4, "#fff6c8", 2, h - 7);
  }, 16 + f)),
  [T.DIRT]: [makeTile((px, r) => { noiseFill(px, r, ["#8b6342", "#7a5638", "#96704c", "#6e4c31", "#a07a55"]); px(4, 9, "#8a8a8a"); px(12, 3, "#7a7a7a"); }, 18)],
  [T.ALTAR]: [0, 1].map((f) => makeTile((px, r) => {
    noiseFill(px, r, ["#2b2240", "#231b36", "#352a4f", "#1d1630"]);
    bevel(px, "#4a3d6e", "#120d1e");
    px(3, 3, "#1d1630", 10, 10);
    px(7, 4, f ? "#d6b8ff" : "#b48cff", 2, 8); px(5, 7, f ? "#d6b8ff" : "#b48cff", 6, 2);
    px(7, 7, "#ff7a2e", 2, 2);
  }, 19 + f)),
};

// Cara frontal de los bloques (se ve debajo de un bloque cuando delante hay suelo).
function makeSide(fn, seed) {
  const c = document.createElement("canvas");
  c.width = TS; c.height = 6;
  const ctx = c.getContext("2d");
  const r = mulberry32(seed);
  fn((x, y, col, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); }, r);
  return c;
}
const SIDE_ART = {
  rock: makeSide((px, r) => { noiseFill(px, r, ["#5e5e64", "#55555b", "#68686e", "#4c4c52"], 0, 0, TS, 6, 0.4); px(0, 0, "#3a3a40", TS, 1); px(0, 5, "#2e2e33", TS, 1); for (const x of [4, 11]) px(x, 1, "#45454b", 1, 4); }, 51),
  [T.PLANKS]: makeSide((px, r) => { noiseFill(px, r, ["#7a5a35", "#86643c", "#6e5130"], 0, 0, TS, 6, 0.8); px(0, 0, "#4a3620", TS, 1); px(0, 3, "#5a4126", TS, 1); }, 52),
  [T.BRICK]: makeSide((px, r) => { px(0, 0, "#7d776d", TS, 6); for (let bx = 0; bx < TS; bx += 8) noiseFill(px, r, ["#7c3a2b", "#713526", "#86412f"], bx + 1, 1, 7, 2, 0.6); for (let bx = 4; bx < TS; bx += 8) noiseFill(px, r, ["#7c3a2b", "#713526"], bx - 3 < 0 ? 0 : bx - 3, 4, 7, 2, 0.6); px(0, 0, "#4e4a44", TS, 1); }, 53),
  [T.BENCH]: makeSide((px, r) => { noiseFill(px, r, ["#7a5a35", "#86643c"], 0, 0, TS, 6, 0.8); px(0, 0, "#4a3620", TS, 1); px(3, 2, "#c0c0c0", 3, 1); px(4, 3, "#6e5130", 1, 2); px(10, 2, "#9a9a9a", 3, 2); }, 54),
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
    grassTile(31, (px) => { px(3, 11, "#8e8e86", 2, 1); px(4, 10, "#b0b0a8"); px(11, 4, "#8e8e86"); }),
    grassTile(32, (px) => { px(9, 9, "#f2efe6", 3, 1); px(9, 10, "#c9483a", 3, 1); px(10, 11, "#e8e0cc", 1, 2); }),
    grassTile(33, (px) => { for (const [x, y] of [[3, 3], [12, 6], [6, 12]]) { px(x, y, "#3f7f2a", 1, 2); px(x + 1, y - 1, "#3f7f2a", 1, 3); px(x + 2, y, "#3f7f2a", 1, 2); } }),
    grassTile(34, (px) => { px(4, 6, "#ffffff"); px(12, 10, "#ffd23f"); px(8, 13, "#ffffff"); }),
  ],
  [T.SAND]: [
    TILE_ART[T.SAND][0],
    makeTile((px, r) => { noiseFill(px, r, ["#dccf8f", "#e3d79c", "#d3c482", "#e9dea8"]); px(5, 6, "#ffd8c8", 2, 2); px(6, 5, "#f0b8a8"); px(5, 7, "#d89a8a"); }, 35),
    makeTile((px, r) => { noiseFill(px, r, ["#dccf8f", "#e3d79c", "#cbbb76", "#e9dea8"]); px(11, 10, "#a89a7a", 2, 1); px(3, 12, "#a89a7a"); }, 36),
  ],
  [T.DIRT]: [
    TILE_ART[T.DIRT][0],
    makeTile((px, r) => { noiseFill(px, r, ["#856043", "#7a5638", "#96704c", "#6e4c31"]); px(4, 9, "#8a8a8a", 2, 2); px(4, 9, "#a8a8a8"); px(12, 4, "#5a3e28", 2, 1); }, 37),
  ],
  [T.TALL]: [
    TILE_ART[T.TALL][0],
    makeTile((px, r) => {
      for (let i = 0; i < 8; i++) {
        const x = 1 + ((i * 3 + 1) % 14), h = 7 + Math.floor(r() * 5), y = 15 - h;
        px(x, y + 1, "#3a8226", 1, h); px(x + 1, y + 3, "#2a661c", 1, h - 3); px(x, y, "#9ae672"); px(x - 1, y + 3, "#5aad3a", 1, 2);
      }
    }, 38),
  ],
};

const shadeHex = (hex, k) => { const [r, g, b] = shadeCol(parseColor(hex), k); return `rgb(${r | 0},${g | 0},${b | 0})`; };

/* Árboles de bloques (32×32): copa como un cubo de hojas con su cara de arriba más clara
 * y la de delante más oscura, y tronco de corteza. */
function blockTree(seed, { leaf, leafTop, leafSide, trunk, bark, fruit, tall }) {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d");
  const r = mulberry32(seed);
  const px = (x, y, col, w = 1, h = 1) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };
  const leaves = (x0, y0, w, h, pal) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      // Esquinas recortadas y algún hueco entre las hojas.
      const corner = (x === x0 || x === x0 + w - 1) && (y === y0 || y === y0 + h - 1);
      if (corner) continue;
      const k = r();
      // Algunas hojas más oscuras o más claras, en grupitos, para que se note la textura.
      px(x, y, k < 0.12 ? shadeHex(pal[0], -0.25) : k > 0.93 ? shadeHex(pal[0], 0.2) : pal[Math.floor(r() * pal.length)]);
    }
  };
  // Tronco con corteza.
  px(13, 18, trunk, 6, 13);
  for (let y = 18; y < 31; y++) for (let x = 13; x < 19; x++) if (r() < 0.35) px(x, y, bark);
  px(13, 18, bark, 1, 13); px(17, 19, bark, 1, 11);
  px(12, 30, bark, 8, 1);
  if (tall) {
    // Pino: tres cubos de hojas apilados, cada uno más pequeño.
    leaves(6, 14, 20, 6, leafSide); leaves(6, 10, 20, 5, leaf); leaves(7, 9, 18, 2, leafTop);
    leaves(9, 6, 14, 5, leaf); leaves(10, 5, 12, 2, leafTop);
    leaves(12, 1, 8, 5, leaf); leaves(13, 0, 6, 2, leafTop);
  } else {
    leaves(3, 15, 26, 6, leafSide);  // cara de delante (sombra)
    leaves(3, 3, 26, 13, leaf);      // cuerpo de la copa
    leaves(4, 2, 24, 4, leafTop);    // cara de arriba (luz)
    leaves(10, 0, 12, 3, leafTop);
  }
  if (fruit) for (const [x, y] of [[7, 8], [20, 6], [12, 12], [24, 13], [16, 4], [5, 14]]) { px(x, y, fruit, 2, 2); px(x, y, "#ffb0a8"); }
  // Contorno oscuro.
  const img = ctx.getImageData(0, 0, 32, 32), d = img.data, out = new Uint8ClampedArray(d);
  const solid = (x, y) => x >= 0 && y >= 0 && x < 32 && y < 32 && d[(y * 32 + x) * 4 + 3] > 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if (solid(x, y) || !(solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) continue;
    out.set([16, 40, 20, 255], (y * 32 + x) * 4);
  }
  ctx.putImageData(new ImageData(out, 32, 32), 0, 0);
  return c;
}
const TREES = [
  blockTree(61, { leaf: ["#3f8f2f", "#468f34", "#37802a", "#4f9e3a"], leafTop: ["#5fae44", "#6cbb4e", "#58a33f"], leafSide: ["#2c6a22", "#2f7024", "#265e1e"], trunk: "#6b4a2b", bark: "#4f361f" }),
  blockTree(62, { leaf: ["#2e6a3c", "#2a6237", "#336f40"], leafTop: ["#3f8550", "#478c56"], leafSide: ["#1f4c2b", "#234f2e"], trunk: "#4f3520", bark: "#3a2616", tall: true }),
  blockTree(63, { leaf: ["#4a9a36", "#52a33c", "#42902f"], leafTop: ["#6cbf4e", "#77c858"], leafSide: ["#327428", "#2f6e25"], trunk: "#6b4a2b", bark: "#4f361f", fruit: "#d8303a" }),
];
GROUND_VARIANTS[T.STONE] = [
  TILE_ART[T.STONE][0],
  makeTile((px, r) => { stoneBase(px, r); px(2, 3, "#5f8a3a", 4, 2); px(3, 2, "#78a35c", 2, 1); px(11, 12, "#5f8a3a", 3, 1); px(12, 11, "#6f9a48"); }, 41),
  makeTile((px, r) => { stoneBase(px, r); px(4, 8, "#505050", 1, 4); px(5, 11, "#505050", 3, 1); px(10, 3, "#505050", 1, 3); px(11, 5, "#505050", 2, 1); }, 42),
  makeTile((px, r) => {
    // Adoquín: piedras sueltas con sus juntas.
    px(0, 0, "#5a5a5a", TS, TS);
    for (const [x, y, w, h] of [[1, 1, 6, 4], [8, 1, 7, 5], [1, 6, 4, 5], [6, 7, 5, 4], [12, 7, 3, 4], [1, 12, 7, 3], [9, 12, 6, 3]]) {
      noiseFill(px, r, ["#8e8e8e", "#9a9a9a", "#828282"], x, y, w, h, 0.4); px(x, y, "#b0b0b0", w, 1); px(x, y + h - 1, "#6a6a6a", w, 1);
    }
  }, 43),
];
const treeVariant = (x, y) => { const h = hash(x, y, 7) % 10; return h < 6 ? 0 : h < 9 ? 1 : 2; };

/* ---------- Arte: personaje e iconos ---------- */

function playerFrame(dir, step) {
  // Personaje original: explorador con pañuelo rojo, chaqueta naranja y mochila.
  const c = document.createElement("canvas");
  c.width = c.height = TS;
  const x = c.getContext("2d");
  const px = (a, b, col, w = 1, h = 1) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
  const skin = "#e8b48a", hair = "#2a1d18", shirt = "#e8772e", pants = "#4a3d5c", shoe = "#2a1d18";
  px(4, 1, hair, 8, 3);                    // pelo
  px(4, 4, skin, 8, 4);                    // cara
  px(4, 2, "#d8323a", 8, 1);               // pañuelo
  if (dir === "up") { px(4, 4, hair, 8, 3); px(5, 1, "#d8323a", 1, 3); px(4, 3, "#a8242c", 2, 1); }
  else if (dir === "down") { px(6, 5, "#1b1b1b"); px(9, 5, "#1b1b1b"); px(6, 7, "#b8785a", 3, 1); }
  else if (dir === "left") { px(5, 5, "#1b1b1b"); px(9, 3, hair, 3, 3); px(11, 2, "#d8323a", 2, 2); }
  else { px(10, 5, "#1b1b1b"); px(4, 3, hair, 3, 3); px(3, 2, "#d8323a", 2, 2); }
  px(3, 8, shirt, 10, 4);                  // chaqueta
  px(3, 8, "#b8561e", 1, 4); px(12, 8, "#b8561e", 1, 4); px(7, 8, "#f6d25a", 2, 1);
  if (dir === "up") { px(5, 8, "#7a5532", 6, 4); px(5, 8, "#9a7040", 6, 1); }  // mochila
  else { px(4, 8, "#7a5532", 1, 4); px(11, 8, "#7a5532", 1, 4); }             // tirantes
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

const anim = { fromX: 0, fromY: 0, start: 0, moving: false, step: 0, dur: STEP_MS };

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
    const k = clamp((now - anim.start) / (anim.dur || STEP_MS), 0, 1);
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
      ctx.drawImage(variants[t === T.GRASS ? [0, 0, 0, 0, 0, 0, 1, 3, 4, (h >> 9) % 5 ? 0 : 2][h % 10] : h % variants.length], dx, dy, size, size);
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
        // Cara de delante del cubo de piedra.
        const fh = Math.round(size * 6 / 16);
        ctx.drawImage(SIDE_ART.rock, dx, dy + size - fh, size, fh);
        ctx.fillStyle = "#00000038"; ctx.fillRect(dx, dy + size, size, Math.round(size * 0.22));
      }
    } else if (SIDE_ART[t]) {
      if (WALKABLE.has(tileAt(tx, ty + 1))) {
        const fh = Math.round(size * 6 / 16);
        ctx.drawImage(SIDE_ART[t], dx, dy + size - fh, size, fh);
        ctx.fillStyle = "#0000002e"; ctx.fillRect(dx, dy + size, size, Math.round(size * 0.18));
      }
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
      const hop = anim.moving ? Math.round(Math.abs(Math.sin(((now - anim.start) / (anim.dur || STEP_MS)) * Math.PI)) * scale) : 0;
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
  if (anim.moving && now - anim.start >= anim.dur) {
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
  anim.dur = running ? RUN_MS : STEP_MS;
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
bindButton($("#btn-x"), toggleRun);
bindButton($("#btn-y"), nextItem);
bindButton($("#btn-zoom"), () => cycleZoom());
bindButton($("#btn-home"), goHome);

/* Botones extra: correr, cambiar de bloque y volver a la hoguera. */
let running = false;
function toggleRun() {
  running = !running;
  $("#btn-x").classList.toggle("active", running);
  toast(running ? "🏃 Corriendo" : "🚶 Andando", 1200);
  vibrate(15);
}
function nextItem() {
  const placeable = Object.keys(S.inv).filter((id) => ITEMS[id] && ITEMS[id].place !== undefined && count(id) > 0);
  if (!placeable.length) return toast("No tienes bloques para poner. ¡Tala o pica primero!");
  S.sel = placeable[(placeable.indexOf(S.sel) + 1) % placeable.length];
  renderHotbar();
  toast(ITEMS[S.sel].name + " en la mano", 1200);
  sfx("step");
}
function goHome() {
  if (modalOpen()) return;
  if (!S.home) return toast("Aún no has descansado en ninguna hoguera");
  if (S.player.x === S.home.x && S.player.y === S.home.y) return toast("Ya estás en tu hoguera");
  if (!confirm("¿Volver a tu última hoguera?")) return;
  S.player.x = S.home.x; S.player.y = S.home.y;
  anim.moving = false;
  mining.hits = 0;
  markExplored(S.player.x, S.player.y);
  sfx("heal");
  burst(S.player.x, S.player.y, T.FIRE, 14);
  toast("🏕️ De vuelta en tu hoguera");
  save();
}

const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right" };
const keysDown = new Set();
addEventListener("keydown", (e) => {
  if (KEYS[e.code]) { keysDown.add(KEYS[e.code]); setHeld(KEYS[e.code]); e.preventDefault(); }
  else if ((e.code === "KeyZ" || e.code === "Space" || e.code === "Enter") && !e.repeat) { holdA = true; doAction(); }
  else if (e.code === "KeyX" && !e.repeat) doPlace();
  else if (e.code === "KeyC" && !e.repeat) toggleRun();
  else if (e.code === "KeyV" && !e.repeat) nextItem();
  else if ((e.code === "ShiftLeft" || e.code === "ShiftRight") && !e.repeat && !running) toggleRun();
});
addEventListener("keyup", (e) => {
  if (KEYS[e.code]) { keysDown.delete(KEYS[e.code]); setHeld([...keysDown].pop() || null); }
  if (e.code === "KeyZ" || e.code === "Space" || e.code === "Enter") holdA = false;
  if ((e.code === "ShiftLeft" || e.code === "ShiftRight") && running) toggleRun();
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
  let pool = rock ? ["pedron", "topin", "cenizo", "brasito", "topin", "hongui"]
    : water ? ["gotin", "corali", "plumi", "corali", "tortuli", "tortuli"]
      : ["brotin", "musguito", "plumi", "chispin", "musguito", "plumi"];
  if (isNight()) pool = pool.concat(["lumi", "voltibicho", "lumi", "polillux", "hongui"]);
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
  drawMonInto($("#ally-sprite"), B.ally.sp, true);
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
    drawMonInto($("#ally-sprite"), B.ally.sp, true);
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
    drawMonInto($("#ally-sprite"), next.sp, true);
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
  if (el) { drawMonInto(el, m.sp, true); renderCards(); }
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
