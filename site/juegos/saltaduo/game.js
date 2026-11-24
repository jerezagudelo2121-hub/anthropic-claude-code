"use strict";

/* Salta Dúo — plataformas cooperativo original.
 * Dos bichitos (Tuki y Tako) recorren niveles generados a partir de una semilla fija, solos o
 * con un amigo online (PeerJS + WebRTC, con plan B por el servidor). En online cada jugador mueve
 * su personaje en su móvil y el anfitrión manda en los enemigos, monedas y puertas. */

const $ = (s) => document.querySelector(s);
const T = 16;                 // tamaño de casilla (píxeles de arte)
const ROWS = 14;              // filas de cada nivel (224 px de alto)
const VIEW_H = ROWS * T;
const SAVE_KEY = "saltaduo-v1";
const PEER_PREFIX = "saltaduo-v1-";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/* ---------- Guardado ---------- */
const save = (() => {
  let d;
  try { d = JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch (e) { d = {}; }
  d.unlocked = d.unlocked || 1;
  d.best = d.best || {};
  d.music = d.music !== false;
  d.sfx = d.sfx !== false;
  return d;
})();
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* sin almacenamiento */ } }

/* ---------- Sonido (sintetizado, sin archivos) ---------- */
const snd = { ctx: null, master: null, music: null, step: 0, timer: 0 };
function audio() {
  if (snd.ctx) return snd.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  snd.ctx = new AC();
  snd.master = snd.ctx.createGain(); snd.master.gain.value = 0.5; snd.master.connect(snd.ctx.destination);
  snd.music = snd.ctx.createGain(); snd.music.gain.value = save.music ? 0.22 : 0; snd.music.connect(snd.master);
  return snd.ctx;
}
function tone(freq, dur, { type = "square", vol = 0.12, slide = 0, delay = 0, out } = {}) {
  const ctx = snd.ctx;
  if (!ctx) return;
  const t0 = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(out || snd.master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
const SFX = {
  jump: () => tone(330, 0.12, { slide: 330, vol: 0.08 }),
  coin: () => { tone(988, 0.06, { vol: 0.07 }); tone(1319, 0.14, { vol: 0.07, delay: 0.06 }); },
  star: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, { vol: 0.08, delay: i * 0.07, type: "triangle" })),
  stomp: () => tone(220, 0.12, { slide: -150, vol: 0.12 }),
  spring: () => tone(260, 0.25, { slide: 700, vol: 0.09, type: "triangle" }),
  bounce: () => tone(420, 0.12, { slide: 300, vol: 0.08, type: "triangle" }),
  die: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.14, { vol: 0.1, delay: i * 0.11, type: "triangle" })),
  cp: () => [523, 659, 784].forEach((f, i) => tone(f, 0.1, { vol: 0.08, delay: i * 0.08 })),
  gate: () => tone(150, 0.2, { vol: 0.1, type: "sawtooth" }),
  boss: () => tone(110, 0.3, { slide: -60, vol: 0.16, type: "sawtooth" }),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.16, { vol: 0.09, delay: i * 0.12, type: "triangle" })),
};
function sfx(name) { if (save.sfx && snd.ctx && SFX[name]) SFX[name](); }
const SONGS = {
  pradera: [0, 4, 7, 12, 7, 4, 5, 9, 12, 9, 5, 4, 2, 7, 11, 7],
  bosque: [0, 3, 7, 10, 7, 3, 5, 8, 12, 8, 5, 3, 2, 5, 9, 7],
  cueva: [0, 0, 3, 0, 5, 3, 7, 5, 0, 0, 3, 0, 8, 7, 5, 3],
  nubes: [0, 7, 12, 16, 12, 7, 5, 9, 14, 9, 5, 4, 7, 11, 14, 11],
  castillo: [0, 1, 0, -2, 0, 3, 1, 0, -5, -2, 0, 1, 3, 1, 0, -2],
};
function musicTick() {
  if (!snd.ctx || !game.level || game.state !== "play") return;
  const song = SONGS[game.level.theme.song] || SONGS.pradera, root = game.level.theme.root || 262;
  const n = song[snd.step % song.length];
  tone(root * Math.pow(2, n / 12), 0.16, { type: "square", vol: 0.05, out: snd.music });
  if (snd.step % 4 === 0) tone(root / 2 * Math.pow(2, song[(snd.step / 4 | 0) % song.length] / 12), 0.3, { type: "triangle", vol: 0.08, out: snd.music });
  snd.step++;
}
setInterval(musicTick, 170);

/* ---------- Niveles ---------- */
const THEMES = {
  pradera: { sky: ["#7ec8ff", "#c9ecff"], hill: "#5fbf5a", hill2: "#3f9a45", grass: "#56c45a", dirt: "#9a6b3e", dirt2: "#7a5230", brick: "#c8663c", song: "pradera", root: 262 },
  bosque: { sky: ["#5aa8c8", "#bfe8d8"], hill: "#2f7d4a", hill2: "#1e5a36", grass: "#3fae5a", dirt: "#6e4a2e", dirt2: "#553620", brick: "#8a5a3a", song: "bosque", root: 220 },
  cueva: { sky: ["#1a1430", "#3a2a5a"], hill: "#2e2450", hill2: "#221a3c", grass: "#8a7ac8", dirt: "#4a3a6a", dirt2: "#3a2c55", brick: "#6a5a9a", song: "cueva", root: 196 },
  nubes: { sky: ["#ffb3d1", "#ffe7c2"], hill: "#ffffff", hill2: "#ffe3f0", grass: "#ffffff", dirt: "#d8e4ff", dirt2: "#b8c8f0", brick: "#f0a8c8", song: "nubes", root: 294 },
  castillo: { sky: ["#2a0f1e", "#5a1e2e"], hill: "#3a1828", hill2: "#2a1020", grass: "#9a9aa8", dirt: "#5a5a6a", dirt2: "#44444f", brick: "#7a3a3a", song: "castillo", root: 175 },
};
const LEVELS = [
  { name: "Pradera Saltarina", theme: "pradera", seed: 101, diff: 1, len: 90 },
  { name: "Bosque de Setas", theme: "bosque", seed: 202, diff: 2, len: 110 },
  { name: "Cueva Brillante", theme: "cueva", seed: 303, diff: 3, len: 120 },
  { name: "Valle de Pinchos", theme: "pradera", seed: 404, diff: 4, len: 130 },
  { name: "Islas en las Nubes", theme: "nubes", seed: 505, diff: 5, len: 135 },
  { name: "Castillo del Gran Blob", theme: "castillo", seed: 606, diff: 5, boss: true },
];

// Genera la rejilla de un nivel (filas de caracteres) a partir de su semilla.
//  # suelo  B ladrillo  = plataforma  ^ pinchos  o moneda  * estrella  S babosa  T pinchudo  F pájaro
//  J muelle  C bandera  G meta  P botón  D puerta  K jefe  1 2 salidas
function buildGrid(def) {
  const r = mulberry32(def.seed);
  const g0 = 11;
  const grid = Array.from({ length: ROWS }, () => []);
  let x = 0, g = g0;
  const cands = [];
  const col = (top, ch = "#") => { for (let y = 0; y < ROWS; y++) grid[y][x] = y >= top ? ch : " "; x++; };
  const put = (cx, cy, ch) => { if (cy >= 0 && cy < ROWS && cx >= 0) grid[cy][cx] = ch; };
  const ri = (a, b) => a + Math.floor(r() * (b - a + 1));

  if (def.boss) {
    col(0); col(0);
    for (let i = 0; i < 40; i++) col(g);
    col(0); col(0);
    put(4, g - 1, "1"); put(6, g - 1, "2");
    for (const px of [8, 19, 30]) for (let i = 0; i < 4; i++) put(px + i, 8, "=");
    for (const px of [13, 25]) for (let i = 0; i < 3; i++) put(px + i, 5, "=");
    put(10, 7, "*"); put(26, 4, "*"); put(32, 7, "*");
    for (const px of [13, 15, 25, 27]) put(px, 4, "o");
    put(30, g - 2, "K");
    return finish(grid);
  }

  for (let i = 0; i < 6; i++) col(g);
  put(2, g - 1, "1"); put(4, g - 1, "2");
  const d = def.diff;
  const pool = ["flat", "flat", "gap", "step", "step", "float", "spikes", "spring", "wall", "enemy", "enemy"];
  if (d >= 2) pool.push("gap", "spikes", "float", "birds");
  if (d >= 3) pool.push("spiky", "gap", "float");
  if (d >= 4) pool.push("spiky", "birds", "spikes");
  const forced = { 2: "spring", 5: "gate", 8: "float" };
  let seg = 0, checkpointPut = false;
  while (x < def.len || seg <= 8) {
    if (!checkpointPut && x > def.len / 2) {
      checkpointPut = true;
      const cx = x;
      for (let i = 0; i < 5; i++) col(g);
      put(cx + 2, g - 1, "C");
      continue;
    }
    const type = forced[seg] || pool[Math.floor(r() * pool.length)];
    seg++;
    const sx = x;
    if (type === "flat" || type === "enemy" || type === "spiky") {
      const w = ri(5, 8);
      for (let i = 0; i < w; i++) col(g);
      if (r() < 0.6) for (let i = 1; i < 4; i++) put(sx + i, g - 2, "o");
      if (type === "enemy") put(sx + ri(2, w - 2), g - 1, "S");
      if (type === "spiky") put(sx + ri(2, w - 2), g - 1, "T");
      if (type === "flat" && d >= 2 && r() < 0.35) put(sx + w - 2, g - 1, "S");
    } else if (type === "gap") {
      for (let i = 0; i < 2; i++) col(g);
      const w = ri(2, Math.min(4, 2 + Math.floor(d / 2)));
      const gs = x;
      for (let i = 0; i < w; i++) col(99);
      for (let i = 0; i < w; i++) put(gs + i, g - 3 - (i > 0 && i < w - 1 ? 1 : 0), "o");
      cands.push([gs + (w >> 1), g - 5]);
      for (let i = 0; i < 2; i++) col(g);
    } else if (type === "step") {
      const options = [-2, -1, 1, 2].filter((v) => g + v >= 6 && g + v <= 11);
      g += options[Math.floor(r() * options.length)];
      const w = ri(3, 5);
      for (let i = 0; i < w; i++) col(g);
      if (r() < 0.5) put(sx + 1, g - 2, "o");
    } else if (type === "float" || type === "birds") {
      col(g);
      const gs = x, w = type === "birds" ? 7 : ri(6, 8);
      for (let i = 0; i < w; i++) col(99);
      const py = g - 3;
      for (let i = 2; i < w - 2; i++) put(gs + i, py, "=");
      for (let i = 2; i < w - 2; i++) put(gs + i, py - 1, "o");
      if (type === "birds" || (d >= 2 && r() < 0.5)) put(gs + (w >> 1), Math.max(1, g - 7), "F");
      cands.push([gs + (w >> 1), py - 3]);
      col(g);
    } else if (type === "spikes") {
      for (let i = 0; i < 2; i++) col(g);
      const n = d >= 3 ? 3 : 2;
      const ss = x;
      for (let i = 0; i < n; i++) col(g);
      for (let i = 0; i < n; i++) { put(ss + i, g - 1, "^"); put(ss + i, g - 4, "o"); }
      for (let i = 0; i < 2; i++) col(g);
    } else if (type === "spring") {
      const w = 7;
      for (let i = 0; i < w; i++) col(g);
      put(sx + 1, g - 1, "J");
      const ly = Math.max(2, g - 6);
      for (let i = 3; i < 7; i++) put(sx + i, ly, "B");
      for (let i = 3; i < 7; i++) put(sx + i, ly - 1, "o");
      cands.push([sx + 5, ly - 2]);
    } else if (type === "wall") {
      for (let i = 0; i < 2; i++) col(g);
      const h = ri(2, 3);
      for (let i = 0; i < 2; i++) { col(g); for (let k = 1; k <= h; k++) put(x - 1, g - k, "B"); }
      put(x - 1, g - h - 2, "o");
      for (let i = 0; i < 2; i++) col(g);
    } else if (type === "gate") {
      // Puerta cooperativa: mientras alguien pisa el botón, la puerta se abre.
      const w = 12;
      for (let i = 0; i < w; i++) col(g);
      put(sx + 3, g - 1, "P");
      for (let y = 0; y < g; y++) put(sx + 8, y, "D");
      for (let i = 9; i < 12; i++) put(sx + i, g - 2, "o");
      cands.push([sx + 10, g - 3]);
    }
  }
  const end = x;
  for (let i = 0; i < 12; i++) col(g);
  put(end + 6, g - 1, "G");
  // Mínimo de enemigos según la dificultad, en suelo llano (lejos de la salida y de la meta).
  const count = () => grid.reduce((n, row) => n + row.filter((c) => c === "S" || c === "T" || c === "F").length, 0);
  const want = 3 + d * 2;
  for (let tries = 0; tries < 400 && count() < want; tries++) {
    const cx = 12 + Math.floor(r() * (end - 16));
    let top = -1;
    for (let y = 1; y < ROWS; y++) if (grid[y][cx] === "#") { top = y; break; }
    if (top < 3) continue;
    const flat = [-1, 0, 1].every((o) => grid[top][cx + o] === "#" && grid[top - 1][cx + o] === " " && grid[top - 2][cx + o] === " ");
    if (!flat) continue;
    grid[top - 1][cx] = d >= 3 && r() < 0.3 ? "T" : "S";
  }
  // Tres estrellas repartidas entre los sitios difíciles.
  const picks = [cands[0], cands[Math.floor(cands.length / 2)], cands[cands.length - 1]];
  for (const [cx, cy] of picks) put(cx, Math.max(1, cy), "*");
  return finish(grid);

  function finish(gr) {
    const w = Math.max(...gr.map((row) => row.length));
    return gr.map((row) => { for (let i = 0; i < w; i++) if (row[i] === undefined) row[i] = " "; return row; });
  }
}

function loadLevel(idx) {
  const def = LEVELS[idx];
  const grid = buildGrid(def);
  const L = {
    idx, def, theme: THEMES[def.theme], w: grid[0].length, h: ROWS, tiles: grid.map((r) => r.slice()),
    coins: [], stars: [], enemies: [], springs: [], checkpoints: [], plates: [], gates: [], goal: null, spawns: [],
    coinCount: 0, starsGot: [false, false, false], gatesOpen: false, bossDead: false,
  };
  let eid = 0;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < L.w; x++) {
    const c = grid[y][x];
    const clear = () => (L.tiles[y][x] = " ");
    if (c === "o") { L.coins.push({ id: L.coins.length, x: x * T + 4, y: y * T + 4, w: 8, h: 8, taken: false }); clear(); }
    else if (c === "*") { L.stars.push({ id: L.stars.length, x: x * T + 2, y: y * T + 2, w: 12, h: 12, taken: false }); clear(); }
    else if (c === "S" || c === "T") { L.enemies.push({ id: eid++, type: c, x: x * T + 1, y: y * T + 4, w: 14, h: 12, vx: -0.5, vy: 0, alive: true }); clear(); }
    else if (c === "F") { L.enemies.push({ id: eid++, type: "F", x: x * T, y: y * T + 2, w: 14, h: 11, vx: 0.8, vy: 0, bx: x * T, by: y * T + 2, t: x * 7, alive: true }); clear(); }
    else if (c === "K") { L.enemies.push({ id: eid++, type: "K", x: x * T, y: y * T - 10, w: 34, h: 28, vx: 0, vy: 0, hp: 5, timer: 80, inv: 0, alive: true }); clear(); }
    else if (c === "J") { L.springs.push({ x: x * T + 1, y: y * T + 8, w: 14, h: 8, squash: 0 }); clear(); }
    else if (c === "C") { L.checkpoints.push({ id: L.checkpoints.length, x: x * T + 4, y: y * T - 16, w: 8, h: 32, on: false }); clear(); }
    else if (c === "G") { L.goal = { x: x * T + 4, y: y * T - 48, w: 10, h: 64 }; clear(); }
    else if (c === "P") { L.plates.push({ x: x * T, y: y * T + 12, w: T, h: 4, down: false }); clear(); }
    else if (c === "D") { L.gates.push({ tx: x, ty: y }); }
    else if (c === "1" || c === "2") { L.spawns[c === "1" ? 0 : 1] = { x: x * T + 3, y: y * T + 2 }; clear(); }
  }
  if (def.boss) L.goal = null;  // aparece al vencer al jefe
  return L;
}

/* ---------- Física de casillas ---------- */
function tileAt(L, tx, ty) {
  if (tx < 0 || tx >= L.w) return "#";
  if (ty < 0) return " ";
  if (ty >= ROWS) return " ";
  return L.tiles[ty][tx];
}
function solid(L, c) { return c === "#" || c === "B" || (c === "D" && !L.gatesOpen); }

function moveBody(L, b) {
  // Horizontal
  b.x += b.vx;
  const top = Math.floor(b.y / T), bot = Math.floor((b.y + b.h - 1) / T);
  if (b.vx > 0) {
    const tx = Math.floor((b.x + b.w - 1) / T);
    for (let ty = top; ty <= bot; ty++) if (solid(L, tileAt(L, tx, ty))) { b.x = tx * T - b.w; b.vx = 0; b.hitWall = true; break; }
  } else if (b.vx < 0) {
    const tx = Math.floor(b.x / T);
    for (let ty = top; ty <= bot; ty++) if (solid(L, tileAt(L, tx, ty))) { b.x = (tx + 1) * T; b.vx = 0; b.hitWall = true; break; }
  }
  // Vertical
  const prevBottom = b.y + b.h;
  b.y += b.vy;
  b.onGround = false;
  const left = Math.floor(b.x / T), right = Math.floor((b.x + b.w - 1) / T);
  if (b.vy > 0) {
    const ty = Math.floor((b.y + b.h - 1) / T);
    for (let tx = left; tx <= right; tx++) {
      const c = tileAt(L, tx, ty);
      if (solid(L, c) || (c === "=" && prevBottom <= ty * T + 1)) { b.y = ty * T - b.h; b.vy = 0; b.onGround = true; break; }
    }
  } else if (b.vy < 0) {
    const ty = Math.floor(b.y / T);
    for (let tx = left; tx <= right; tx++) if (solid(L, tileAt(L, tx, ty))) { b.y = (ty + 1) * T; b.vy = 0.5; break; }
  }
}

/* ---------- Estado del juego ---------- */
const game = {
  state: "title",        // title | online | map | play | pause | clear
  level: null,
  me: null,              // tu personaje
  other: null,           // el de tu amigo (online)
  cam: 0,
  frame: 0,
  particles: [],
  shake: 0,
  clearTimer: 0,
};

function makePlayer(slot, spawn) {
  return {
    slot, x: spawn.x, y: spawn.y, w: 10, h: 14, vx: 0, vy: 0, face: 1, onGround: false,
    coyote: 0, buf: 0, dead: 0, inv: 0, done: false, anim: 0, cp: null,
    name: slot === 0 ? "Tuki" : "Tako",
  };
}

function startLevel(idx) {
  audio();
  game.level = loadLevel(idx);
  const L = game.level;
  const mySlot = net.role === "guest" ? 1 : 0;
  game.me = makePlayer(mySlot, L.spawns[mySlot] || L.spawns[0]);
  game.other = net.conn ? makePlayer(1 - mySlot, L.spawns[1 - mySlot] || L.spawns[0]) : null;
  if (game.other) { game.other.tx = game.other.x; game.other.ty = game.other.y; }
  game.particles = [];
  game.cam = 0;
  game.clearTimer = 0;
  snd.step = 0;
  show("play");
  $("#hud-level").textContent = `${idx + 1}. ${L.def.name}`;
  updateHud();
  if (L.def.boss) toast("¡El Gran Blob! Salta sobre él 5 veces", 3000);
  game.tips = idx === 0 ? [
    [0, "◀ ▶ para moverte · A para saltar"],
    [6 * T, "Mantén A para saltar más alto · B para correr"],
    [14 * T, "Salta encima de los enemigos para vencerlos"],
    [30 * T, "Los muelles 🔴 te lanzan muy alto"],
    [50 * T, "Pisa el botón rojo para abrir la puerta"],
  ] : [];
}

/* ---------- Entrada ---------- */
const input = { left: false, right: false, jump: false, run: false };
let jumpEdge = false;
const KEYS = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", ArrowUp: "jump", KeyZ: "jump", Space: "jump", KeyW: "jump", KeyX: "run", ShiftLeft: "run", ShiftRight: "run" };
addEventListener("keydown", (e) => {
  const k = KEYS[e.code];
  if (!k) { if (e.code === "Escape" && game.state === "play") pause(); return; }
  e.preventDefault();
  if (k === "jump" && !input.jump) jumpEdge = true;
  input[k] = true;
  audio();
});
addEventListener("keyup", (e) => { const k = KEYS[e.code]; if (k) input[k] = false; });

const padKeys = [...document.querySelectorAll("#pad .key")];
const fingers = new Map();
function padUpdate() {
  const held = new Set(fingers.values());
  for (const el of padKeys) {
    const k = el.dataset.k, on = held.has(k);
    if (k === "jump" && on && !input.jump) jumpEdge = true;
    input[k] = on;
    el.classList.toggle("on", on);
  }
}
function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const key = el && el.closest("#pad .key");
  return key ? key.dataset.k : null;
}
for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
  $("#pad").addEventListener(ev, (e) => {
    e.preventDefault();
    audio();
    for (const t of e.changedTouches) {
      if (ev === "touchend" || ev === "touchcancel") fingers.delete(t.identifier);
      else {
        const k = keyAt(t.clientX, t.clientY);
        // Deslizar el dedo entre ◀ y ▶ cambia de dirección sin soltar.
        if (k) fingers.set(t.identifier, k); else if (ev === "touchmove") fingers.delete(t.identifier);
      }
    }
    padUpdate();
  }, { passive: false });
}
for (const el of padKeys) {
  el.addEventListener("mousedown", () => { fingers.set("m", el.dataset.k); padUpdate(); audio(); });
}
addEventListener("mouseup", () => { fingers.delete("m"); padUpdate(); });
// Sin zoom del navegador con doble toque.
let lastTouch = 0;
document.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastTouch < 350 && !e.target.closest("input")) e.preventDefault(); lastTouch = now; }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());

/* ---------- Jugador ---------- */
function respawnPoint(p) {
  const L = game.level;
  return p.cp || L.spawns[p.slot] || L.spawns[0];
}
function killPlayer(p) {
  if (p.dead || p.inv > 0 || p.done) return;
  p.dead = 70;
  p.vx = 0; p.vy = -5;
  game.shake = 10;
  sfx("die");
  burst(p.x + 5, p.y + 7, p.slot === 0 ? "#ffa23b" : "#4fb6ff", 14);
}

function updateMe() {
  const L = game.level, p = game.me;
  if (p.done) { p.vx = 0; p.anim++; return; }
  if (p.dead) {
    p.vy = Math.min(p.vy + 0.3, 6);
    p.y += p.vy;
    if (--p.dead === 0) {
      const s = respawnPoint(p);
      Object.assign(p, { x: s.x, y: s.y, vx: 0, vy: 0, inv: 90 });
    }
    return;
  }
  if (p.inv > 0) p.inv--;
  const run = input.run, max = run ? 2.7 : 1.75;
  const acc = p.onGround ? 0.25 : 0.16;
  if (input.left && !input.right) { p.vx = Math.max(p.vx - acc, -max); p.face = -1; }
  else if (input.right && !input.left) { p.vx = Math.min(p.vx + acc, max); p.face = 1; }
  else { p.vx *= p.onGround ? 0.75 : 0.95; if (Math.abs(p.vx) < 0.05) p.vx = 0; }
  if (Math.abs(p.vx) > max) p.vx *= 0.93;
  p.coyote = p.onGround ? 7 : p.coyote - 1;
  if (jumpEdge) p.buf = 8;
  jumpEdge = false;
  if (p.buf > 0) p.buf--;
  if (p.buf > 0 && p.coyote > 0) {
    p.vy = Math.abs(p.vx) > 2.2 ? -6.7 : -6.25;
    p.buf = 0; p.coyote = 0;
    sfx("jump");
  }
  if (!input.jump && p.vy < -2.2) p.vy = -2.2;   // salto corto si sueltas
  p.vy = Math.min(p.vy + 0.34, 6.5);
  const wasFalling = p.vy > 0;
  moveBody(L, p);
  p.anim += p.onGround ? Math.abs(p.vx) * 0.25 : 0;

  // Muelles
  for (const s of L.springs) {
    if (wasFalling && overlap(p, s) && p.y + p.h - s.y < 10) { p.vy = -9.6; s.squash = 12; sfx("spring"); }
  }
  // Rebote en la cabeza del compañero
  const o = game.other;
  if (o && !o.dead && !o.done && wasFalling && p.vy >= 0) {
    const head = { x: o.x - 2, y: o.y - 2, w: o.w + 4, h: 6 };
    const feet = { x: p.x, y: p.y + p.h - 4, w: p.w, h: 5 };
    if (overlap(head, feet)) { p.y = o.y - p.h; p.vy = -8.2; sfx("bounce"); burst(p.x + 5, p.y + p.h, "#fff", 6); }
  }
  // Pinchos
  const box = { x: p.x + 2, y: p.y + 6, w: p.w - 4, h: p.h - 6 };
  for (let ty = Math.floor(box.y / T); ty <= Math.floor((box.y + box.h) / T); ty++) {
    for (let tx = Math.floor(box.x / T); tx <= Math.floor((box.x + box.w) / T); tx++) {
      if (tileAt(L, tx, ty) === "^" && box.y + box.h > ty * T + 8) return killPlayer(p);
    }
  }
  if (p.y > VIEW_H + 40) return killPlayer(p);
  // Enemigos
  for (const e of L.enemies) {
    if (!e.alive || e.gone) continue;
    if (!overlap(p, e)) continue;
    if (p.inv > 0 && !(wasFalling && p.y + p.h - e.y < 10)) continue;   // recién reaparecido: no te hacen daño
    const canStomp = e.type !== "T" && !(e.type === "K" && e.inv > 0);
    if (wasFalling && canStomp && p.y + p.h - e.y < 10) {
      p.vy = input.jump ? -7 : -5.2;
      p.y = e.y - p.h;
      stompEnemy(e, true);
    } else if (!(e.type === "K" && e.inv > 0 && p.y + p.h - e.y < 10)) {
      killPlayer(p);
      return;
    }
  }
  // Monedas y estrellas
  for (const c of L.coins) if (!c.taken && overlap(p, c)) collect("coin", c.id, true);
  for (const s of L.stars) if (!s.taken && overlap(p, s)) collect("star", s.id, true);
  // Banderas
  for (const c of L.checkpoints) if (!c.on && overlap(p, c)) activateCheckpoint(c.id, true);
  for (const c of L.checkpoints) if (c.on && (!p.cp || p.cp.id < c.id)) p.cp = { id: c.id, x: c.x - 2, y: c.y + 18 };
  // Meta
  if (L.goal && overlap(p, L.goal)) {
    p.done = true;
    p.vx = 0;
    sfx("win");
    burst(L.goal.x, L.goal.y + 10, "#ffe14a", 20);
    net.send({ t: "done" });
  }
}

function collect(kind, id, mine) {
  const L = game.level;
  const list = kind === "coin" ? L.coins : L.stars;
  const it = list[id];
  if (!it || it.taken) return;
  it.taken = true;
  if (kind === "coin") { L.coinCount++; sfx("coin"); burst(it.x + 4, it.y + 4, "#ffe14a", 5); }
  else { L.starsGot[id] = true; sfx("star"); burst(it.x + 6, it.y + 6, "#fff3a1", 14); toast("⭐ ¡Estrella!", 1200); }
  updateHud();
  if (mine) net.send({ t: "got", k: kind, id });
  else if (net.role === "host") net.send({ t: "got", k: kind, id });
}

function activateCheckpoint(id, mine) {
  const c = game.level.checkpoints[id];
  if (!c || c.on) return;
  c.on = true;
  sfx("cp");
  burst(c.x + 4, c.y + 4, "#7dff9a", 10);
  if (mine) { toast("🚩 ¡Bandera!", 1000); net.send({ t: "cp", id }); }
}

function stompEnemy(e, mine) {
  sfx("stomp");
  game.shake = 4;
  burst(e.x + e.w / 2, e.y + e.h / 2, e.type === "K" ? "#ff5a8a" : "#9be36d", 10);
  if (net.role === "guest" && mine) {
    // El anfitrión decide; mientras tanto se oculta para que no te haga daño.
    if (e.type !== "K") e.gone = 30;
    else e.inv = 60;
    net.send({ t: "stomp", id: e.id });
    return;
  }
  hitEnemy(e);
}

function hitEnemy(e) {
  const L = game.level;
  if (e.type === "K") {
    if (e.inv > 0) return;
    e.hp--;
    e.inv = 70;
    sfx("boss");
    if (e.hp <= 0) {
      e.alive = false;
      L.bossDead = true;
      L.goal = { x: 36 * T + 4, y: 11 * T - 48, w: 10, h: 64 };
      burst(e.x + 17, e.y + 14, "#ff5a8a", 40);
      toast("¡Has vencido al Gran Blob! Id a la meta 🚩", 3000);
      net.send({ t: "boss", dead: true });
    } else {
      // Al recibir un golpe suelta babosas.
      const alive = L.enemies.filter((q) => q.alive && q.type === "S").length;
      for (let i = 0; i < Math.min(2, 4 - alive); i++) {
        L.enemies.push({ id: L.enemies.length + 100, type: "S", x: e.x + 8 + i * 12, y: e.y, w: 14, h: 12, vx: i ? 0.6 : -0.6, vy: -3, alive: true });
      }
    }
  } else {
    e.alive = false;
  }
}

/* ---------- Enemigos (los mueve quien manda: solo o anfitrión) ---------- */
function updateEnemies() {
  const L = game.level;
  for (const e of L.enemies) {
    if (e.gone > 0) e.gone--;
    if (!e.alive) continue;
    if (e.type === "S" || e.type === "T") {
      e.vy = Math.min(e.vy + 0.3, 6);
      e.hitWall = false;
      const speed = e.type === "T" ? 0.6 : 0.5;
      if (Math.abs(e.vx) < 0.1) e.vx = -speed;
      moveBody(L, e);
      if (e.hitWall) e.vx = e.vx >= 0 ? -speed : speed;
      if (e.onGround) {
        const aheadX = e.vx > 0 ? e.x + e.w + 1 : e.x - 1;
        const below = tileAt(L, Math.floor(aheadX / T), Math.floor((e.y + e.h + 2) / T));
        if (!solid(L, below) && below !== "=") e.vx = -e.vx;
        if (Math.abs(e.vx) < speed) e.vx = Math.sign(e.vx || -1) * speed;
      }
      if (e.y > VIEW_H + 40) e.alive = false;
    } else if (e.type === "F") {
      e.t++;
      e.x += e.vx;
      if (Math.abs(e.x - e.bx) > 56) e.vx = -e.vx;
      e.y = e.by + Math.sin(e.t * 0.06) * 14;
    } else if (e.type === "K") {
      if (e.inv > 0) e.inv--;
      e.vy = Math.min(e.vy + 0.32, 7);
      moveBody(L, e);
      if (e.onGround) {
        e.vx *= 0.8;
        if (--e.timer <= 0) {
          const targets = [game.me, game.other].filter((p) => p && !p.dead && !p.done);
          const t = targets.sort((a, b) => Math.abs(a.x - e.x) - Math.abs(b.x - e.x))[0];
          const dir = t ? Math.sign(t.x - e.x) || 1 : 1;
          e.vy = -7 - (5 - e.hp) * 0.3;
          e.vx = dir * (1.4 + (5 - e.hp) * 0.25);
          e.timer = 70 - (5 - e.hp) * 8;
          e.landShake = true;
        }
      } else if (e.landShake && e.vy > 5) {
        e.landShake = false;
      }
      if (e.onGround && e.prevAir) { game.shake = 8; sfx("stomp"); }
      e.prevAir = !e.onGround;
    }
  }
}

// Puertas: abiertas mientras alguien pisa un botón (jugando solo, el botón se queda pulsado).
function updatePlates() {
  const L = game.level;
  if (!L.plates.length) return;
  const players = [game.me, game.other].filter((p) => p && !p.dead);
  let any = false;
  for (const pl of L.plates) {
    const was = pl.down;
    pl.down = (!net.conn && pl.down) || players.some((p) => overlap(p, { x: pl.x + 2, y: pl.y - 4, w: pl.w - 4, h: 8 }));
    if (pl.down && !was) sfx("gate");
    if (pl.down) any = true;
  }
  if (any !== L.gatesOpen) {
    // No cerrar la puerta encima de alguien.
    if (!any && players.some((p) => L.gates.some((g) => overlap(p, { x: g.tx * T, y: g.ty * T, w: T, h: T })))) return;
    L.gatesOpen = any;
    net.send({ t: "gates", open: any });
  }
}

/* ---------- Partículas ---------- */
function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 0.8 + Math.random() * 2.2;
    game.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, life: 20 + Math.random() * 18, color });
  }
}

/* ---------- Bucle ---------- */
let last = performance.now(), acc = 0;
function loop(now) {
  acc += Math.min(now - last, 100);
  last = now;
  while (acc >= 1000 / 60) {
    acc -= 1000 / 60;
    if (game.state === "play") tick();
  }
  render();
  requestAnimationFrame(loop);
}

function tick() {
  const L = game.level;
  game.frame++;
  updateMe();
  if (game.tips && game.tips.length && game.me.x >= game.tips[0][0]) toast("💡 " + game.tips.shift()[1], 3200);
  if (net.role !== "guest") { updateEnemies(); updatePlates(); }
  else for (const e of L.enemies) if (e.gone > 0) e.gone--;
  for (const s of L.springs) if (s.squash > 0) s.squash--;
  // Compañero: se acerca suavemente a la última posición recibida.
  const o = game.other;
  if (o) {
    o.x += (o.tx - o.x) * 0.4; o.y += (o.ty - o.y) * 0.4;
    if (net.role === "guest") for (const e of L.enemies) if (e.tx !== undefined) { e.x += (e.tx - e.x) * 0.35; e.y += (e.ty - e.y) * 0.35; }
  }
  // Red
  if (net.conn && game.frame % 3 === 0) {
    const p = game.me;
    net.send({ t: "p", x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, f: p.face, a: Math.round(p.anim), g: p.onGround ? 1 : 0, d: p.dead ? 1 : 0, ok: p.done ? 1 : 0, vy: Math.round(p.vy) });
  }
  if (net.role === "host" && game.frame % 4 === 0) {
    net.send({ t: "w", e: L.enemies.map((e) => [e.id, Math.round(e.x), Math.round(e.y), e.alive ? 1 : 0, e.type, e.inv || 0, e.hp || 0]) });
  }
  // Partículas
  for (const pt of game.particles) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.15; pt.life--; }
  game.particles = game.particles.filter((pt) => pt.life > 0);
  if (game.shake > 0) game.shake--;
  // Fin del nivel: todos en la meta.
  const everyone = [game.me, game.other].filter(Boolean);
  if (everyone.every((p) => p.done) && net.role !== "guest") {
    if (++game.clearTimer === 70) levelClear(true);
  }
}

function levelClear(announce) {
  const L = game.level;
  const idx = L.idx;
  const stars = L.starsGot.filter(Boolean).length;
  const best = save.best[idx] || { coins: 0, stars: [false, false, false] };
  best.coins = Math.max(best.coins, L.coinCount);
  best.stars = best.stars.map((s, i) => s || L.starsGot[i]);
  save.best[idx] = best;
  save.unlocked = Math.max(save.unlocked, Math.min(LEVELS.length, idx + 2));
  persist();
  if (announce) net.send({ t: "clear", coins: L.coinCount, stars: L.starsGot });
  $("#clear-title").textContent = idx === LEVELS.length - 1 ? "🏆 ¡Has salvado el valle!" : "¡Nivel superado!";
  $("#clear-stars").textContent = L.starsGot.map((s) => (s ? "⭐" : "☆")).join("");
  $("#clear-info").textContent = `${L.coinCount} monedas · ${stars} de 3 estrellas` +
    (idx === LEVELS.length - 1 ? ". Tuki y Tako han devuelto la calma al valle. ¡Gracias por jugar! Prueba a conseguir todas las estrellas." : "");
  $("#clear-next").hidden = idx >= LEVELS.length - 1 || net.role === "guest";
  $("#clear-map").hidden = net.role === "guest";
  if (net.role === "guest") $("#clear-info").textContent += " · Tu amigo elige el siguiente nivel.";
  show("clear");
}

/* ---------- Dibujo ---------- */
const canvas = $("#game");
const ctx = canvas.getContext("2d");
const buf = document.createElement("canvas");
const b = buf.getContext("2d");
let VIEW_W = 400;
const view = { x: 0, y: 0, w: 1, h: 1 };

function resize() {
  const w = innerWidth, h = innerHeight;
  canvas.width = Math.round(w * Math.min(devicePixelRatio || 1, 2));
  canvas.height = Math.round(h * Math.min(devicePixelRatio || 1, 2));
  VIEW_W = clamp(Math.round(VIEW_H * w / h), 208, 520);
  buf.width = VIEW_W; buf.height = VIEW_H;
  // Escala sin deformar: en vertical el juego ocupa el ancho y queda arriba (el mando va debajo).
  const s = Math.min(canvas.width / VIEW_W, canvas.height / VIEW_H);
  const portrait = h > w * 1.1;
  view.w = Math.round(VIEW_W * s); view.h = Math.round(VIEW_H * s);
  view.x = Math.round((canvas.width - view.w) / 2);
  view.y = portrait ? Math.round(Math.min((canvas.height - view.h) * 0.3, 70 * (canvas.width / w))) : Math.round((canvas.height - view.h) / 2);
  document.body.classList.toggle("portrait", portrait);
}
addEventListener("resize", resize);
resize();

const px = (x, y, w, h, c) => { b.fillStyle = c; b.fillRect(x | 0, y | 0, w, h); };

function ellipse(cx, cy, rx, ry, fill, outline) {
  if (outline) ellipse(cx, cy, rx + 1, ry + 1, outline);
  b.fillStyle = fill;
  for (let dy = -ry; dy <= ry; dy++) {
    const hw = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry + 0.01))));
    b.fillRect(Math.round(cx - hw), Math.round(cy + dy), hw * 2 + 1, 1);
  }
}

// Bichitos (Tuki y Tako): plantilla de 16×16 con paleta.
const CRITTER = [
  "................",
  "...o........o...",
  "..obo......obo..",
  "..obbo....obbo..",
  "..obbboooobbbo..",
  ".obbbbbbbbbbbbo.",
  ".obllbbbbbwwkbo.",
  ".oblbbbbbbwkkbo.",
  ".obbbbbbbbbbbbo.",
  ".obbbbbbbbbbmbo.",
  ".odbbbbbbbbbbdo.",
  "..oddbbbbbbddo..",
  "...oooooooooo...",
];
const FEET = [
  ["...ofo....ofo...", "...ooo....ooo..."],
  ["..ofo......ofo..", "..ooo......ooo.."],
  ["....ofo..ofo....", "....ooo..ooo...."],
];
const critterCache = {};
function critterSprite(slot, frame, blink) {
  const key = slot + "-" + frame + "-" + blink;
  if (critterCache[key]) return critterCache[key];
  const pal = slot === 0
    ? { o: "#3a1a10", b: "#ffa23b", l: "#ffd08a", d: "#d8701c", w: "#ffffff", k: "#1a1020", m: "#7a2a1a", f: "#7a3a1a" }
    : { o: "#0e2040", b: "#4fb6ff", l: "#b8e4ff", d: "#2a7ad8", w: "#ffffff", k: "#0a1020", m: "#123a6a", f: "#1a3a6a" };
  const rows = CRITTER.map((r) => (blink ? r.replace(/w/g, "b").replace(/k/g, "o") : r));
  if (frame === 3) rows.push("..ofo......ofo..", "................");      // saltando: patas abiertas
  else rows.push(...FEET[frame]);
  const c = document.createElement("canvas");
  c.width = 16; c.height = 16;
  const g = c.getContext("2d");
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y + 1, 1, 1); } }));
  return (critterCache[key] = c);
}

function drawPlayer(p, me) {
  if (!p) return;
  if (p.done && game.frame % 40 < 20 && !me) return;
  const x = Math.round(p.x - 3 - game.cam), y = Math.round(p.y - 2);
  if (p.inv > 0 && game.frame % 6 < 3) return;
  const air = p.dead || (p.vy !== undefined ? Math.abs(p.vy) > 0.5 && !p.onGround : !p.g);
  const frame = p.dead ? 3 : air ? 3 : Math.abs(p.vx || 0) > 0.2 || (p.a && p.moving) ? (Math.floor(p.anim) % 2 ? 1 : 2) : 0;
  const blink = game.frame % 180 < 6;
  b.save();
  if (p.face < 0) { b.translate(x + 16, y); b.scale(-1, 1); b.drawImage(critterSprite(p.slot, frame, blink), 0, 0); }
  else b.drawImage(critterSprite(p.slot, frame, blink), x, y);
  b.restore();
  if (!me) {
    b.font = "bold 7px sans-serif";
    b.textAlign = "center";
    b.fillStyle = "#0008";
    b.fillText(p.name, x + 8, y - 2);
    b.fillStyle = "#fff";
    b.fillText(p.name, x + 8, y - 3);
  }
  if (p.done) { px(x + 6, y - 8, 4, 4, "#ffe14a"); }
}

const tileCache = {};
function tileSprite(theme, kind) {
  const key = theme.song + kind;
  if (tileCache[key]) return tileCache[key];
  const c = document.createElement("canvas");
  c.width = c.height = T;
  const g = c.getContext("2d");
  const r = mulberry32(kind.charCodeAt(0) * 31 + theme.root);
  const p = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  if (kind === "top" || kind === "dirt") {
    p(0, 0, T, T, theme.dirt);
    for (let i = 0; i < 18; i++) p(Math.floor(r() * T), Math.floor(r() * T), 2, 1, theme.dirt2);
    if (kind === "top") {
      p(0, 0, T, 5, theme.grass);
      p(0, 5, T, 1, theme.dirt2);
      for (let i = 0; i < T; i += 3) p(i, 5, 2, 2, theme.grass);
      p(0, 0, T, 1, "#ffffff55");
    }
  } else if (kind === "brick") {
    p(0, 0, T, T, theme.brick);
    p(0, 0, T, 1, "#ffffff44"); p(0, T - 1, T, 1, "#00000055");
    p(0, 7, T, 1, "#00000044"); p(7, 0, 1, 7, "#00000044"); p(3, 8, 1, 8, "#00000044"); p(12, 8, 1, 8, "#00000044");
  } else if (kind === "plank") {
    p(0, 0, T, 6, "#b07a3a"); p(0, 0, T, 1, "#e0a860"); p(0, 5, T, 1, "#6a4420");
    p(2, 6, 2, 3, "#6a4420"); p(12, 6, 2, 3, "#6a4420");
  } else if (kind === "spikes") {
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 7; k++) p(i * 4 + 2 - Math.floor(k / 3), 9 + k, 1 + 2 * Math.floor(k / 3), 1, k < 2 ? "#ffffff" : "#c8c8d8");
    }
    p(0, 15, T, 1, "#7a7a8a");
  } else if (kind === "gate") {
    p(0, 0, T, T, "#00000033");
    for (let i = 2; i < T; i += 5) { p(i, 0, 2, T, "#9a9ab0"); p(i, 0, 1, T, "#d8d8e8"); }
    p(0, 7, T, 2, "#6a6a80");
  }
  return (tileCache[key] = c);
}

function drawBackground(L) {
  const th = L.theme;
  const grad = b.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, th.sky[0]); grad.addColorStop(1, th.sky[1]);
  b.fillStyle = grad;
  b.fillRect(0, 0, VIEW_W, VIEW_H);
  // Nubes o estrellas
  for (let i = 0; i < 8; i++) {
    const cx = ((i * 137 - game.cam * 0.15) % (VIEW_W + 80) + VIEW_W + 80) % (VIEW_W + 80) - 40, cy = 18 + (i * 53) % 70;
    if (th.song === "cueva" || th.song === "castillo") { px(cx, cy, 1, 1, "#ffffffaa"); px(cx + 30, cy + 20, 1, 1, "#ffffff66"); }
    else { ellipse(cx, cy, 14, 5, "#ffffffcc"); ellipse(cx + 10, cy - 3, 9, 5, "#ffffffcc"); }
  }
  // Colinas en dos capas
  for (const [k, color, base, h, step] of [[0.25, th.hill2, 150, 46, 120], [0.45, th.hill, 172, 40, 90]]) {
    for (let i = -1; i < VIEW_W / step + 2; i++) {
      const wx = Math.floor(game.cam * k / step) + i;
      const cx = wx * step - game.cam * k + step / 2;
      const hh = h * (0.6 + ((wx * 7919) % 10) / 25);
      ellipse(cx, base, step * 0.7, hh, color);
    }
    b.fillStyle = color;
    b.fillRect(0, base, VIEW_W, VIEW_H - base);
  }
}

function drawLevel(L) {
  const th = L.theme;
  const x0 = Math.max(0, Math.floor(game.cam / T)), x1 = Math.min(L.w - 1, Math.ceil((game.cam + VIEW_W) / T));
  for (let ty = 0; ty < ROWS; ty++) for (let tx = x0; tx <= x1; tx++) {
    const c = L.tiles[ty][tx];
    const dx = tx * T - Math.round(game.cam), dy = ty * T;
    if (c === "#") b.drawImage(tileSprite(th, tileAt(L, tx, ty - 1) === "#" ? "dirt" : "top"), dx, dy);
    else if (c === "B") b.drawImage(tileSprite(th, "brick"), dx, dy);
    else if (c === "=") b.drawImage(tileSprite(th, "plank"), dx, dy);
    else if (c === "^") b.drawImage(tileSprite(th, "spikes"), dx, dy);
    else if (c === "D") {
      if (!L.gatesOpen) b.drawImage(tileSprite(th, "gate"), dx, dy);
      else if (ty === 0) px(dx + 2, 0, 12, 3, "#9a9ab0");
    }
  }
  // Botones
  for (const pl of L.plates) {
    const dx = pl.x - Math.round(game.cam);
    px(dx + 1, pl.y + 1, 14, 3, "#5a5a6a");
    px(dx + 3, pl.y + (pl.down ? 0 : -2), 10, pl.down ? 2 : 4, pl.down ? "#7dff9a" : "#ff5a5a");
  }
  // Muelles
  for (const s of L.springs) {
    const dx = s.x - Math.round(game.cam), sq = s.squash > 0 ? 4 : 0;
    px(dx, s.y + 6, 14, 2, "#555");
    for (let i = 0; i < 3; i++) px(dx + 3, s.y + 1 + sq / 2 + i * (2 - sq / 6), 8, 1, "#c8c8d8");
    px(dx + 1, s.y + sq, 12, 2, "#ff5a5a");
  }
  // Banderas de control
  for (const c of L.checkpoints) {
    const dx = c.x - Math.round(game.cam);
    px(dx + 3, c.y, 2, 32, "#e8e8f0");
    const col = c.on ? "#4ade80" : "#9a9aa8";
    for (let i = 0; i < 6; i++) px(dx + 5, c.y + 1 + i, 9 - i, 1, col);
  }
  // Meta
  if (L.goal) {
    const g = L.goal, dx = g.x - Math.round(game.cam);
    px(dx + 4, g.y, 2, g.h, "#f2f2f2");
    ellipse(dx + 5, g.y, 3, 3, "#ffe14a", "#a87a00");
    const wave = Math.round(Math.sin(game.frame * 0.1) * 1.5);
    for (let i = 0; i < 10; i++) px(dx + 6, g.y + 4 + i, 14 - i + (i % 3 === 0 ? wave : 0), 1, i % 2 ? "#ff5a8a" : "#ff7aa0");
  }
  // Monedas
  for (const c of L.coins) {
    if (c.taken) continue;
    const dx = c.x - Math.round(game.cam) + 4, ph = Math.floor(game.frame / 8 + c.id) % 4;
    const rx = [4, 3, 1, 3][ph];
    ellipse(dx, c.y + 4, rx, 4, "#ffd23f", "#a87a00");
    if (rx > 1) px(dx - 1, c.y + 1, 1, 3, "#fff6b8");
  }
  // Estrellas
  for (const s of L.stars) {
    if (s.taken) continue;
    const dx = s.x - Math.round(game.cam), dy = s.y + Math.round(Math.sin(game.frame * 0.08 + s.id) * 2);
    drawStar(dx + 6, dy + 6, game.frame % 30 < 15 ? "#fff3a1" : "#ffd23f");
  }
}

function drawStar(cx, cy, color) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 3 : 7, a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  b.fillStyle = "#a87a00";
  b.beginPath(); pts.forEach(([x, y], i) => (i ? b.lineTo(x + 1, y + 1) : b.moveTo(x + 1, y + 1))); b.fill();
  b.fillStyle = color;
  b.beginPath(); pts.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y))); b.fill();
  px(cx - 2, cy - 2, 1, 1, "#1a1020"); px(cx + 1, cy - 2, 1, 1, "#1a1020");
}

function drawEnemy(e) {
  if (!e.alive || e.gone > 0) return;
  const dx = Math.round(e.x - game.cam), dy = Math.round(e.y);
  if (dx < -40 || dx > VIEW_W + 40) return;
  const dir = e.vx > 0 || (e.tx !== undefined && e.tx > e.x) ? 1 : -1;
  if (e.type === "S" || e.type === "T") {
    const squish = Math.floor(game.frame / 10) % 2;
    const body = e.type === "S" ? "#7ed957" : "#b07ae8", out = e.type === "S" ? "#2a5a1a" : "#3a1a5a";
    ellipse(dx + 7, dy + 8 + squish, 7 + squish, 4 - squish, body, out);
    ellipse(dx + 7, dy + 6 + squish, 5, 4 - squish, body);
    px(dx + 4, dy + 5, 2, 2, "#ffffff"); px(dx + 9, dy + 5, 2, 2, "#ffffff");
    px(dx + (dir > 0 ? 5 : 4), dy + 6, 1, 1, "#000"); px(dx + (dir > 0 ? 10 : 9), dy + 6, 1, 1, "#000");
    if (e.type === "T") for (let i = 0; i < 4; i++) { px(dx + 2 + i * 3, dy - 1 + squish, 1, 3, "#f2f2f2"); px(dx + 2 + i * 3, dy - 2 + squish, 1, 1, "#ffffff"); }
  } else if (e.type === "F") {
    const flap = Math.floor(game.frame / 6) % 2;
    ellipse(dx + 7, dy + 6, 6, 4, "#ff8a5a", "#6a2a1a");
    px(dx + (dir > 0 ? 11 : 1), dy + 5, 3, 2, "#ffd23f");
    px(dx + (dir > 0 ? 9 : 4), dy + 4, 1, 1, "#000");
    px(dx + 4, dy + (flap ? 0 : 3), 6, 2, "#ffb08a");
  } else if (e.type === "K") {
    if (e.inv > 0 && game.frame % 6 < 3) return;
    const sq = e.onGround === false ? -2 : 1;
    ellipse(dx + 17, dy + 16 - sq, 16 + sq, 12 - sq, "#ff5a8a", "#6a1030");
    ellipse(dx + 13, dy + 10, 6, 3, "#ffa0c0");
    px(dx + 8, dy + 10, 6, 5, "#ffffff"); px(dx + 20, dy + 10, 6, 5, "#ffffff");
    px(dx + (dir > 0 ? 11 : 9), dy + 12, 2, 2, "#000"); px(dx + (dir > 0 ? 23 : 21), dy + 12, 2, 2, "#000");
    px(dx + 7, dy + 8, 7, 1, "#6a1030"); px(dx + 20, dy + 8, 7, 1, "#6a1030");
    px(dx + 12, dy + 20, 10, 2, "#6a1030");
    for (let i = 0; i < 3; i++) { px(dx + 9 + i * 7, dy + 2, 3, 3, "#ffd23f"); px(dx + 10 + i * 7, dy, 1, 2, "#ffd23f"); }  // corona
    // vida
    for (let i = 0; i < 5; i++) px(dx + 5 + i * 5, dy - 8, 4, 3, i < e.hp ? "#ff3a5a" : "#00000055");
  }
}

function render() {
  const L = game.level;
  if (!L || game.state === "title" || game.state === "online") {
    drawTitleBackground();
  } else {
    // Cámara: sigue a tu personaje.
    const p = game.me;
    const target = clamp(p.x + 5 - VIEW_W / 2 + p.face * 24, 0, L.w * T - VIEW_W);
    game.cam += (target - game.cam) * 0.12;
    game.cam = clamp(game.cam, 0, Math.max(0, L.w * T - VIEW_W));
    const sx = game.shake ? (Math.random() - 0.5) * game.shake * 0.6 : 0;
    b.save();
    b.translate(Math.round(sx), 0);
    drawBackground(L);
    drawLevel(L);
    for (const e of L.enemies) drawEnemy(e);
    drawPlayer(game.other, false);
    drawPlayer(game.me, true);
    for (const pt of game.particles) px(pt.x - game.cam, pt.y, 2, 2, pt.color);
    b.restore();
    // Flecha hacia el compañero si no se ve.
    const o = game.other;
    if (o && !o.done) {
      const ox = o.x - game.cam;
      if (ox < -8 || ox > VIEW_W + 8) {
        const left = ox < 0, ax = left ? 6 : VIEW_W - 10, ay = clamp(o.y, 30, VIEW_H - 20);
        b.fillStyle = "#4fb6ff";
        if (o.slot === 0) b.fillStyle = "#ffa23b";
        for (let i = 0; i < 5; i++) b.fillRect(left ? ax + i : ax + 4 - i, ay - i, 1, i * 2 + 1);
      }
    }
  }
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#1b1440";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(buf, view.x, view.y, view.w, view.h);
}

function drawTitleBackground() {
  const grad = b.createLinearGradient(0, 0, 0, VIEW_H);
  grad.addColorStop(0, "#3a2a8a"); grad.addColorStop(1, "#ff9a7a");
  b.fillStyle = grad; b.fillRect(0, 0, VIEW_W, VIEW_H);
  const t = performance.now() / 1000;
  for (let i = 0; i < 6; i++) ellipse(((i * 97 + t * 8) % (VIEW_W + 60)) - 30, 30 + i * 17, 16, 5, "#ffffff55");
  ellipse(VIEW_W * 0.3, VIEW_H, VIEW_W * 0.5, 50, "#3f9a45");
  ellipse(VIEW_W * 0.8, VIEW_H, VIEW_W * 0.45, 40, "#5fbf5a");
}

// Dibujo de la portada: los dos protagonistas saltando.
function titleArt() {
  const c = $("#title-art"), g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  const tt = performance.now() / 300;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = "#5fbf5a"; g.fillRect(0, 50, c.width, 10);
  g.fillStyle = "#3f9a45"; g.fillRect(0, 50, c.width, 2);
  const j1 = Math.max(0, Math.sin(tt)) * 14, j2 = Math.max(0, Math.sin(tt + 1.6)) * 14;
  g.drawImage(critterSprite(0, j1 > 1 ? 3 : 0, false), 52, 35 - j1, 16, 16);
  g.save(); g.translate(108, 0); g.scale(-1, 1);
  g.drawImage(critterSprite(1, j2 > 1 ? 3 : 0, false), 0, 35 - j2, 16, 16);
  g.restore();
  if (!$("#scr-title").hidden) requestAnimationFrame(titleArt);
}

/* ---------- Interfaz ---------- */
const SCREENS = ["title", "online", "map", "pause", "clear"];
function show(state) {
  game.state = state;
  for (const s of SCREENS) $("#scr-" + s).hidden = s !== state;
  const playing = state === "play";
  $("#hud").hidden = !playing && state !== "pause";
  $("#pad").hidden = !playing;
  if (state === "title") requestAnimationFrame(titleArt);
  if (state === "map") renderMap();
}
function updateHud() {
  const L = game.level;
  if (!L) return;
  $("#hud-coins").textContent = L.coinCount;
  $("#hud-stars").textContent = L.starsGot.map((s) => (s ? "⭐" : "☆")).join("");
  const n = $("#hud-net");
  n.hidden = !net.conn;
  n.textContent = net.conn ? (net.relay ? "👥 Online (servidor)" : "👥 Online") : "";
}
let toastTimer;
function toast(msg, ms = 2200) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function renderMap() {
  const box = $("#levels");
  box.innerHTML = "";
  const guest = net.role === "guest";
  const total = Object.values(save.best).reduce((n, b) => n + b.stars.filter(Boolean).length, 0);
  $("#map-total").textContent = `⭐ ${total} de ${LEVELS.length * 3} estrellas`;
  $("#map-hint").textContent = guest ? "Tu amigo elige el nivel. Espera un momento…" : net.conn ? "Elige un nivel para jugar los dos." : "Supera un nivel para desbloquear el siguiente.";
  const colors = { pradera: "#3f9a45", bosque: "#1e7a4a", cueva: "#4a3a8a", nubes: "#d86aa0", castillo: "#8a2a3a" };
  LEVELS.forEach((def, i) => {
    const btn = document.createElement("button");
    btn.className = "lvl";
    btn.style.background = colors[def.theme];
    const best = save.best[i];
    const stars = best ? best.stars.map((s) => (s ? "⭐" : "☆")).join("") : "☆☆☆";
    btn.innerHTML = `<span>${i + 1}. ${def.name}</span><small>${def.boss ? "👑 Jefe" : stars}</small>`;
    const locked = !net.conn && i + 1 > save.unlocked;
    btn.disabled = guest || locked;
    if (locked) btn.querySelector("small").textContent = "🔒";
    btn.onclick = () => chooseLevel(i);
    box.appendChild(btn);
  });
}
function chooseLevel(i) {
  if (net.role === "host") net.send({ t: "start", level: i });
  startLevel(i);
}
function pause() {
  if (game.state !== "play") return;
  show("pause");
}

$("#go-solo").onclick = () => { audio(); net.stop(); show("map"); };
$("#go-online").onclick = () => { audio(); show("online"); };
for (const el of document.querySelectorAll("[data-back]")) el.onclick = () => { net.stop(); show("title"); };
$("#btn-pause").onclick = pause;
$("#resume").onclick = () => show("play");
$("#restart").onclick = () => {
  if (net.role === "guest") return toast("Tu amigo elige cuándo reiniciar");
  chooseLevel(game.level.idx);
};
$("#to-map").onclick = () => { if (net.role === "guest") return toast("Tu amigo elige el nivel"); if (net.role === "host") net.send({ t: "map" }); show("map"); };
$("#to-title").onclick = () => { net.stop(); show("title"); };
$("#clear-next").onclick = () => chooseLevel(game.level.idx + 1);
$("#clear-map").onclick = () => { if (net.role === "host") net.send({ t: "map" }); show("map"); };
$("#opt-music").checked = save.music;
$("#opt-sfx").checked = save.sfx;
$("#opt-music").onchange = (e) => { save.music = e.target.checked; persist(); if (snd.music) snd.music.gain.value = save.music ? 0.22 : 0; };
$("#opt-sfx").onchange = (e) => { save.sfx = e.target.checked; persist(); };
document.addEventListener("visibilitychange", () => { if (document.hidden && !net.conn) pause(); });

/* ---------- Online ---------- */
// Plan B por el servidor de encuentro si la conexión directa no se puede (igual que el emulador).
const RELAY = "CANDIDATE";
class RelayConn {
  constructor(peer, remote, cid) { this.peer = remote; this._p = peer; this.cid = cid; this.open = false; this.relay = true; this.h = {}; }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, a) { for (const fn of this.h[ev] || []) fn(a); }
  raw(k, extra) { const s = this._p.socket; if (s && !this._p.destroyed) s.send({ type: RELAY, dst: this.peer, payload: { sdRelay: 1, k, cid: this.cid, ...extra } }); }
  send(o) { if (this.open) this.raw("d", { o }); }
  close() { if (this.closed) return; this.closed = true; this.open = false; this.raw("c"); this.emit("close"); }
}
function listenRelay(peer, onConn) {
  const conns = new Map();
  peer.socket.on("message", (m) => {
    const p = m && m.payload;
    if (!p || !p.sdRelay || m.type !== RELAY) return;
    const key = m.src + "|" + p.cid;
    let c = conns.get(key);
    if (p.k === "o" && !c) {
      c = new RelayConn(peer, m.src, p.cid);
      conns.set(key, c);
      onConn(c);
      c.open = true;
      c.raw("a");
      setTimeout(() => c.emit("open"));
    } else if (c && p.k === "a" && !c.open) { c.open = true; c.emit("open"); }
    else if (c && p.k === "d") c.emit("data", p.o);
    else if (c && p.k === "c") { c.open = false; c.emit("close"); conns.delete(key); }
  });
  return conns;
}

const net = {
  peer: null, conn: null, role: null, relay: false, lastSeen: 0, code: "",
  newPeer(id) {
    const opts = { config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }, debug: 0, ...window.SD_PEER_OPTIONS };
    return id ? new Peer(id, opts) : new Peer(opts);
  },
  host() {
    this.stop();
    if (!window.Peer) return toast("No se pudo cargar el online");
    this.role = "host";
    this.code = Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    $("#host-box").hidden = false;
    $("#room-code").textContent = "······";
    $("#host-status").textContent = "Conectando…";
    const peer = this.peer = this.newPeer(PEER_PREFIX + this.code);
    peer.on("open", () => {
      $("#room-code").textContent = this.code;
      $("#host-status").textContent = "Esperando a tu amigo…";
      listenRelay(peer, (c) => this.accept(c));
    });
    peer.on("connection", (c) => this.accept(c));
    peer.on("error", (e) => { if (e.type === "unavailable-id") this.host(); else $("#host-status").textContent = "Error de conexión (" + e.type + "). Prueba otra vez."; });
  },
  accept(c) {
    if (this.conn && this.conn.open) { setTimeout(() => c.close(), 300); return; }
    this.wire(c);
  },
  join(code) {
    this.stop();
    if (!window.Peer) return toast("No se pudo cargar el online");
    this.role = "guest";
    this.code = code;
    toast("Conectando…", 8000);
    const peer = this.peer = this.newPeer();
    peer.on("open", () => {
      const direct = peer.connect(PEER_PREFIX + code, { reliable: true });
      this.wire(direct);
      setTimeout(() => {
        if (this.conn !== direct || direct.open) return;
        // Plan B: por el servidor.
        const rc = new RelayConn(peer, PEER_PREFIX + code, "r" + Math.random().toString(36).slice(2, 9));
        this.wire(rc);
        peer.socket.on("message", (m) => {
          const p = m && m.payload;
          if (!p || !p.sdRelay || p.cid !== rc.cid) return;
          if (p.k === "a" && !rc.open) { rc.open = true; rc.emit("open"); }
          else if (p.k === "d") rc.emit("data", p.o);
          else if (p.k === "c") { rc.open = false; rc.emit("close"); }
        });
        rc.raw("o");
        direct.close();
        setTimeout(() => { if (this.conn === rc && !rc.open) { toast("No se pudo conectar. ¿Tiene tu amigo la sala abierta?", 5000); this.stop(); } }, 12000);
      }, 7000);
    });
    peer.on("error", (e) => { toast(e.type === "peer-unavailable" ? "No existe esa sala. Revisa el código." : "Error de conexión (" + e.type + ")", 5000); if (e.type === "peer-unavailable") this.stop(); });
  },
  wire(c) {
    this.conn = c;
    c.on("open", () => {
      if (this.conn !== c) return;
      this.relay = !!c.relay;
      this.lastSeen = Date.now();
      toast("👥 ¡Conectados!", 2000);
      if (this.role === "host") { show("map"); this.send({ t: "hi" }); }
      else show("map");
      updateHud();
    });
    c.on("data", (m) => { if (this.conn === c) { this.lastSeen = Date.now(); this.onMessage(m); } });
    c.on("close", () => { if (this.conn === c) this.lost(); });
  },
  send(m) { if (this.conn && this.conn.open) this.conn.send(m); },
  lost() {
    this.conn = null;
    game.other = null;
    toast("Tu amigo se ha desconectado. Sigues tú solo.", 4000);
    this.role = null;
    updateHud();
    if (game.state === "map") renderMap();
  },
  stop() {
    if (this.conn) try { this.conn.close(); } catch (e) { /* ya cerrada */ }
    if (this.peer) try { this.peer.destroy(); } catch (e) { /* ya cerrado */ }
    this.conn = this.peer = null;
    this.role = null;
    this.relay = false;
    game.other = null;
    $("#host-box").hidden = true;
  },
  onMessage(m) {
    if (!m || typeof m !== "object") return;
    const L = game.level;
    switch (m.t) {
      case "start": startLevel(m.level); break;
      case "map": show("map"); break;
      case "clear": if (L) levelClear(false); break;
      case "p": {
        const o = game.other;
        if (!o) return;
        o.tx = m.x; o.ty = m.y; o.face = m.f; o.anim = m.a; o.onGround = !!m.g; o.vy = m.g ? 0 : m.vy || 1;
        o.moving = Math.abs(o.tx - o.x) > 0.3; o.vx = o.tx - o.x;
        if (m.d && !o.dead) { o.dead = 1; } else if (!m.d) o.dead = 0;
        o.done = !!m.ok;
        break;
      }
      case "done": if (game.other) game.other.done = true; break;
      case "got": if (L) collect(m.k, m.id, false); break;
      case "cp": if (L) activateCheckpoint(m.id, false); break;
      case "stomp": if (L && net.role === "host") { const e = L.enemies.find((x) => x.id === m.id); if (e && e.alive) { sfx("stomp"); hitEnemy(e); } } break;
      case "gates": if (L && net.role === "guest") { if (m.open !== L.gatesOpen) sfx("gate"); L.gatesOpen = m.open; } break;
      case "boss": if (L && m.dead && !L.bossDead) { L.bossDead = true; L.goal = { x: 36 * T + 4, y: 11 * T - 48, w: 10, h: 64 }; toast("¡Habéis vencido al Gran Blob! Id a la meta 🚩", 3000); } break;
      case "w": {
        if (!L || net.role !== "guest") return;
        for (const [id, x, y, alive, type, inv, hp] of m.e) {
          let e = L.enemies.find((q) => q.id === id);
          if (!e) { e = { id, type, x, y, w: type === "K" ? 34 : 14, h: type === "K" ? 28 : type === "F" ? 11 : 12, vx: 0, vy: 0, alive: true }; L.enemies.push(e); }
          e.tx = x; e.ty = y; e.alive = !!alive; e.inv = inv; e.hp = hp; e.vx = x - e.x;
          e.onGround = true;
        }
        break;
      }
    }
  },
};
// Latido: si no llega nada en 12 s, se considera desconectado.
setInterval(() => {
  if (!net.conn || !net.conn.open) return;
  net.send({ t: "ping" });
  if (Date.now() - net.lastSeen > 12000) { const c = net.conn; net.lost(); try { c.close(); } catch (e) { /* ya cerrada */ } }
}, 2000);

$("#go-host").onclick = () => net.host();
$("#share-room").onclick = () => {
  const url = `${location.origin}${location.pathname}?sala=${net.code}`;
  const text = `¡Juega conmigo a Salta Dúo! Código: ${net.code}`;
  if (navigator.share) navigator.share({ title: "Salta Dúo", text, url }).catch(() => {});
  else navigator.clipboard.writeText(url).then(() => toast("Enlace copiado"), () => toast("Código: " + net.code));
};
$("#join-form").onsubmit = (e) => {
  e.preventDefault();
  const code = $("#join-code").value.trim().toUpperCase();
  if (code.length < 4) return toast("Escribe el código que te ha pasado tu amigo");
  audio();
  net.join(code);
};

/* ---------- Arranque ---------- */
show("title");
requestAnimationFrame(loop);
const sala = new URLSearchParams(location.search).get("sala");
if (sala) { history.replaceState(null, "", location.pathname); show("online"); $("#join-code").value = sala.toUpperCase(); net.join(sala.toUpperCase()); }
window.__saltaduo = { game, net, LEVELS, buildGrid, startLevel, input };   // para pruebas
