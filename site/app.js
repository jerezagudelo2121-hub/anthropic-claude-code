"use strict";

/* GBA Web: interfaz para iPhone sobre gpSP (WebAssembly) + multijugador por WebRTC. */

const CORES = { gba: "gpsp/gpsp.wasm", snes: "snes/snes9x.wasm" };
const SNES_EXT = /\.(sfc|smc|swc|fig)$/i;
const systemOf = (name) => (SNES_EXT.test(name || "") ? "snes" : "gba");
const PEER_PREFIX = "gbaweb-v2-";
const APP_VERSION = "2026.11.10b";   // se ve en la portada; sube al publicar cambios del multijugador
const ICE_BASE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Retransmisión (TURN) gratuita y pública: se usa solo si no se puede conectar directo
  // (datos móviles, algunos proveedores de internet). Pueden cambiar o dejar de funcionar;
  // para algo fiable, cada uno puede poner el suyo en la web (🛰️ Retransmisión propia).
  { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
  { urls: ["turn:freestun.net:3478", "turn:freestun.net:3478?transport=tcp"], username: "free", credential: "free" },
];
// Tu servidor TURN (guardado en este móvil): { urls, username, credential }.
function customTurn() {
  const t = parseJSON(lsGet("gbaweb-turn") || "null");
  return t && t.urls ? t : null;
}
function iceServers() {
  const t = customTurn();
  if (!t) return ICE_BASE;
  const urls = String(t.urls).split(/[\s,]+/).filter(Boolean).map((u) => (/^turns?:/.test(u) ? u : "turn:" + u));
  return [{ urls, username: t.username || "", credential: t.credential || "" }, ...ICE_BASE];
}
const SLOTS = 3;
const COVER_EVERY_MS = 30000;
const MAX_GUESTS = 4; // el adaptador inalámbrico admite hasta 5 consolas
const BROADCAST = 0xffff;

// Bits del mando (RetroPad de libretro).
const BUTTONS = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
const KEYMAP = {
  ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  KeyZ: "A", KeyX: "B", KeyQ: "L", KeyE: "R", KeyA: "L", KeyS: "R",
  Enter: "START", KeyV: "SELECT", Backspace: "SELECT", KeyC: "Y", KeyD: "X",
};
// Mando Bluetooth (mapeo estándar): botón derecho = A, inferior = B.
const PADMAP = { 1: "A", 0: "B", 2: "Y", 3: "X", 4: "L", 5: "R", 6: "L", 7: "R", 8: "SELECT", 9: "START", 12: "UP", 13: "DOWN", 14: "LEFT", 15: "RIGHT" };

const $ = (sel) => document.querySelector(sel);

/* ---------- IndexedDB: ROMs, partidas, estados y BIOS ---------- */

const db = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open("gbaweb", 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ["roms", "states", "saves", "files"]) {
        if (!d.objectStoreNames.contains(name)) {
          d.createObjectStore(name, name === "roms" ? { keyPath: "name" } : undefined);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: (store, key) => run(store, "readonly", (s) => s.get(key)),
    put: (store, value, key) => run(store, "readwrite", (s) => s.put(value, key)),
    del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
    all: (store) => run(store, "readonly", (s) => s.getAll()),
  };
})();

const safeGet = (store, key) => db.get(store, key).catch(() => undefined);

/* ---------- Utilidades de interfaz ---------- */

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function screenMsg(msg) {
  const el = $("#screen-msg");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function setNetStatus(text, kind) {
  const el = $("#net-status");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "net-pill" + (kind ? " " + kind : "");
}

function showView(id) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== id));
  if (id === "console") trapBack();
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleDateString();
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------- Pantalla de inicio ---------- */

async function renderBios() {
  const bios = await safeGet("files", "bios");
  const el = $("#bios-status");
  el.textContent = bios ? "Cargada ✓" : "No cargada";
  el.classList.toggle("ok", !!bios);
}

/* ---------- Biblioteca de juegos ---------- */

let library = [];
let sheetRom = null;

function romTitle(rom) {
  return rom.title || baseName(rom.name);
}

function formatSize(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
}

async function loadLibrary() {
  try { library = await db.all("roms"); } catch (e) { library = []; }
  migrateRoms();
  library.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || romTitle(a).localeCompare(romTitle(b)));
  renderLibrary();
}

// ROMs guardadas por versiones anteriores como archivo: se copian a bytes mientras aún se puedan
// leer; si iOS ya las borró, se marcan para volver a añadirlas (la partida no se pierde).
let migrating = false;
async function migrateRoms() {
  if (migrating) return;
  migrating = true;
  let changed = false;
  for (const rom of library) {
    if (!(rom.data instanceof Blob) || rom.missing) continue;
    try {
      const data = new Uint8Array(await rom.data.arrayBuffer());
      await db.put("roms", { ...rom, data, size: data.length });
      rom.data = data;
    } catch (e) {
      console.warn("ROM perdida:", rom.name, e);
      rom.missing = true;
      await updateRom(rom.name, { missing: true }).catch(() => {});
    }
    changed = true;
  }
  migrating = false;
  if (changed) renderLibrary();
}

// Volver a elegir el archivo de una ROM perdida: se guarda con el mismo nombre, así sigue
// con sus partidas.
let relinkName = null;
function relinkRom(rom) {
  relinkName = rom.name;
  toast(`Elige otra vez el archivo de «${romTitle(rom)}». Tus partidas siguen guardadas.`, 6000);
  $("#rom-input").click();
}

function renderLibrary() {
  const query = $("#lib-search").value.trim().toLowerCase();
  const grid = $("#lib-grid");
  grid.innerHTML = "";
  $("#lib-empty").hidden = library.length > 0;
  $("#lib-add").hidden = library.length === 0;
  $("#lib-search").hidden = library.length < 5;
  $("#lib-count").textContent = library.length;
  $("#lib-count").hidden = library.length === 0;
  for (const rom of library) {
    const title = romTitle(rom);
    if (query && !title.toLowerCase().includes(query)) continue;
    const card = document.createElement("div");
    card.className = "game-card";
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    let cover;
    if (rom.cover) {
      cover = document.createElement("img");
      cover.src = rom.cover;
      cover.alt = "";
    } else {
      cover = document.createElement("div");
      cover.textContent = title.replace(/^pok[eé]mon\s*/i, "").slice(0, 2).toUpperCase() || "GBA";
    }
    cover.className = "cover";
    const snes = (rom.system || systemOf(rom.name)) === "snes";
    const info = document.createElement("div");
    info.className = "meta-info";
    info.innerHTML = "<b></b><small></small>";
    info.firstChild.textContent = title;
    info.lastChild.textContent = (rom.lastPlayed ? "Jugado " + timeAgo(rom.lastPlayed) : "Nuevo") + (partidas(rom).length > 1 ? " · " + currentPartida(rom).name : "");
    const more = document.createElement("button");
    more.className = "more";
    more.textContent = "⋯";
    more.setAttribute("aria-label", "Opciones de " + title);
    more.onclick = (e) => {
      e.stopPropagation();
      openGameSheet(rom);
    };
    card.append(cover, info, more);
    if (snes) {
      const tag = document.createElement("span");
      tag.className = "sys-tag";
      tag.textContent = "SNES";
      card.appendChild(tag);
    }
    card.onclick = () => (rom.missing ? relinkRom(rom) : playRom(rom));
    if (rom.missing) {
      card.classList.add("missing");
      info.lastChild.textContent = "⚠️ Toca para volver a elegir la ROM (tu partida sigue guardada)";
    }
    grid.appendChild(card);
  }
  updateStorageInfo();
}

async function updateStorageInfo() {
  const el = $("#lib-storage");
  if (!library.length || !navigator.storage || !navigator.storage.estimate) return (el.textContent = "");
  try {
    const { usage } = await navigator.storage.estimate();
    el.textContent = `Ocupa ${formatSize(usage)} en este dispositivo. Tus juegos no se suben a internet.`;
  } catch (e) {
    el.textContent = "";
  }
}

// Se guarda una copia de los bytes de la ROM (no el archivo elegido): en iPhone, guardar el
// archivo tal cual deja solo una referencia que iOS puede borrar con el tiempo
// ("The object can not be found here"). targetName vuelve a enlazar una ROM perdida.
async function addToLibrary(files, targetName) {
  let added = 0;
  for (const file of files) {
    try {
      const name = targetName || file.name;
      const old = library.find((r) => r.name === name);
      const data = new Uint8Array(await file.arrayBuffer());
      await db.put("roms", { ...old, name, data, size: data.length, missing: false, added: (old && old.added) || Date.now() });
      added++;
    } catch (e) {
      console.warn("No se pudo guardar", file.name, e);
      toast("No hay espacio para guardar " + file.name, 4000);
    }
  }
  // Pide al navegador que no borre la biblioteca si falta espacio.
  if (added && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await loadLibrary();
  return added;
}

async function updateRom(name, changes) {
  const rom = await safeGet("roms", name);
  if (!rom) return;
  try { await db.put("roms", { ...rom, ...changes }); } catch (e) { console.warn(e); }
}

/* ---------- Partidas: varias por juego, cada una con su guardado y sus ranuras ---------- */

function partidas(rom) {
  return rom.saves && rom.saves.length ? rom.saves : [{ id: "1", name: "Partida 1" }];
}
function currentPartida(rom) {
  const list = partidas(rom);
  return list.find((p) => p.id === rom.current) || list[0];
}
// La partida 1 usa la clave de siempre, así las partidas guardadas de antes siguen ahí.
function saveKeyFor(rom, id) {
  return id === "1" ? baseName(rom.name) : `${baseName(rom.name)}#p${id}`;
}

function playRom(rom, pid) {
  pid = pid || currentPartida(rom).id;
  if (engine) {
    // El motor no se puede reiniciar con otro juego: se guarda y se recarga la página.
    persistSave();
    try { sessionStorage.setItem("gbaweb-play", JSON.stringify({ name: rom.name, pid })); } catch (e) { /* sin almacenamiento */ }
    return setTimeout(() => location.replace(location.pathname), 150);
  }
  startGame(new File([rom.data], rom.name), rom, pid);
}

// Pide un texto con una ventana propia; devuelve null si se cancela.
function askText(title, value = "", okLabel = "Aceptar", maxLength = 30) {
  return new Promise((resolve) => {
    const sheet = $("#ask-sheet"), input = $("#ask-input"), form = $("#ask-form");
    $("#ask-title").textContent = title;
    $("#ask-ok").textContent = okLabel;
    input.maxLength = maxLength;
    input.value = value;
    sheet.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const done = (v) => {
      sheet.hidden = true;
      form.onsubmit = null;
      $("#ask-cancel").onclick = null;
      sheet.onclick = null;
      input.blur();
      resolve(v);
    };
    form.onsubmit = (e) => { e.preventDefault(); done(input.value); };
    $("#ask-cancel").onclick = () => done(null);
    sheet.onclick = (e) => { if (e.target === sheet) done(null); };
  });
}

let savesRom = null;

async function openSaves(romOrName) {
  const rom = typeof romOrName === "string" ? await safeGet("roms", romOrName) : romOrName;
  if (!rom) return toast("No encuentro este juego en la biblioteca");
  savesRom = rom;
  $("#ss-title").textContent = "📂 " + romTitle(rom);
  const list = $("#ss-list");
  list.innerHTML = "";
  const cur = currentPartida(rom);
  for (const p of partidas(rom)) {
    const hasSave = !!(await safeGet("saves", saveKeyFor(rom, p.id)));
    const row = document.createElement("div");
    row.className = "save-row" + (p.id === cur.id ? " current" : "");
    row.innerHTML = `<div class="save-info"><b></b><small></small></div>
      <button class="btn primary" data-sv="play">▶</button>
      <button class="btn icon" data-sv="rename" aria-label="Renombrar">✏️</button>
      <button class="btn icon" data-sv="delete" aria-label="Borrar">🗑️</button>`;
    row.querySelector("b").textContent = p.name + (p.id === cur.id ? " · actual" : "");
    row.querySelector("small").textContent = (hasSave ? "Con progreso" : "Sin empezar") + (p.last ? " · jugada " + timeAgo(p.last) : "");
    row.dataset.pid = p.id;
    list.append(row);
  }
  $("#saves-sheet").hidden = false;
}

async function setPartidas(rom, saves, current) {
  rom.saves = saves;
  if (current) rom.current = current;
  await updateRom(rom.name, { saves, current: rom.current });
}

$("#ss-close").onclick = () => ($("#saves-sheet").hidden = true);
$("#saves-sheet").addEventListener("click", async (e) => {
  if (e.target.id === "saves-sheet") return ($("#saves-sheet").hidden = true);
  const btn = e.target.closest("[data-sv]");
  if (!btn || !savesRom) return;
  const rom = savesRom, pid = btn.closest(".save-row").dataset.pid;
  const list = partidas(rom).map((p) => ({ ...p }));
  const p = list.find((x) => x.id === pid);
  if (btn.dataset.sv === "play") {
    $("#saves-sheet").hidden = true;
    $("#game-sheet").hidden = true;
    closeMenu();
    if (engine && libraryName === rom.name && saveKey === saveKeyFor(rom, pid)) return toast("Ya estás jugando esta partida");
    await setPartidas(rom, list, pid);
    return playRom(rom, pid);
  }
  if (btn.dataset.sv === "rename") {
    const name = await askText("✏️ Nombre de la partida", p.name, "Guardar");
    if (!name || !name.trim()) return;
    p.name = name.trim().slice(0, 30);
    await setPartidas(rom, list);
    return openSaves(rom);
  }
  if (btn.dataset.sv === "delete") {
    if (engine && saveKey === saveKeyFor(rom, pid)) return toast("No puedes borrar la partida que estás jugando");
    const only = list.length === 1;
    if (!confirm(only ? `¿Borrar todo el progreso de «${p.name}»? Se empezará de cero.` : `¿Borrar «${p.name}» y todo su progreso?`)) return;
    const key = saveKeyFor(rom, pid);
    await db.del("saves", key).catch(() => {});
    for (let slot = 1; slot <= SLOTS; slot++) await db.del("states", `${key}#${slot}`).catch(() => {});
    if (!only) {
      const rest = list.filter((x) => x.id !== pid);
      await setPartidas(rom, rest, rom.current === pid ? rest[0].id : rom.current);
    }
    toast(only ? "Progreso borrado" : "Partida borrada");
    return openSaves(rom);
  }
});

$("#ss-new").onclick = async () => {
  const rom = savesRom;
  if (!rom) return;
  const list = partidas(rom).map((p) => ({ ...p }));
  const name = await askText("➕ Nueva partida", `Partida ${list.length + 1}`, "Empezar");
  if (name === null) return;
  const id = Date.now().toString(36);
  list.push({ id, name: (name.trim() || `Partida ${list.length + 1}`).slice(0, 30) });
  await setPartidas(rom, list, id);
  $("#saves-sheet").hidden = true;
  $("#game-sheet").hidden = true;
  closeMenu();
  toast("Nueva partida creada");
  playRom(rom, id);
};

function openGameSheet(rom) {
  sheetRom = rom;
  $("#gs-title").textContent = romTitle(rom);
  const parts = [formatSize(rom.size || (rom.data && (rom.data.size || rom.data.length)) || 0)];
  parts.push(rom.lastPlayed ? "jugado " + timeAgo(rom.lastPlayed) : "sin jugar");
  $("#gs-info").textContent = parts.join(" · ");
  $("[data-gs=cover]").hidden = !rom.cover;
  const n = partidas(rom).length;
  $("#gs-saves-count").textContent = n > 1 ? `(${n})` : "";
  $("#game-sheet").hidden = false;
}

$("#game-sheet").addEventListener("click", async (e) => {
  if (e.target.id === "game-sheet") return ($("#game-sheet").hidden = true);
  const action = e.target.closest("[data-gs]");
  if (!action || !sheetRom) return;
  const rom = sheetRom;
  switch (action.dataset.gs) {
    case "play":
      $("#game-sheet").hidden = true;
      return playRom(rom);
    case "saves":
      $("#game-sheet").hidden = true;
      return openSaves(rom);
    case "rename": {
      const title = await askText("✏️ Nombre del juego", romTitle(rom), "Guardar", 60);
      if (!title || !title.trim()) return;
      await updateRom(rom.name, { title: title.trim() });
      break;
    }
    case "export": {
      const cur = currentPartida(rom);
      const save = await safeGet("saves", saveKeyFor(rom, cur.id));
      if (!save) return toast("Esta partida aún no tiene progreso guardado");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([save]));
      a.download = baseName(rom.name) + (cur.id === "1" ? "" : " - " + cur.name) + ".sav";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return;
    }
    case "cover":
      await updateRom(rom.name, { cover: null });
      break;
    case "delete":
      if (!confirm(`¿Eliminar «${romTitle(rom)}» de la biblioteca?\nTu partida guardada no se borra: si vuelves a añadir el juego, seguirá ahí.`)) return;
      await db.del("roms", rom.name).catch(() => {});
      toast("Juego eliminado");
      break;
    case "close":
      break;
  }
  $("#game-sheet").hidden = true;
  loadLibrary();
});

$("#lib-search").addEventListener("input", renderLibrary);

$("#rom-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  if (relinkName && files.length === 1) {
    const name = relinkName;
    relinkName = null;
    if (!(await addToLibrary(files, name))) return;
    toast("¡ROM recuperada! Sigues con tu partida.", 4000);
    const rom = library.find((r) => r.name === name);
    return rom && playRom(rom);
  }
  relinkName = null;
  const added = await addToLibrary(files);
  // Si te han invitado a jugar juntos (o solo eliges uno), el juego arranca directamente.
  if (files.length === 1 && added) {
    const rom = library.find((r) => r.name === files[0].name);
    if (rom) return playRom(rom);
  }
  if (added) toast(added === 1 ? "Juego añadido a tu biblioteca" : `${added} juegos añadidos a tu biblioteca`);
});

$("#bios-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length !== 16384 || data[0] !== 0x18) {
    return toast("Ese archivo no parece una BIOS de GBA (gba_bios.bin, 16 KB)", 4000);
  }
  await db.put("files", data, "bios");
  renderBios();
  toast("BIOS guardada");
});

$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#join-code").value.trim().toUpperCase();
  if (code.length < 4) return toast("Escribe el código que te envió tu amigo");
  net.join(code);
});

/* ---------- Arrancar el juego ---------- */

let engine = null;
let system = "gba";   // "gba" | "snes"
let romName = "";
let saveKey = "";     // clave del guardado de la partida en curso
let lastSave = null;
let libraryName = "";
let lastCover = 0;

async function readRom(file) {
  let data = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  if (data[0] === 0x50 && data[1] === 0x4b) { // .zip
    const files = fflate.unzipSync(data, { filter: (f) => /\.(gba|agb|bin|sfc|smc|swc|fig)$/i.test(f.name) });
    const entry = Object.keys(files)[0];
    if (!entry) throw new Error("El .zip no contiene ningún juego (.gba, .sfc o .smc)");
    data = files[entry];
    name = entry.split("/").pop();
  }
  return { data, name, system: systemOf(name) };
}

async function startGame(file, record, pid) {
  if (engine) return location.reload();
  showView("console");
  document.body.classList.remove("guest");
  screenMsg("Cargando…");
  try {
    const rom = await readRom(file);
    romName = baseName(rom.name);
    libraryName = file.name;
    system = rom.system;
    document.body.classList.toggle("snes", system === "snes");
    if (!record) record = await safeGet("roms", file.name);
    const part = record ? (partidas(record).find((p) => p.id === pid) || currentPartida(record)) : { id: "1", name: "Partida 1" };
    saveKey = record ? saveKeyFor(record, part.id) : romName;
    $("#game-title").textContent = (record ? romTitle(record) : romName) + (record && partidas(record).length > 1 ? " · " + part.name : "");
    if (record) {
      const saves = partidas(record).map((p) => (p.id === part.id ? { ...p, last: Date.now() } : p));
      updateRom(libraryName, { lastPlayed: Date.now(), saves, current: part.id, system });
    }
    const bios = system === "gba" ? await safeGet("files", "bios") : null;
    engine = await GbaEngine.create(CORES[system], $("#game"), system);
    applyGraphics();
    if (!engine.load(rom.data, bios)) throw new Error("El emulador no pudo abrir este juego.");
    const saved = await safeGet("saves", saveKey);
    if (saved) engine.setSave(saved);
    lastSave = engine.getSave();
    engine.onFrame = pollGamepads;
    engine.resumeAudio();
    engine.start();
    lastCover = Date.now() - COVER_EVERY_MS / 2; // primera portada a los ~15 s
    screenMsg("");
    renderSlots();
    setInterval(persistSave, 5000);
    if (net.pendingLink) net.sendReady();
    friends.broadcastStatus();
  } catch (err) {
    console.error(err);
    if (err && (err.name === "NotFoundError" || /can ?not be found|could not be found/i.test(err.message || "")) && record) {
      // iOS borró la copia del archivo: se marca para volver a elegirlo. Las partidas están aparte.
      await updateRom(record.name, { missing: true }).catch(() => {});
      screenMsg("");
      const el = $("#screen-msg");
      el.hidden = false;
      el.innerHTML = '<div><p>El iPhone ha borrado la copia de este juego, pero <b>tu partida sigue guardada</b>.</p><button class="btn primary" type="button">📂 Volver a elegir la ROM</button><p class="hint">Elige el mismo juego (el mismo archivo .gba) y seguirás donde ibas.</p></div>';
      el.querySelector("button").onclick = () => relinkRom(record);
      return;
    }
    screenMsg("No se pudo cargar: " + err.message);
  }
}

// Portada de la biblioteca: una captura de la pantalla del juego.
function saveCover(force) {
  if (!engine || !engine.running || !libraryName) return;
  if (!force && Date.now() - lastCover < COVER_EVERY_MS) return;
  lastCover = Date.now();
  try {
    // No guardar pantallas negras (cargas, transiciones).
    if (engine.brightness() < 10) return;
    updateRom(libraryName, { cover: engine.snapshot().toDataURL("image/jpeg", 0.85) });
  } catch (e) { /* lienzo no disponible */ }
}

async function persistSave() {
  if (!engine || sync.foreign) return; // jugando en la partida de tu amigo: tu guardado no se toca
  saveCover(false);
  const data = engine.getSave();
  if (!data || sameBytes(data, lastSave)) return;
  lastSave = data;
  try { await db.put("saves", data, saveKey); } catch (e) { console.warn(e); }
}

// iOS puede cerrar la pestaña sin avisar: guarda al salir de la app.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveCover(true);
    persistSave();
  }
});
window.addEventListener("pagehide", persistSave);

["touchend", "pointerdown", "keydown"].forEach((t) =>
  window.addEventListener(t, () => engine && engine.resumeAudio(), true));

/* ---------- Entrada: mando táctil, teclado y mandos Bluetooth ---------- */

let touchMask = 0, keyMask = 0, padMask = 0, remoteMask = 0;

function applyButtons() {
  const mask = touchMask | keyMask | padMask;
  if (net.role === "viewer") {
    if (mask !== applyButtons.sent) net.sendJSON(net.conn, { t: "k", m: mask });
    applyButtons.sent = mask;
    return;
  }
  if (engine) engine.buttons = mask | (net.mode === "screen" && net.guestControl ? remoteMask : 0);
}

const pad = $("#pad");
const dpad = $("[data-dpad]");
const arms = { UP: dpad.querySelector(".up"), DOWN: dpad.querySelector(".down"), LEFT: dpad.querySelector(".left"), RIGHT: dpad.querySelector(".right") };
const padButtons = {};
pad.querySelectorAll("[data-btn]").forEach((el) => (padButtons[el.dataset.btn] = el));
padButtons.FF = pad.querySelector("[data-action=ff]");

const touchZones = new Map(); // identificador del dedo -> "dpad" | "buttons"
let pressedNow = new Set();

function dpadDirections(x, y, out) {
  const r = dpad.getBoundingClientRect();
  const dx = x - (r.left + r.width / 2);
  const dy = y - (r.top + r.height / 2);
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < r.width * 0.1) return; // zona muerta central
  if (ax > ay * 0.45) out.add(dx < 0 ? "LEFT" : "RIGHT");
  if (ay > ax * 0.45) out.add(dy < 0 ? "UP" : "DOWN");
}

function hitTest(x, y, zone, out) {
  if (zone === "dpad") return dpadDirections(x, y, out);
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const btn = el.closest("[data-btn], [data-action=ff]");
  if (btn && pad.contains(btn)) out.add(btn.dataset.btn || "FF");
  else if (el.closest("[data-dpad]")) dpadDirections(x, y, out);
}

function updatePressed(points) {
  const next = new Set();
  for (const p of points) hitTest(p.x, p.y, p.zone, next);
  for (const name of pressedNow) if (!next.has(name)) (arms[name] || padButtons[name]).classList.remove("on");
  let newPress = false;
  for (const name of next) if (!pressedNow.has(name)) {
    (arms[name] || padButtons[name]).classList.add("on");
    newPress = true;
  }
  if (newPress) haptic();
  pressedNow = next;
  touchMask = 0;
  for (const name of next) if (name in BUTTONS) touchMask |= 1 << BUTTONS[name];
  const hold = next.has("FF");
  if (hold && !ffHold && !ffAllowed()) toast("La velocidad rápida no funciona en multijugador");
  ffHold = hold;
  updateFastForward();
  applyButtons();
}

function onTouch(e) {
  e.preventDefault();
  if (e.type === "touchstart") {
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      touchZones.set(t.identifier, el && el.closest("[data-dpad]") ? "dpad" : "buttons");
    }
  }
  if (e.type === "touchend" || e.type === "touchcancel") {
    for (const t of e.changedTouches) touchZones.delete(t.identifier);
  }
  updatePressed([...e.touches].map((t) => ({ x: t.clientX, y: t.clientY, zone: touchZones.get(t.identifier) })));
}
["touchstart", "touchmove", "touchend", "touchcancel"].forEach((t) => pad.addEventListener(t, onTouch, { passive: false }));

// Ratón (para probar en el ordenador).
let mouseZone = null;
pad.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") return;
  mouseZone = e.target.closest("[data-dpad]") ? "dpad" : "buttons";
  updatePressed([{ x: e.clientX, y: e.clientY, zone: mouseZone }]);
});
window.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && mouseZone) updatePressed([{ x: e.clientX, y: e.clientY, zone: mouseZone }]);
});
window.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse" || !mouseZone) return;
  mouseZone = null;
  updatePressed([]);
});

function onKey(e) {
  if (!$("#menu").hidden || $("#console").hidden) return;
  const name = KEYMAP[e.code];
  if (!name) return;
  e.preventDefault();
  const bit = 1 << BUTTONS[name];
  keyMask = e.type === "keydown" ? keyMask | bit : keyMask & ~bit;
  applyButtons();
}
window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);

function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let mask = 0;
  for (const gp of pads) {
    if (!gp) continue;
    gp.buttons.forEach((b, i) => {
      if (b.pressed && PADMAP[i]) mask |= 1 << BUTTONS[PADMAP[i]];
    });
    const [x = 0, y = 0] = gp.axes;
    if (x < -0.5) mask |= 1 << BUTTONS.LEFT;
    if (x > 0.5) mask |= 1 << BUTTONS.RIGHT;
    if (y < -0.5) mask |= 1 << BUTTONS.UP;
    if (y > 0.5) mask |= 1 << BUTTONS.DOWN;
  }
  if (mask !== padMask) {
    padMask = mask;
    applyButtons();
  }
}

// Avance rápido: velocidad elegida en el menú (x1–x8) o botón ⏩ mantenido (al menos x4).
// En multijugador se desactiva: la otra consola seguiría a velocidad normal y se perdería la conexión.
const HOLD_SPEED = 4;
let ffHold = false;
let chosenSpeed = 1;

function linkActive() {
  return isRoomMode(net.mode) && (net.role === "host" || net.role === "guest");
}

// Modo de la sala "Jugar juntos": cable link (GBA) o dos mandos sincronizados (Super Nintendo).
const isRoomMode = (mode) => mode === "link" || mode === "sync";
const roomMode = () => (system === "snes" ? "sync" : "link");

function ffAllowed() {
  return !net.role;
}

function updateFastForward() {
  const allowed = ffAllowed();
  if (!allowed) chosenSpeed = 1;
  const speed = !allowed ? 1 : ffHold ? Math.max(chosenSpeed, HOLD_SPEED) : chosenSpeed;
  if (engine) engine.speed = speed;
  padButtons.FF.classList.toggle("on", speed > 1);
  padButtons.FF.classList.toggle("disabled", !allowed);
  padButtons.FF.textContent = chosenSpeed > 1 ? "⏩x" + chosenSpeed : "⏩";
  for (const btn of document.querySelectorAll("[data-speed]")) {
    btn.classList.toggle("primary", Number(btn.dataset.speed) === chosenSpeed);
    btn.disabled = !allowed;
  }
  $("#speed-note").textContent = allowed ? "(mantén ⏩ para ir a x" + HOLD_SPEED + ")" : "(no disponible online)";
}

$("#speeds").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-speed]");
  if (!btn) return;
  if (!ffAllowed()) return toast("La velocidad rápida no funciona en multijugador");
  chosenSpeed = Number(btn.dataset.speed);
  updateFastForward();
  closeMenu();
  toast(chosenSpeed === 1 ? "Velocidad normal" : "Velocidad x" + chosenSpeed);
});

/* ---------- Gráficos y mando ---------- */

const graphics = {
  shader: lsGet("gbaweb-shader") || "pixel",
  colors: lsGet("gbaweb-colors") === "1",
};

function applyGraphics() {
  if (engine) {
    engine.renderer.setShader(graphics.shader);
    engine.renderer.setColorCorrection(graphics.colors);
  }
  for (const b of document.querySelectorAll("[data-shader]")) b.classList.toggle("active", b.dataset.shader === graphics.shader);
  $("#color-correct").checked = graphics.colors;
}

function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* sin almacenamiento */ }
}

$("#shaders").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-shader]");
  if (!btn) return;
  graphics.shader = btn.dataset.shader;
  saveSetting("gbaweb-shader", graphics.shader);
  applyGraphics();
  if (engine && !engine.renderer.webgl) toast("Tu navegador no permite filtros gráficos (WebGL)");
});

$("#color-correct").addEventListener("change", (e) => {
  graphics.colors = e.target.checked;
  saveSetting("gbaweb-colors", graphics.colors ? "1" : "0");
  applyGraphics();
});

function setPadHidden(hidden) {
  document.body.classList.toggle("pad-hidden", hidden);
  $("[data-action=toggle-pad]").textContent = hidden ? "🎮 Mostrar mando" : "🎮 Ocultar mando";
  saveSetting("gbaweb-pad-hidden", hidden ? "1" : "0");
}

/* ---------- Personalizar: diseño de la consola y fondo ---------- */

const SKINS = [
  { id: "morado", name: "Medianoche", shell: "linear-gradient(180deg,#2a2450,#17132e)", key: "#3a3466", a: "#8f74ff", b: "#8f74ff" },
  { id: "dmg", name: "Gris clásico", shell: "linear-gradient(#dcdad3,#bdbab1)", key: "#34343b", a: "#b02a5c", b: "#b02a5c" },
  { id: "atomic", name: "Morado transparente", shell: "linear-gradient(160deg,#7b4fe0,#2c1670)", key: "#4a2fa8", a: "#a68bff", b: "#a68bff" },
  { id: "plata", name: "Plata", shell: "linear-gradient(115deg,#eef1f5,#c3c9d2 40%,#a9b1bc)", key: "#2a2e35", a: "#2c3038", b: "#2c3038" },
  { id: "retro8", name: "Retro 8 bits", shell: "linear-gradient(180deg,#c8c4bc 0 46%,#2a2a2a 46% 50%,#d9d5cd 50%)", key: "#1a1a1a", a: "#d7192f", b: "#d7192f" },
  { id: "retro16", name: "Retro 16 bits", shell: "linear-gradient(#d6d6de,#b6b6c2)", key: "#4a4a55", a: "#e0322f", b: "#f2c014" },
  { id: "electrico", name: "Amarillo eléctrico", shell: "linear-gradient(#ffd84a,#f4b000)", key: "#2a2a2a", a: "#e8402f", b: "#e8402f" },
  { id: "neon", name: "Neón", shell: "#07060f", key: "#00e5ff", a: "#ff2bd6", b: "#00d5f0" },
  { id: "negro", name: "Negro mate", shell: "linear-gradient(#1e1e20,#0c0c0d)", key: "#2c2c30", a: "#3a3a40", b: "#3a3a40" },
  { id: "coral", name: "Coral", shell: "linear-gradient(#ff8a7a,#e85d50)", key: "#3a2a2e", a: "#2a2a30", b: "#2a2a30" },
  { id: "cielo", name: "Azul cielo", shell: "linear-gradient(#8fd0ff,#4f9fe0)", key: "#24364f", a: "#ffd23f", b: "#ffd23f" },
  { id: "menta", name: "Verde menta", shell: "linear-gradient(#a8f0d0,#5fcf9f)", key: "#244a3a", a: "#ff6a8a", b: "#ff6a8a" },
  { id: "hielo", name: "Hielo transparente", shell: "linear-gradient(160deg,#dff3ffcc,#9fd4f5aa)", key: "#3b5f80", a: "#ffffff", b: "#ffffff" },
];

const BACKGROUNDS = [
  { id: "", name: "Ninguno", css: "" },
  { id: "atardecer", name: "Atardecer", css: "radial-gradient(60% 40% at 50% 70%,#ffd27a88,transparent 70%),linear-gradient(180deg,#ff9a5a,#ff5e7e 45%,#5b2a86)" },
  { id: "oceano", name: "Océano", css: "radial-gradient(80% 60% at 50% 0%,#5fd3ff,transparent 60%),linear-gradient(180deg,#0a6fb5,#062a5a)" },
  { id: "bosque", name: "Bosque", css: "radial-gradient(70% 50% at 30% 20%,#9be36d66,transparent 60%),linear-gradient(180deg,#2f7d3a,#0f2d17)" },
  { id: "galaxia", name: "Galaxia", css: "radial-gradient(1.5px 1.5px at 20% 30%,#fff,transparent),radial-gradient(1px 1px at 70% 15%,#fff,transparent),radial-gradient(1.5px 1.5px at 85% 60%,#fff,transparent),radial-gradient(1px 1px at 35% 75%,#fff,transparent),radial-gradient(1px 1px at 55% 45%,#fff,transparent),radial-gradient(60% 50% at 70% 30%,#b23cff55,transparent 70%),radial-gradient(50% 40% at 20% 80%,#3c7bff55,transparent 70%),#05030f" },
  { id: "foto", name: "Tu foto", css: "" },
];

const look = {
  skin: lsGet("gbaweb-skin") || "morado",
  frame: lsGet("gbaweb-frame") !== "0",   // aspecto de consola de mano (activado por defecto)
  bg: lsGet("gbaweb-bg"),
  photoUrl: "",
};

async function applyLook() {
  document.body.dataset.skin = look.skin;
  document.body.classList.toggle("frame", look.frame);
  $("#frame-toggle").checked = look.frame;
  let image = "";
  if (look.bg === "foto") {
    if (!look.photoUrl) {
      const blob = await safeGet("files", "bg-photo");
      if (blob) look.photoUrl = URL.createObjectURL(blob);
    }
    if (look.photoUrl) image = `url("${look.photoUrl}")`;
  } else {
    const preset = BACKGROUNDS.find((b) => b.id === look.bg);
    image = preset ? preset.css : "";
  }
  document.body.classList.toggle("has-bg", !!image);
  if (image) document.body.style.setProperty("--bg-image", image);
  else document.body.style.removeProperty("--bg-image");
  renderLook();
}

$("#frame-toggle").addEventListener("change", (e) => {
  look.frame = e.target.checked;
  saveSetting("gbaweb-frame", look.frame ? "1" : "0");
  applyLook();
});

function renderLook() {
  const skins = $("#skins");
  skins.innerHTML = "";
  for (const sk of SKINS) {
    const btn = document.createElement("button");
    btn.className = "skin-btn" + (sk.id === look.skin ? " active" : "");
    btn.dataset.skin = sk.id;
    btn.innerHTML = '<span class="skin-prev"><b></b><i class="a"></i><i class="b"></i></span><span></span>';
    const prev = btn.firstChild;
    prev.style.setProperty("--p-shell", sk.shell);
    prev.style.setProperty("--p-key", sk.key);
    prev.style.setProperty("--p-a", sk.a);
    prev.style.setProperty("--p-b", sk.b);
    btn.lastChild.textContent = sk.name;
    skins.appendChild(btn);
  }
  const bgs = $("#bgs");
  bgs.innerHTML = "";
  for (const bg of BACKGROUNDS) {
    const btn = document.createElement("button");
    btn.className = "bg-btn" + ((look.bg || "") === bg.id ? " active" : "");
    btn.dataset.bg = bg.id;
    btn.innerHTML = '<span class="bg-prev"></span><span></span>';
    const prev = btn.firstChild;
    if (bg.css) prev.style.setProperty("--p-bg", bg.css);
    else if (bg.id === "foto" && look.photoUrl) prev.style.setProperty("--p-bg", `url("${look.photoUrl}")`);
    else prev.textContent = bg.id === "foto" ? "📷" : "∅";
    btn.lastChild.textContent = bg.name;
    bgs.appendChild(btn);
  }
}

$("#skins").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-skin]");
  if (!btn) return;
  look.skin = btn.dataset.skin;
  saveSetting("gbaweb-skin", look.skin);
  applyLook();
});

$("#bgs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-bg]");
  if (!btn) return;
  if (btn.dataset.bg === "foto") return $("#bg-input").click();
  look.bg = btn.dataset.bg;
  saveSetting("gbaweb-bg", look.bg);
  applyLook();
});

// Tu foto como fondo: se reduce (máx. 1600 px) para que ocupe poco.
$("#bg-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = URL.createObjectURL(file);
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.85));
    await db.put("files", blob, "bg-photo");
    if (look.photoUrl) URL.revokeObjectURL(look.photoUrl);
    look.photoUrl = URL.createObjectURL(blob);
    look.bg = "foto";
    saveSetting("gbaweb-bg", "foto");
    applyLook();
    toast("Fondo actualizado");
  } catch (err) {
    console.error(err);
    toast("No se pudo usar esa imagen");
  }
});

/* ---------- Menú ---------- */

function openMenu() {
  updatePressed([]);
  $("#menu").hidden = false;
  updateFastForward();
  if (engine) renderSlots();
}

function closeMenu() {
  $("#menu").hidden = true;
}

$("#btn-menu").addEventListener("click", openMenu);
$("#menu").addEventListener("click", (e) => {
  if (e.target.id === "menu") closeMenu();
});

const stateKey = (slot) => `${saveKey}#${slot}`;

async function renderSlots() {
  const wrap = $("#slots");
  wrap.innerHTML = "";
  for (let slot = 1; slot <= SLOTS; slot++) {
    const saved = await safeGet("states", stateKey(slot));
    const div = document.createElement("div");
    div.className = "slot";
    div.innerHTML = `<b>Ranura ${slot}</b><small>${saved ? timeAgo(saved.time) : "Vacía"}</small>
      <button class="btn" data-save="${slot}">Guardar</button>
      <button class="btn" data-load="${slot}" ${saved ? "" : "disabled"}>Cargar</button>`;
    wrap.appendChild(div);
  }
}

$("#slots").addEventListener("click", async (e) => {
  if (!engine) return;
  const saveSlot = e.target.dataset.save;
  const loadSlot = e.target.dataset.load;
  try {
    if (saveSlot) {
      if (sync.foreign) return toast("Estás jugando en la partida de tu amigo: guarda él", 3500);
      await db.put("states", { data: engine.saveState(), time: Date.now() }, stateKey(saveSlot));
      toast(`Guardado en la ranura ${saveSlot}`);
      renderSlots();
    } else if (loadSlot) {
      if (linkActive()) return toast("Termina el multijugador para cargar una ranura", 3500);
      const saved = await db.get("states", stateKey(loadSlot));
      if (!saved) return;
      engine.loadState(saved.data);
      toast(`Cargada la ranura ${loadSlot}`);
      closeMenu();
    }
  } catch (err) {
    console.error(err);
    toast("No se pudo completar la acción");
  }
});

const actions = {
  "close-menu": closeMenu,
  quit: async () => {
    saveCover(true);
    await persistSave();
    net.stop(true);
    location.replace(location.pathname);
  },
  mute: (btn) => {
    if (!engine) return;
    engine.setMuted(!engine.muted);
    btn.textContent = engine.muted ? "🔇 Sin sonido" : "🔊 Sonido";
  },
  restart: () => {
    if (linkActive()) return toast("Termina el multijugador para reiniciar", 3500);
    if (engine && confirm("¿Reiniciar el juego? Se perderá lo que no hayas guardado.")) {
      engine.reset();
      closeMenu();
    }
  },
  "export-save": () => {
    const data = engine && engine.getSave();
    if (!data) return toast("Este juego no tiene partida guardada");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = romName + ".sav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  "import-save": () => {
    if (linkActive()) return toast("Termina el multijugador para importar una partida", 3500);
    $("#sav-input").click();
  },
  fullscreen: () => {
    closeMenu();
    if (document.fullscreenElement) return document.exitFullscreen();
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(el, { navigationUI: "hide" })).catch(() => {});
    else toast("En iPhone: Compartir → Añadir a pantalla de inicio");
  },
  "toggle-vibration": () => {
    android.vibration = !android.vibration;
    saveSetting("gbaweb-vibration", android.vibration ? "1" : "0");
    renderAndroid();
    if (android.vibration) navigator.vibrate(30);
  },
  rotate: async () => {
    // Fija horizontal/vertical (Android, en pantalla completa).
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      const landscape = screen.orientation.type.startsWith("portrait");
      await screen.orientation.lock(landscape ? "landscape" : "portrait");
      closeMenu();
    } catch (e) {
      toast("Tu móvil no permite girar desde aquí; gira el móvil directamente");
    }
  },
  "host-link": () => net.host(roomMode()),
  "host-screen": () => net.host("screen"),
  "stop-net": () => net.stop(),
  saves: () => {
    if (!libraryName) return toast("Este juego no está en tu biblioteca");
    openSaves(libraryName);
  },
  "toggle-pad": () => {
    setPadHidden(!document.body.classList.contains("pad-hidden"));
    closeMenu();
  },
  share: () => {
    const url = net.inviteUrl();
    const text = isRoomMode(net.mode)
      ? `¡Juguemos juntos a ${romName}! Abre el enlace y carga tu ROM. Código: ${net.code}`
      : `¡Mira mi partida de ${romName}! Código: ${net.code}`;
    if (navigator.share) navigator.share({ title: "GBA Web", text, url }).catch(() => {});
    else actions.copy();
  },
  copy: () => {
    navigator.clipboard.writeText(net.inviteUrl()).then(
      () => toast("Enlace copiado"),
      () => toast("Código: " + net.code)
    );
  },
  "unmute-remote": () => {
    const v = $("#remote-video");
    v.muted = false;
    v.play().catch(() => {});
    toast("Sonido activado");
  },
};

$("#menu").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (btn && actions[btn.dataset.action]) actions[btn.dataset.action](btn);
});

$("#menu-join").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#menu-join-code").value.trim().toUpperCase();
  if (code.length < 4) return toast("Escribe el código de tu amigo");
  closeMenu();
  net.join(code);
});

$("#sav-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !engine) return;
  engine.setSave(new Uint8Array(await file.arrayBuffer()));
  engine.reset();
  await persistSave();
  toast("Partida importada");
  closeMenu();
});

$("#guest-control").addEventListener("change", (e) => {
  net.guestControl = e.target.checked;
  applyButtons();
  for (const conn of net.conns.values()) net.sendJSON(conn, { t: "ctl", on: net.guestControl });
});

/* ---------- Multijugador online (WebRTC con PeerJS) ----------
 * Modo "link": cada uno ejecuta su propio juego y los paquetes del adaptador
 *   inalámbrico de la GBA viajan entre consolas (como el netplay de RetroArch con gpSP).
 *   El anfitrión es el cliente 0 y reenvía lo que haga falta entre invitados.
 * Modo "screen": el anfitrión transmite imagen y sonido; el invitado manda sus botones.
 */

/* ---------- Dos mandos sincronizados (Super Nintendo) ----------
 * Los dos móviles ejecutan el mismo juego y solo se envían los botones. Un fotograma se juega
 * cuando están los mandos de los dos; el tuyo se manda SYNC_DELAY fotogramas antes para que
 * llegue a tiempo. Al empezar, el anfitrión manda su partida (el estado completo) y, si alguna
 * vez las dos consolas dejan de coincidir, la vuelve a mandar sola. */
const SYNC_DELAY = 4;           // fotogramas de margen (~67 ms)
const SYNC_CHECK_EVERY = 120;   // se comprueba que coinciden cada ~2 s
const SYNC_CHUNK = 16000;
const MSG_INPUT = 1, MSG_STATE = 2, MSG_HASH = 3;

const sync = {
  conn: null,
  role: null,          // "host" (mando 1) | "guest" (mando 2)
  active: false,
  foreign: false,      // invitado: está jugando en la partida del anfitrión
  epoch: 0,
  frame: 0,            // siguiente fotograma a jugar
  nextLocal: 0,        // siguiente fotograma para el que hay que mandar tu mando
  local: new Map(),
  remote: new Map(),
  hashes: new Map(),
  theirHashes: new Map(),
  incoming: null,
  waitingSince: 0,
  lastResync: 0,

  begin(conn, role) {
    this.stop(true);
    this.conn = conn;
    this.role = role;
    this.active = true;
    this.local.clear();
    this.remote.clear();
    if (role === "guest") {
      persistSave();
      this.foreign = true;
      engine.lockstep = () => null; // en pausa hasta recibir la partida
      screenMsg("Recibiendo la partida de tu amigo…");
    } else {
      this.sendState(true);
      engine.lockstep = () => this.step();
    }
  },

  // Fotogramas iniciales: nadie ha pulsado nada todavía.
  prefill(frame) {
    this.frame = frame;
    this.nextLocal = Math.max(this.nextLocal, frame + SYNC_DELAY);
    for (let f = frame; f < frame + SYNC_DELAY; f++) {
      if (!this.local.has(f)) this.local.set(f, 0);
      if (!this.remote.has(f)) this.remote.set(f, 0);
    }
  },

  send(bytes) {
    if (this.conn && this.conn.open) this.conn.send(bytes.buffer);
  },

  sendState(fresh) {
    this.epoch = (this.epoch + 1) & 0xff;
    this.hashes.clear();
    this.theirHashes.clear();
    this.lastResync = Date.now();
    if (fresh) {
      this.nextLocal = 0;
      this.prefill(0);
    }
    const state = fflate.deflateSync(engine.saveState(), { level: 1 });
    for (let off = 0; off < state.length || off === 0; off += SYNC_CHUNK) {
      const part = state.subarray(off, off + SYNC_CHUNK);
      const msg = new Uint8Array(15 + part.length);
      const dv = new DataView(msg.buffer);
      msg[0] = MSG_STATE;
      msg[1] = fresh ? 1 : 0;
      msg[2] = this.epoch;
      dv.setUint32(3, this.frame, true);
      dv.setUint32(7, state.length, true);
      dv.setUint32(11, off, true);
      msg.set(part, 15);
      this.send(msg);
      if (!state.length) break;
    }
  },

  onData(bytes) {
    if (!this.active || !bytes.length) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === MSG_INPUT) {
      this.remote.set(dv.getUint32(1, true), dv.getUint16(5, true));
    } else if (bytes[0] === MSG_HASH) {
      if (bytes[1] !== this.epoch) return;
      this.theirHashes.set(dv.getUint32(2, true), dv.getUint32(6, true));
      this.compare(dv.getUint32(2, true));
    } else if (bytes[0] === MSG_STATE && this.role === "guest") {
      const fresh = bytes[1] & 1, epoch = bytes[2], frame = dv.getUint32(3, true);
      const total = dv.getUint32(7, true), off = dv.getUint32(11, true);
      if (!this.incoming || this.incoming.epoch !== epoch) this.incoming = { epoch, data: new Uint8Array(total), got: 0 };
      this.incoming.data.set(bytes.subarray(15), off);
      this.incoming.got += bytes.length - 15;
      if (this.incoming.got < total) return;
      const state = fflate.inflateSync(this.incoming.data);
      this.incoming = null;
      engine.loadState(state);
      this.epoch = epoch;
      this.hashes.clear();
      this.theirHashes.clear();
      if (fresh) {
        this.nextLocal = 0;
        this.prefill(frame);
        screenMsg("");
        engine.lockstep = () => this.step();
      } else {
        this.frame = frame;
      }
    }
  },

  // Comprueba que las dos consolas tienen la misma memoria; si no, el anfitrión reenvía su partida.
  compare(frame) {
    const mine = this.hashes.get(frame), theirs = this.theirHashes.get(frame);
    if (mine === undefined || theirs === undefined) return;
    this.hashes.delete(frame);
    this.theirHashes.delete(frame);
    if (mine !== theirs && this.role === "host" && Date.now() - this.lastResync > 3000) {
      console.warn("Las consolas se han desincronizado en el fotograma", frame, "→ se reenvía la partida");
      this.sendState(false);
    }
  },

  step() {
    const f = this.frame;
    // Tu mando se manda por adelantado para el fotograma f + SYNC_DELAY.
    while (this.nextLocal <= f + SYNC_DELAY) {
      const n = this.nextLocal++;
      const mask = engine.buttons & 0xffff;
      this.local.set(n, mask);
      const msg = new Uint8Array(7);
      const dv = new DataView(msg.buffer);
      msg[0] = MSG_INPUT;
      dv.setUint32(1, n, true);
      dv.setUint16(5, mask, true);
      this.send(msg);
    }
    const mine = this.local.get(f), theirs = this.remote.get(f);
    if (mine === undefined || theirs === undefined) {
      if (!this.waitingSince) this.waitingSince = Date.now();
      else if (Date.now() - this.waitingSince > 1500 && !this.waitMsg) {
        this.waitMsg = true;
        screenMsg("Esperando a tu amigo…");
      }
      return null;
    }
    if (this.waitMsg) screenMsg("");
    this.waitingSince = 0;
    this.waitMsg = false;
    if (f && f % SYNC_CHECK_EVERY === 0 && !this.hashes.has(f)) {
      const h = engine.ramHash();
      this.hashes.set(f, h);
      const msg = new Uint8Array(10);
      const dv = new DataView(msg.buffer);
      msg[0] = MSG_HASH;
      msg[1] = this.epoch;
      dv.setUint32(2, f, true);
      dv.setUint32(6, h, true);
      this.send(msg);
      this.compare(f);
      for (const k of this.hashes.keys()) if (k < f - SYNC_CHECK_EVERY * 10) this.hashes.delete(k);
      for (const k of this.theirHashes.keys()) if (k < f - SYNC_CHECK_EVERY * 10) this.theirHashes.delete(k);
    }
    this.local.delete(f - 600);
    this.remote.delete(f - 600);
    this.frame = f + 1;
    return this.role === "host" ? [mine, theirs] : [theirs, mine];
  },

  stop() {
    if (!this.active) return;
    this.active = false;
    this.conn = null;
    this.incoming = null;
    this.local.clear();
    this.remote.clear();
    if (engine) engine.lockstep = null;
    if (this.waitMsg || this.foreign) screenMsg("");
    this.waitMsg = false;
    this.waitingSince = 0;
    if (this.foreign) {
      // El invitado vuelve a su propia partida (sin guardar la del anfitrión).
      screenMsg("Volviendo a tu partida…");
      const rec = library.find((r) => r.name === libraryName);
      setTimeout(() => (rec ? playRom(rec) : location.reload()), 1200);
    }
  },
};

const net = {
  role: null,   // "host" | "guest" (link) | "viewer" (screen)
  mode: null,   // "link" | "screen"
  peer: null,
  conn: null,   // invitado: conexión con el anfitrión
  conns: new Map(), // anfitrión: id de cliente -> conexión
  call: null,
  code: "",
  guestControl: true,
  pendingLink: false,
  names: new Map(),     // anfitrión: id de cliente -> apodo
  roster: [],           // jugadores de la sala: [{ id, nick }]
  hostReady: false,
  onHostReady: [],

  inviteUrl() {
    return `${location.origin}${location.pathname}?join=${this.code}`;
  },

  sendJSON(conn, msg) {
    if (conn && conn.open) conn.send(JSON.stringify(msg));
  },

  newPeer(id) {
    if (!window.Peer) throw new Error("PeerJS no está disponible");
    // window.GBA_PEER_OPTIONS permite usar un servidor PeerJS propio ({ host, port, path, secure }).
    const opts = { config: { iceServers: iceServers() }, debug: 1, ...window.GBA_PEER_OPTIONS };
    return id ? new Peer(id, opts) : new Peer(opts);
  },

  renderSession() {
    updateFastForward();
    const active = !!this.role;
    $("#mp-host").hidden = active;
    $("#mp-session").hidden = !active;
    if (!active) return;
    const isHost = this.role === "host";
    $("#mp-code-box").hidden = !isHost;
    $("#guest-control-row").hidden = !(isHost && this.mode === "screen");
    $("#mp-mode").textContent = this.mode === "sync"
      ? (isHost ? "Eres el mando 1. Invita a un amigo: será el mando 2 y jugaréis la misma partida a la vez." : "Estás en la partida de tu amigo con el mando 2. Lo que guardes lo guarda él.")
      : this.mode === "link"
      ? (isHost ? "Eres el anfitrión. Invita a tus amigos (hasta 4) y, cuando estéis, invitaos desde el menú multijugador del juego." : "Estás en la sala de tu amigo. Ya podéis invitaros desde el menú multijugador del juego.")
      : "📺 Compartiendo pantalla.";
    renderLobby();
  },

  // Lista de jugadores de la sala (anfitrión primero).
  updateRoster() {
    if (this.role !== "host") return;
    this.roster = [{ id: 0, nick: friends.nick || "Tú" }];
    for (const id of [...this.conns.keys()].sort()) this.roster.push({ id, nick: this.names.get(id) || "Jugador " + (id + 1) });
    for (const conn of this.conns.values()) this.sendJSON(conn, { t: "roster", players: this.roster });
    this.renderSession();
  },

  whenHostReady(cb) {
    if (this.role === "host" && this.hostReady) cb();
    else this.onHostReady.push(cb);
  },

  /* ----- Anfitrión ----- */

  host(mode) {
    if (this.role) return;
    if (!engine) return toast("Espera a que cargue el juego");
    this.role = "host";
    this.mode = mode;
    this.code = randomCode();
    this.hostReady = false;
    $("#mp-code").textContent = "······";
    this.renderSession();
    setNetStatus("Conectando…", "wait");

    const peer = this.peer = this.newPeer(PEER_PREFIX + this.code);
    let started = false;
    peer.on("open", () => {
      // PeerJS vuelve a emitir "open" al reconectar: la sesión del núcleo solo se inicia una vez.
      if (started) return;
      started = true;
      $("#mp-code").textContent = this.code;
      setNetStatus("🔗 Sala · esperando amigos", "wait");
      if (mode === "link") {
        engine.onNetSend = (data, client) => this.hostSend(data, client, 0);
        engine.netStart(0);
      }
      this.hostReady = true;
      this.updateRoster();
      friends.broadcastStatus();
      const cbs = this.onHostReady.splice(0);
      for (const cb of cbs) cb();
    });
    peer.on("error", (err) => {
      console.error(err);
      if (err.type === "unavailable-id") {
        const pending = this.onHostReady.splice(0);
        this.stop(true);
        this.onHostReady = pending;
        return this.host(mode);
      }
      if (this.peer !== peer) return;
      // Si se cae solo el servidor de encuentro, los amigos ya conectados siguen jugando.
      if (SIGNALING_ERRORS.includes(err.type) && this.conns.size) return reconnectLater(peer);
      showNetError(explainPeerError(err));
      if (SIGNALING_ERRORS.includes(err.type)) reconnectLater(peer);
    });
    peer.on("disconnected", () => reconnectLater(peer));
    peer.on("connection", (conn) => this.acceptGuest(conn));
    enableRelay(peer, (conn) => this.acceptGuest(conn));
  },

  acceptGuest(conn) {
    let id = 0;
    let guestNick = "Tu amigo";
    const gone = () => {
      if (!id || this.conns.get(id) !== conn) return;
      this.conns.delete(id);
      const who = this.names.get(id) || "Tu amigo";
      this.names.delete(id);
      if (this.mode === "link") engine.netDisconnected(id);
      else if (this.mode === "sync") sync.stop();
      else {
        if (this.call) this.call.close();
        this.call = null;
        remoteMask = 0;
        applyButtons();
      }
      if (this.role === "host") {
        setNetStatus(this.conns.size ? `👥 ${this.conns.size + 1} jugadores` : "🔗 Sala · esperando amigos", this.conns.size ? "ok" : "wait");
        toast(who + " ha salido de la sala");
        this.updateRoster();
      }
    };
    const admit = () => {
      const max = this.mode === "link" ? MAX_GUESTS : 1;
      for (let i = 1; i <= max && !id; i++) if (!this.conns.has(i)) id = i;
      if (!id || (this.mode === "link" && !engine.netConnected(id))) {
        id = 0;
        this.sendJSON(conn, { t: "full" });
        setTimeout(() => conn.close(), 500);
        return;
      }
      this.conns.set(id, conn);
      this.names.set(id, guestNick);
      this.sendJSON(conn, { t: "welcome", id });
      if (this.mode === "screen") this.call = this.peer.call(conn.peer, buildStream());
      setNetStatus(`👥 ${this.conns.size + 1} jugadores`, "ok");
      toast(this.mode === "link" ? `¡${guestNick} ha entrado en la sala! Invitaos desde el menú multijugador del juego.`
        : this.mode === "sync" ? `¡${guestNick} se ha unido con el mando 2!` : `¡${guestNick} se ha unido!`, 5000);
      if (this.mode === "sync") sync.begin(conn, "host");
      this.updateRoster();
    };
    conn.on("open", () => {
      heartbeat(conn, gone);
      this.sendJSON(conn, { t: "hello", mode: this.mode, game: romName, ctl: this.guestControl, nick: friends.nick });
      if (this.mode === "screen") admit();
    });
    conn.on("data", (msg) => {
      if (typeof msg === "string") {
        const m = parseJSON(msg);
        if (!m) return;
        if (m.nick) guestNick = String(m.nick).slice(0, 20);
        if (m.t === "ready" && isRoomMode(this.mode) && !id) admit();
        else if (m.t === "viewer" && this.mode === "screen" && id) {
          this.names.set(id, guestNick);
          this.updateRoster();
        }
        else if (m.t === "k" && this.mode === "screen") {
          remoteMask = m.m | 0;
          applyButtons();
        }
      } else if (id && this.mode === "sync") {
        sync.onData(new Uint8Array(msg));
      } else if (id && this.mode === "link") {
        const bytes = new Uint8Array(msg);
        const dest = bytes[0] | (bytes[1] << 8);
        const payload = bytes.subarray(2);
        if (dest === 0 || dest === BROADCAST) engine.netReceive(id, payload.slice());
        if (dest !== 0) this.hostSend(payload, dest, id);
      }
    });
    conn.on("close", gone);
    conn.on("error", gone);
  },

  // Envía un paquete a un invitado (o a todos) indicando quién lo originó.
  hostSend(data, dest, src) {
    const framed = new Uint8Array(data.length + 2);
    framed[0] = src & 0xff;
    framed[1] = src >> 8;
    framed.set(data, 2);
    for (const [cid, conn] of this.conns) {
      if (cid !== src && (dest === BROADCAST || dest === cid) && conn.open) conn.send(framed.buffer);
    }
  },

  /* ----- Invitado ----- */

  join(code) {
    if (this.role || this.peer) this.stop(true);
    this.code = code;
    history.replaceState(null, "", location.pathname);
    let peer;
    try {
      peer = this.peer = this.newPeer();
    } catch (e) {
      return toast("No se pudo iniciar el multijugador: " + e.message, 4000);
    }
    toast("Conectando…", 4000);
    let opened = false;
    const wire = (conn) => {
      this.conn = conn;
      conn.on("data", (msg) => this.onHostData(msg));
      const gone = () => {
        if (this.conn !== conn) return;
        if (this.mode === "link" && this.role === "guest") engine.netStop();
        if (this.mode === "sync") sync.stop();
        lastNetError = "Se perdió la conexión con tu amigo. Podéis volver a invitaros desde la lista de amigos.";
        setNetStatus("Desconectado", "bad");
        if (this.role === "viewer") screenMsg("La partida ha terminado o se perdió la conexión.");
        else toast("Se perdió la conexión con tu amigo", 4000);
        this.role = null;
        this.conn = null;
        this.roster = [];
        this.renderSession();
        friends.broadcastStatus();
      };
      conn.on("open", () => { opened = true; heartbeat(conn, gone); });
      conn.on("close", gone);
    };
    peer.on("open", () => {
      if (opened || this.conn) return;   // PeerJS repite "open" al reconectar
      enableRelay(peer, () => {});
      const direct = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "raw" });
      wire(direct);
      // Si en 8 s no hay conexión directa, se pasa al plan B: por el servidor.
      setTimeout(() => {
        if (opened || this.conn !== direct || this.peer !== peer) return;
        toast("Conexión directa bloqueada por vuestras redes: conectando por el servidor…", 4000);
        const rc = relayConnect(peer, PEER_PREFIX + code, null);
        wire(rc);
        direct.close();
        setTimeout(() => {
          if (!opened && this.conn === rc) showNetError("No se pudo conectar con tu amigo. Que tenga la web abierta en pantalla y probad otra vez.");
        }, 13000);
      }, 8000);
    });
    peer.on("call", (call) => {
      this.call = call;
      call.answer();
      call.on("stream", (stream) => {
        const v = $("#remote-video");
        v.srcObject = stream;
        v.hidden = false;
        v.play().catch(() => {});
        screenMsg("");
        toast("Toca ☰ → Activar sonido para oír el juego", 4000);
      });
    });
    peer.on("error", (err) => {
      console.error(err);
      if (this.peer !== peer) return;
      // Si se cae solo el servidor de encuentro pero ya estás conectado con tu amigo, se sigue jugando.
      if (SIGNALING_ERRORS.includes(err.type) && this.conn && this.conn.open) return reconnectLater(peer);
      const msg = explainPeerError(err, code);
      showNetError(msg);
      if (this.role === "viewer") screenMsg(msg);
    });
    peer.on("disconnected", () => reconnectLater(peer));
  },

  onHostData(msg) {
    if (typeof msg !== "string") {
      if (this.role !== "guest") return;
      if (this.mode === "sync") return sync.onData(new Uint8Array(msg));
      const bytes = new Uint8Array(msg);
      engine.netReceive(bytes[0] | (bytes[1] << 8), bytes.slice(2));
      return;
    }
    const m = parseJSON(msg);
    if (!m) return;
    if (m.t === "hello") {
      this.mode = m.mode;
      this.hostGame = m.game;
      this.hostNick = m.nick || "tu amigo";
      if (m.mode === "screen") this.becomeViewer(m);
      else if (engine) this.sendReady();
      else this.waitForRom(m.game);
    } else if (m.t === "welcome") {
      if (this.mode === "sync") {
        this.role = "guest";
        sync.begin(this.conn, "guest");
        friends.broadcastStatus();
        setNetStatus("🎮 Conectado · mando 2", "ok");
        toast(`¡Estás en la partida de ${this.hostNick}! Llevas el mando 2.`, 5000);
      } else if (this.mode === "link") {
        this.role = "guest";
        engine.onNetSend = (data, client) => {
          const framed = new Uint8Array(data.length + 2);
          framed[0] = client & 0xff;
          framed[1] = client >> 8;
          framed.set(data, 2);
          if (this.conn && this.conn.open) this.conn.send(framed.buffer);
        };
        engine.netStart(m.id);
        friends.broadcastStatus();
        setNetStatus(`🔗 Conectado · J${m.id + 1}`, "ok");
        toast(this.hostGame && this.hostGame !== romName
          ? `Conectado. Ojo: tu ROM («${romName}») y la de tu amigo («${this.hostGame}») tienen nombres distintos; tienen que ser la misma versión.`
          : `¡Estás en la sala de ${this.hostNick}! Ya podéis invitaros desde el menú multijugador del juego.`, 6000);
      }
      this.renderSession();
    } else if (m.t === "roster") {
      this.roster = Array.isArray(m.players) ? m.players : [];
      this.renderSession();
    } else if (m.t === "ctl") {
      toast(m.on ? "Ya puedes usar los controles" : "Tu amigo ha desactivado tus controles");
    } else if (m.t === "full") {
      toast("La partida de tu amigo ya está llena.", 4000);
      if (this.role === "viewer") screenMsg("La partida ya tiene un invitado.");
    }
  },

  waitForRom(game) {
    this.pendingLink = true;
    showView("home");
    const banner = $("#invite-banner");
    banner.hidden = false;
    banner.textContent = `🔗 ${this.hostNick || "Tu amigo"} te espera en «${game}». Elige ese juego en tu biblioteca (la misma versión) para jugar juntos.`;
    setNetStatus("Esperando tu ROM", "wait");
    // Si ya tienes ese juego en la biblioteca, se abre solo.
    const match = library.find((r) => baseName(r.name) === game || romTitle(r) === game);
    if (match) {
      toast(`Abriendo tu «${romTitle(match)}»…`);
      playRom(match);
    }
  },

  sendReady() {
    this.pendingLink = false;
    this.sendJSON(this.conn, { t: "ready", game: romName, nick: friends.nick });
    setNetStatus("Conectando…", "wait");
  },

  becomeViewer(m) {
    if (engine) {
      persistSave();
      engine.stop();
      engine.setMuted(true);
    }
    this.role = "viewer";
    this.sendJSON(this.conn, { t: "viewer", nick: friends.nick });
    document.body.classList.add("guest");
    showView("console");
    $("#game-title").textContent = "Partida de tu amigo · " + m.game;
    setNetStatus("👥 Conectado", "ok");
    screenMsg("Esperando la imagen…");
    if (!m.ctl) toast("Tu amigo ha desactivado tus controles");
  },

  stop(silent) {
    if (engine && this.mode === "link") engine.netStop();
    if (this.mode === "sync") sync.stop();
    if (this.call) this.call.close();
    if (this.conn) this.conn.close();
    for (const conn of this.conns.values()) conn.close();
    if (this.peer) this.peer.destroy();
    this.peer = this.conn = this.call = null;
    this.conns.clear();
    this.names.clear();
    this.roster = [];
    this.hostReady = false;
    this.onHostReady = [];
    this.role = this.mode = null;
    remoteMask = 0;
    applyButtons();
    this.renderSession();
    friends.broadcastStatus();
    if (!silent) {
      setNetStatus("");
      toast("Multijugador terminado");
    }
  },
};

/* ---------- Plan B: conexión a través del servidor de encuentro ----------
 * Si vuestras redes no se dejan unir directamente (pasa entre países o con algunos
 * proveedores), los mensajes viajan por el propio servidor de PeerJS, que reenvía los avisos
 * de conexión entre dos usuarios. Imita lo que la app usa de una conexión de PeerJS
 * (open, send, close y los eventos open/data/close), así que el resto del código no cambia.
 * Es más lento que la conexión directa, pero no necesita configurar nada. */
const RELAY_TYPE = "CANDIDATE";       // tipo de mensaje que el servidor reenvía tal cual
const relays = new Map();             // "miId|suId|cid" -> RelayConn

function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b) {
  const s = atob(b), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

class RelayConn {
  constructor(peer, remoteId, cid, metadata) {
    this._peer = peer;
    this.peer = remoteId;
    this.connectionId = cid;
    this.metadata = metadata;
    this.open = false;
    this.relay = true;
    this._h = {};
    this.key = peer.id + "|" + remoteId + "|" + cid;
    relays.set(this.key, this);
  }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  _emit(ev, ...args) { for (const fn of this._h[ev] || []) { try { fn(...args); } catch (e) { console.error(e); } } }
  _raw(k, extra) {
    const sock = this._peer.socket;
    if (sock && !this._peer.destroyed) sock.send({ type: RELAY_TYPE, dst: this.peer, payload: { gbaRelay: 1, k, cid: this.connectionId, ...extra } });
  }
  send(data) {
    if (!this.open) return;
    if (typeof data === "string") this._raw("d", { s: data });
    else if (data instanceof ArrayBuffer) this._raw("d", { b: toB64(new Uint8Array(data)) });
    else if (ArrayBuffer.isView(data)) this._raw("d", { b: toB64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) });
    else this._raw("d", { o: data });
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    this.open = false;
    this._raw("c");
    relays.delete(this.key);
    this._emit("close");
  }
}

// Escucha las conexiones por el servidor que llegan a este peer.
function enableRelay(peer, onConnection) {
  const sock = peer.socket;
  if (!sock || sock._gbaRelay) return;
  sock._gbaRelay = true;
  sock.on("message", (m) => {
    const p = m && m.payload;
    if (!p || !p.gbaRelay || m.type !== RELAY_TYPE || !m.src) return;
    const c = relays.get(peer.id + "|" + m.src + "|" + p.cid);
    if (p.k === "o") {
      if (c) return;
      const conn = new RelayConn(peer, m.src, p.cid, p.meta);
      onConnection(conn);
      conn.open = true;
      conn._raw("a");
      setTimeout(() => conn._emit("open"));
    } else if (!c) {
      // Mensaje de una conexión que ya no existe aquí (p. ej. recargaste la página): se avisa
      // al otro para que la cierre y vuelva a conectar.
      if (p.k === "d" || p.k === "a") sock.send({ type: RELAY_TYPE, dst: m.src, payload: { gbaRelay: 1, k: "c", cid: p.cid } });
      return;
    } else if (p.k === "a") {
      if (!c.open && !c._closed) { c.open = true; c._emit("open"); }
    } else if (p.k === "d") {
      c._last = Date.now();
      if (c.open) c._emit("data", p.s !== undefined ? p.s : p.b !== undefined ? fromB64(p.b).buffer : p.o);
    } else if (p.k === "c") {
      c._closed = true;
      c.open = false;
      relays.delete(c.key);
      c._emit("close");
    }
  });
}

// El servidor avisa de que alguien ya no está: se cierran las conexiones por el servidor con él.
function closeRelaysTo(peer, remoteId) {
  for (const c of [...relays.values()]) if (c._peer === peer && c.peer === remoteId) { c._closed = true; c.open = false; relays.delete(c.key); c._emit("close"); }
}

// Abre una conexión por el servidor (si en 12 s no contesta, se cierra).
function relayConnect(peer, remoteId, metadata) {
  const conn = new RelayConn(peer, remoteId, "r" + Math.random().toString(36).slice(2, 10), metadata);
  conn._mine = true;
  conn._raw("o", { meta: metadata });
  setTimeout(() => { if (!conn.open) conn.close(); }, 12000);
  return conn;
}

/* ---------- Probar la conexión ----------
 * Comprueba las tres cosas que hacen falta para jugar online: llegar al servidor de encuentro
 * (PeerJS), poder conectar directo (STUN) y tener retransmisión por si no (TURN). */
async function diagnose() {
  const outs = document.querySelectorAll(".diag-out");
  const show = (html) => outs.forEach((o) => { o.hidden = false; o.innerHTML = html; });
  show("⏳ Probando tu conexión… (unos segundos)");
  const lines = [];
  // 1) Servidor de encuentro.
  const server = await new Promise((resolve) => {
    let peer;
    try { peer = net.newPeer(); } catch (e) { return resolve("error: " + e.message); }
    const done = (v) => { clearTimeout(t); try { peer.destroy(); } catch (e) {} resolve(v); };
    const t = setTimeout(() => done("timeout"), 12000);
    peer.on("open", () => done("ok"));
    peer.on("error", (err) => done(err.type || "error"));
  });
  lines.push(server === "ok"
    ? "✅ Servidor de encuentro: funciona."
    : "❌ Servidor de encuentro: no responde (" + server + "). Puede estar caído o bloqueado en esta red. Prueba con otra red (Wi‑Fi ↔ datos) o más tarde.");
  // 2) Tipos de conexión posibles.
  const kinds = new Set();
  try {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    pc.createDataChannel("prueba");
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) { const m = / typ (\w+)/.exec(e.candidate.candidate); if (m) kinds.add(m[1]); } };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 9000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } };
    });
    pc.close();
  } catch (e) {
    lines.push("❌ Tu navegador no permite conexiones WebRTC: " + e.message);
  }
  lines.push(kinds.has("srflx")
    ? "✅ Conexión directa: tu red la permite."
    : "⚠️ Conexión directa: tu red no la deja (pasa con algunos datos móviles o redes de empresa/colegio).");
  lines.push(kinds.has("relay")
    ? "✅ Retransmisión: disponible (se usa si no se puede directo)."
    : "⚠️ Retransmisión: no disponible ahora. Si vuestra fila de amigo dice 🚧, poned una <b>🛰️ Retransmisión propia</b> (más abajo): es gratis.");
  if (server === "ok" && (kinds.has("srflx") || kinds.has("relay"))) lines.push("👍 Desde aquí todo bien. Si aun así no conectáis, que tu amigo haga también la prueba.");
  lines.push("<small>Para probar tú solo usa <b>dos aparatos</b> (o Safari y Chrome) con apodos distintos: dos pestañas en el mismo móvil no sirven, la de atrás se pausa.</small>");
  lines.push(`<small>Versión de la web: <b>${APP_VERSION}</b> (tu amigo debe tener la misma).</small>`);
  show(lines.join("<br>"));
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-diagnose]")) diagnose(); });

// Retransmisión propia: formulario para guardar tu servidor TURN.
function renderTurnForms() {
  const t = customTurn() || {};
  for (const form of document.querySelectorAll(".turn-form")) {
    form.elements.urls.value = t.urls || "";
    form.elements.username.value = t.username || "";
    form.elements.credential.value = t.credential || "";
    form.querySelector(".turn-state").textContent = t.urls ? "✅ Guardada en este móvil" : "";
  }
}
for (const form of document.querySelectorAll(".turn-form")) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const urls = form.elements.urls.value.trim();
    try {
      if (urls) localStorage.setItem("gbaweb-turn", JSON.stringify({ urls, username: form.elements.username.value.trim(), credential: form.elements.credential.value.trim() }));
      else localStorage.removeItem("gbaweb-turn");
    } catch (err) { /* sin almacenamiento */ }
    renderTurnForms();
    friends.restart();
    toast(urls ? "🛰️ Retransmisión guardada. Toca 🩺 para comprobarla." : "Retransmisión propia quitada");
  });
}
renderTurnForms();

const SIGNALING_ERRORS = ["network", "server-error", "socket-error", "socket-closed", "disconnected"];
let lastNetError = "";

function explainPeerError(err, code) {
  switch (err.type) {
    case "peer-unavailable":
      return `No se encuentra la sala de tu amigo${code ? " (" + code + ")" : ""}. Pide a tu amigo que tenga la web abierta en pantalla (si bloquea el móvil, la sala se cierra) y que te vuelva a invitar.`;
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
    case "disconnected":
      return "Se perdió la conexión con el servidor que os pone en contacto. Revisa tu internet; se volverá a intentar solo.";
    case "browser-incompatible":
      return "Este navegador no permite conexiones directas. Usa Safari actualizado.";
    case "webrtc":
      return "No se pudo conectar directamente con tu amigo. Probad los dos con Wi‑Fi.";
    default:
      return "Error de conexión (" + (err.type || err.message) + "). Vuelve a intentarlo.";
  }
}

function showNetError(msg) {
  lastNetError = msg;
  setNetStatus("⚠️ Error · toca aquí", "bad");
  toast(msg, 7000);
}

function reconnectLater(peer) {
  setTimeout(() => {
    if (net.peer === peer && !peer.destroyed && peer.disconnected) {
      try { peer.reconnect(); } catch (e) { /* se reintentará en el próximo aviso */ }
    }
  }, 2000);
}

$("#net-status").addEventListener("click", () => {
  if (lastNetError && $("#net-status").classList.contains("bad")) toast(lastNetError, 7000);
});

function buildStream() {
  const stream = $("#game").captureStream(60);
  const audio = engine.streamDest && engine.streamDest.stream.getAudioTracks()[0];
  if (audio) stream.addTrack(audio);
  return stream;
}

function parseJSON(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Al cerrar la app en el móvil la conexión no siempre avisa: se comprueba con pings.
function heartbeat(conn, onGone) {
  let lastSeen = Date.now();
  conn.on("data", () => (lastSeen = Date.now()));
  const timer = setInterval(() => {
    if (!conn.open || Date.now() - lastSeen > 10000) {
      clearInterval(timer);
      conn.close();
      onGone();
      return;
    }
    net.sendJSON(conn, { t: "ping" });
  }, 2000);
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/* ---------- Amigos: apodo, quién está conectado e invitaciones ----------
 * Cada jugador registra en PeerJS un id con su apodo (gbaweb-v2-u-<apodo>) mientras tiene la web
 * abierta. Con cada amigo se mantiene una conexión de datos ligera: si abre, está conectado.
 * Por ella viajan el estado ("jugando a…") y las invitaciones a la sala.
 */

const FRIEND_PROBE_MS = 8000;

function lsGet(key) {
  try { return localStorage.getItem(key) || ""; } catch (e) { return ""; }
}

function nickId(nick) {
  return String(nick || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

const friends = {
  nick: lsGet("gbaweb-apodo"),
  // [{ id, nick, state: "sent" | "received" | "ok", delivered }]: las solicitudes de amistad
  // se envían en cuanto los dos tenéis la web abierta a la vez.
  list: [].concat(parseJSON(lsGet("gbaweb-amigos") || "[]") || []).map((f) => ({ ...f, state: f.state || "sent" })),
  rejected: [].concat(parseJSON(lsGet("gbaweb-rechazados") || "[]") || []),
  peer: null,
  conns: new Map(),     // id de amigo -> conexión abierta
  pending: new Set(),   // ids a los que se está intentando conectar
  status: new Map(),    // id de amigo -> { game, room }
  viaRelay: new Set(),  // amigos con los que se conecta por el servidor (plan B)
  reach: new Map(),     // id de amigo -> "offline" (no está en el servidor) | "blocked" (está, pero la red no deja conectar)
  invite: null,         // invitación recibida pendiente

  save() {
    try {
      localStorage.setItem("gbaweb-apodo", this.nick);
      localStorage.setItem("gbaweb-amigos", JSON.stringify(this.list));
      localStorage.setItem("gbaweb-rechazados", JSON.stringify(this.rejected));
    } catch (e) { /* sin almacenamiento */ }
  },

  peerIdFor(id) {
    return PEER_PREFIX + "u-" + id;
  },

  start() {
    if (!this.nick || this.peer || !window.Peer) return;
    let peer;
    try { peer = this.peer = net.newPeer(this.peerIdFor(nickId(this.nick))); } catch (e) { return; }
    this.state = "connecting";
    renderProfile();
    peer.on("open", () => {
      this.online = true;
      this.state = "online";
      this.justSet = false;
      this.retries = 0;
      render();
      this.probe();
    });
    peer.on("connection", (conn) => this.attach(conn));
    enableRelay(peer, (conn) => this.attach(conn));
    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        this.peer = null;
        peer.destroy();
        this.online = false;
        if (this.justSet) {
          // Apodo recién elegido y ocupado: se vuelve a pedir.
          toast(`El apodo «${this.nick}» ya lo está usando otra persona (o tienes la web abierta en otra pestaña). Elige otro.`, 6000);
          this.nick = "";
          this.save();
          this.state = "";
          render();
          return;
        }
        // Tu apodo de siempre: casi siempre es tu propia sesión anterior, que el servidor
        // aún no ha soltado (pasa al recargar o al volver a la app en iPhone). Se reintenta solo.
        this.retries = (this.retries || 0) + 1;
        this.state = this.retries > 12 ? "taken" : "connecting";
        render();
        if (this.retries === 13) toast(`Tu apodo «${this.nick}» sigue ocupado. ¿Tienes la web abierta en otro sitio? Ciérrala o cambia de apodo.`, 7000);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.start(), this.retries > 12 ? 30000 : 5000);
        return;
      }
      if (err.type === "peer-unavailable") {
        // El amigo al que se intentaba llamar no está conectado.
        const m = /u-([a-z0-9]+)/.exec(err.message || "");
        if (m) closeRelaysTo(peer, this.peerIdFor(m[1]));
        if (m) {
          this.pending.delete(m[1]);
          if (this.reach.get(m[1]) !== "offline") { this.reach.set(m[1], "offline"); renderFriends(); }
        }
        return;
      }
      if (SIGNALING_ERRORS.includes(err.type) || err.type === "server-error") { this.state = "offline"; renderProfile(); }
      if (SIGNALING_ERRORS.includes(err.type)) setTimeout(() => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch (e) { /* reintento luego */ }
      }, 3000);
    });
    peer.on("disconnected", () => setTimeout(() => {
      if (this.peer === peer && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch (e) { /* reintento luego */ }
    }, 3000));
    clearInterval(this.timer);
    this.timer = setInterval(() => this.probe(), FRIEND_PROBE_MS);
  },

  restart() {
    this.retries = 0;
    clearTimeout(this.retryTimer);
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
    this.pending.clear();
    if (this.peer) this.peer.destroy();
    this.peer = null;
    this.online = false;
    this.start();
  },

  // Intenta conectar con los amigos que no están conectados.
  probe() {
    if (!this.peer || this.peer.disconnected || document.visibilityState === "hidden") return;
    // Las conexiones por el servidor no notan solas si el otro se fue: latido cada vuelta.
    for (const conn of this.conns.values()) {
      if (!conn.relay) continue;
      if (Date.now() - (conn._last || conn._openedAt || Date.now()) > 30000) conn.close();
      else conn.send({ t: "ping" });
    }
    for (const f of this.list) {
      if (this.conns.has(f.id) || this.pending.has(f.id)) continue;
      this.pending.add(f.id);
      if (this.reach.get(f.id) === "offline") this.reach.set(f.id, "offline?");
      if (this.viaRelay.has(f.id)) {
        // Con este amigo la conexión directa no funciona: directamente por el servidor.
        const rc = relayConnect(this.peer, this.peerIdFor(f.id), { kind: "friend" });
        this.attach(rc);
        setTimeout(() => { if (!rc.open) this.pending.delete(f.id); }, 12500);
        continue;
      }
      const conn = this.peer.connect(this.peerIdFor(f.id), { serialization: "json", metadata: { kind: "friend" } });
      conn._mine = true;
      this.attach(conn);
      setTimeout(() => {
        if (!conn.open) {
          this.pending.delete(f.id);
          conn.close();
          // Si el servidor no dijo que no existe, está conectado pero la red no deja llegar a él:
          // se prueba por el servidor (plan B).
          if (this.reach.get(f.id) !== "offline" && !this.conns.has(f.id)) {
            this.reach.set(f.id, "blocked");
            this.viaRelay.add(f.id);
            renderFriends();
            if (this.peer && !this.peer.disconnected) {
              this.pending.add(f.id);
              const rc = relayConnect(this.peer, this.peerIdFor(f.id), { kind: "friend" });
              this.attach(rc);
              setTimeout(() => { if (!rc.open) this.pending.delete(f.id); }, 12500);
            }
          }
        }
      }, 7000);
    }
  },

  attach(conn) {
    let id = conn.peer.replace(PEER_PREFIX + "u-", "");
    conn.on("open", () => {
      this.pending.delete(id);
      this.reach.delete(id);
      conn._openedAt = conn._last = Date.now();
      const old = this.conns.get(id);
      if (old && old !== conn && old.open) {
        // Dos conexiones con el mismo amigo (os buscasteis a la vez): los dos se quedan con
        // la que abrió el de apodo "menor", para no cerrar cada uno una distinta.
        const keepMine = nickId(this.nick) < id;
        if (!!conn._mine !== keepMine) { conn.close(); return; }
        this.conns.set(id, conn);
        old.close();
      }
      this.conns.set(id, conn);
      conn.send(this.hello(id));
      render();
    });
    conn.on("data", (m) => this.onMessage(id, conn, m));
    const gone = () => {
      if (this.conns.get(id) === conn) {
        this.conns.delete(id);
        this.status.delete(id);
        render();
      }
      this.pending.delete(id);
    };
    conn.on("close", gone);
    conn.on("error", gone);
  },

  hello(id) {
    const f = id && this.find(id);
    return { t: "hi", nick: this.nick, game: engine ? romName : "", room: net.role === "host" && isRoomMode(net.mode), rel: f ? f.state : "none", v: APP_VERSION };
  },

  find(id) {
    return this.list.find((f) => f.id === id);
  },

  setState(id, state) {
    const f = this.find(id);
    if (!f || f.state === state) return;
    f.state = state;
    this.save();
    render();
  },

  // Aceptar o rechazar una solicitud recibida.
  answerRequest(id, ok) {
    const f = this.find(id);
    if (!f) return;
    const conn = this.conns.get(id);
    if (ok) {
      this.setState(id, "ok");
      if (conn && conn.open) { conn.send({ t: "friend-ok" }); conn.send(this.hello(id)); }
      toast(`🤝 Ahora ${f.nick} y tú sois amigos`);
    } else {
      this.list = this.list.filter((x) => x.id !== id);
      if (!this.rejected.includes(id)) this.rejected.push(id);
      this.save();
      if (conn && conn.open) conn.send({ t: "friend-no" });
      render();
    }
  },

  broadcastStatus() {
    for (const [id, conn] of this.conns) if (conn.open) conn.send(this.hello(id));
    render();
  },

  onMessage(id, conn, m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "hi") {
      this.status.set(id, { game: m.game || "", room: !!m.room, v: m.v || "" });
      if ((m.v || "") < APP_VERSION && !this.warnedOld) {
        this.warnedOld = true;
        toast(`${m.nick || "Tu amigo"} tiene una versión antigua de la web: que la cierre del todo y la vuelva a abrir.`, 7000);
      }
      let f = this.find(id);
      if (!f && m.rel === "sent" && m.nick) {
        // Te ha llegado una solicitud de amistad.
        if (this.rejected.includes(id)) { conn.send({ t: "friend-no" }); return; }
        this.list.push(f = { id, nick: String(m.nick).slice(0, 20), state: "received" });
        this.save();
        toast(`📩 ${m.nick} quiere ser tu amigo. Acéptalo en tu lista de amigos.`, 6000);
      } else if (f && f.state === "sent") {
        // Tu solicitud ya le ha llegado; si él también te tenía añadido, ya sois amigos.
        if (!f.delivered) { f.delivered = true; this.save(); }
        if (m.rel === "ok" || m.rel === "sent") {
          this.setState(id, "ok");
          conn.send({ t: "friend-ok" });
          toast(`🤝 Ahora ${f.nick} y tú sois amigos`);
        }
      } else if (f && f.state === "ok" && m.rel === "sent") {
        conn.send({ t: "friend-ok" });   // aceptaste cuando él no estaba conectado
      }
      render();
    } else if (m.t === "friend-ok") {
      const f = this.find(id);
      if (f && f.state !== "ok") {
        this.setState(id, "ok");
        toast(`🤝 ${f.nick} ha aceptado tu solicitud. ¡Ya sois amigos!`, 5000);
      }
    } else if (m.t === "friend-no") {
      const f = this.find(id);
      if (f && f.state === "sent") {
        this.list = this.list.filter((x) => x.id !== id);
        this.save();
        render();
        toast(`${f.nick} no ha aceptado tu solicitud`, 4000);
      }
    } else if (m.t === "invite") {
      this.showInvite(id, m);
    } else if (m.t === "invite-no") {
      toast(`${this.nickOf(id)} no puede jugar ahora`, 4000);
    } else if (m.t === "invite-ok") {
      toast(`${this.nickOf(id)} ha aceptado. Entrando en la sala…`, 4000);
    }
  },

  nickOf(id) {
    const f = this.list.find((x) => x.id === id);
    return f ? f.nick : id;
  },

  add(nick) {
    const id = nickId(nick);
    if (id.length < 3) return toast("Escribe el apodo de tu amigo (mínimo 3 letras o números)");
    if (id === nickId(this.nick)) return toast("Ese es tu propio apodo 😄");
    if (this.list.some((f) => f.id === id)) return toast("Ya lo tienes en tu lista");
    this.rejected = this.rejected.filter((x) => x !== id);
    this.list.push({ id, nick: nick.trim().slice(0, 20), state: "sent" });
    this.save();
    render();
    this.probe();
    toast(`📨 Solicitud para ${nick.trim()} preparada. Le llegará cuando los dos tengáis la web abierta a la vez.`, 5000);
  },

  remove(id) {
    const f = this.find(id);
    if (!confirm(f && f.state === "sent" ? `¿Cancelar la solicitud a ${f.nick}?` : `¿Quitar a ${this.nickOf(id)} de tus amigos?`)) return;
    this.list = this.list.filter((f) => f.id !== id);
    this.save();
    const conn = this.conns.get(id);
    if (conn) conn.close();
    render();
  },

  // Invitar: abre (o reutiliza) tu sala de "Jugar juntos" y manda el código a tu amigo.
  sendInvite(id) {
    const conn = this.conns.get(id);
    if (!conn || !conn.open) return toast(`${this.nickOf(id)} no está conectado ahora`);
    if ((this.find(id) || {}).state !== "ok") return toast(`Primero ${this.nickOf(id)} tiene que aceptar tu solicitud de amistad`);
    if (!engine) return toast("Abre primero tu juego para poder invitar");
    if (net.role && !(net.role === "host" && isRoomMode(net.mode))) {
      return toast("Ya estás en una sala. Termina el multijugador para crear la tuya.", 4000);
    }
    if (!net.role) net.host(roomMode());
    toast(`Invitación enviada a ${this.nickOf(id)}…`);
    net.whenHostReady(() => conn.open && conn.send({ t: "invite", code: net.code, game: romName, nick: this.nick }));
  },

  showInvite(id, m) {
    this.invite = { id, code: String(m.code || ""), game: String(m.game || "") };
    $("#inv-title").textContent = `🎮 ${m.nick || this.nickOf(id)} te invita a jugar`;
    $("#inv-game").textContent = m.game ? `«${m.game}»` : "";
    $("#invite-modal").hidden = false;
  },

  answerInvite(ok) {
    const inv = this.invite;
    this.invite = null;
    $("#invite-modal").hidden = true;
    if (!inv) return;
    const conn = this.conns.get(inv.id);
    if (conn && conn.open) conn.send({ t: ok ? "invite-ok" : "invite-no" });
    if (!ok || !/^[A-Z0-9]{6}$/.test(inv.code)) return;
    closeMenu();
    if (engine && romName !== inv.game) {
      // Estás en otro juego: se guarda y se abre el de la invitación.
      persistSave();
      sessionStorage.setItem("gbaweb-join", inv.code);
      return location.reload();
    }
    net.join(inv.code);
  },
};

function render() {
  renderFriends();
  renderLobby();
}

function renderProfile() {
  const has = !!friends.nick;
  $("#nick-form").hidden = has;
  $("#nick-view").hidden = !has;
  $("#my-nick").textContent = friends.nick;
  const st = { online: ["🟢", "En línea: tus amigos te ven"], connecting: ["🟡", "Conectando…"], offline: ["🔴", "Sin conexión con el servidor. Toca 🩺 para ver qué pasa"], taken: ["🟠", "Tu apodo está abierto en otro sitio"] }[friends.state] || ["⚪", ""];
  $("#my-status").textContent = st[0] + " " + st[1];
  $("#friends-box").hidden = !has;
}

// Por qué no se conecta un amigo (lo que se sabe del último intento).
function reachText(f) {
  const r = friends.reach.get(f.id);
  if (r === "offline" || r === "offline?") return "⚪ No está conectado ahora (o su apodo no es exactamente «" + f.nick + "»)";
  if (r === "blocked") return "🔄 Vuestras redes no se dejan unir directo: conectando por el servidor…";
  return "";
}

function renderFriends() {
  renderProfile();
  for (const list of document.querySelectorAll(".friends-list")) {
    list.innerHTML = "";
    if (!friends.list.length) {
      list.innerHTML = '<p class="hint">Añade a tu amigo con su apodo: le llegará una solicitud y, cuando la acepte, podréis invitaros a jugar.</p>';
      continue;
    }
    const rank = (f) => (f.state === "received" ? 3 : f.state === "ok" ? 1 + friends.conns.has(f.id) : 0);
    const sorted = [...friends.list].sort((a, b) => rank(b) - rank(a));
    for (const f of sorted) {
      const online = friends.conns.has(f.id);
      const st = friends.status.get(f.id) || {};
      const row = document.createElement("div");
      row.className = "friend-row " + f.state;
      if (f.state === "received") {
        row.innerHTML = `<span class="dot req">📩</span>
          <div class="friend-info"><b></b><small>Quiere ser tu amigo</small></div>
          <button class="btn small primary" data-accept>Aceptar</button>
          <button class="btn small ghost" data-reject aria-label="Rechazar">✕</button>`;
        row.querySelector("[data-accept]").onclick = () => friends.answerRequest(f.id, true);
        row.querySelector("[data-reject]").onclick = () => friends.answerRequest(f.id, false);
      } else if (f.state === "sent") {
        row.innerHTML = `<span class="dot req">${f.delivered ? "📨" : "⏳"}</span>
          <div class="friend-info"><b></b><small></small></div>
          <button class="btn small ghost" data-remove aria-label="Cancelar solicitud">✕</button>`;
        row.querySelector("small").textContent = f.delivered
          ? "Solicitud recibida · esperando a que acepte"
          : reachText(f) || "Solicitud sin enviar · le llegará cuando abráis la web los dos a la vez";
        row.querySelector("[data-remove]").onclick = () => friends.remove(f.id);
      } else {
        row.innerHTML = `<span class="dot ${online ? "on" : ""}"></span>
          <div class="friend-info"><b></b><small></small></div>
          <button class="btn small primary" data-invite ${online ? "" : "disabled"}>Invitar</button>
          <button class="btn small ghost" data-remove aria-label="Quitar">✕</button>`;
        row.querySelector("small").textContent = !online ? reachText(f) || "Desconectado" : st.game ? `Jugando ${st.game}${st.room ? " · en su sala" : ""}` : "En el menú";
        row.querySelector("[data-invite]").onclick = () => friends.sendInvite(f.id);
        row.querySelector("[data-remove]").onclick = () => friends.remove(f.id);
      }
      row.querySelector("b").textContent = f.nick;
      list.appendChild(row);
    }
  }
}

function renderLobby() {
  const box = $("#lobby");
  const show = isRoomMode(net.mode) && (net.role === "host" || net.role === "guest");
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = "";
  const players = net.roster.length ? net.roster : [{ id: 0, nick: net.hostNick || "Anfitrión" }];
  for (let i = 0; i < (net.mode === "sync" ? 2 : 4); i++) {
    const p = players[i];
    const slot = document.createElement("div");
    slot.className = "slot-card" + (p ? " taken" : "") + (p && p.id === 0 ? " host" : "");
    if (p) {
      slot.innerHTML = "<span class=\"avatar\"></span><b></b><small></small>";
      slot.querySelector(".avatar").textContent = (p.nick || "?").slice(0, 1).toUpperCase();
      slot.querySelector("b").textContent = p.nick;
      slot.querySelector("small").textContent = p.id === 0 ? "Anfitrión" : "J" + (p.id + 1);
    } else {
      slot.innerHTML = "<span class=\"free\">Libre</span>";
    }
    box.appendChild(slot);
  }
}

$("#nick-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const nick = $("#nick-input").value.trim().slice(0, 20);
  if (nickId(nick).length < 3) return toast("Tu apodo necesita al menos 3 letras o números");
  friends.nick = nick;
  friends.justSet = true;
  friends.save();
  render();
  friends.restart();
  toast(`¡Hola, ${nick}! Dale tu apodo a tus amigos para que te añadan.`, 4000);
});

$("#nick-edit").addEventListener("click", async () => {
  if (net.role) return toast("Termina el multijugador para cambiar tu apodo");
  const nick = await askText("👤 Tu nuevo apodo", friends.nick, "Guardar", 20);
  if (!nick || nickId(nick).length < 3) return;
  friends.nick = nick.trim().slice(0, 20);
  friends.justSet = true;
  friends.save();
  render();
  friends.restart();
});

for (const form of document.querySelectorAll(".friend-add")) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    friends.add(input.value);
    input.value = "";
  });
}

$("#inv-accept").addEventListener("click", () => friends.answerInvite(true));
$("#inv-decline").addEventListener("click", () => friends.answerInvite(false));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") friends.probe();
});

/* ---------- Android: instalar como app, vibración y botón atrás ---------- */

const android = {
  canVibrate: typeof navigator.vibrate === "function",
  vibration: lsGet("gbaweb-vibration") !== "0",
  installPrompt: null,
};

function haptic() {
  if (android.canVibrate && android.vibration) navigator.vibrate(12);
}

function renderAndroid() {
  const vib = $("[data-action=toggle-vibration]");
  vib.hidden = !android.canVibrate;
  vib.textContent = android.vibration ? "📳 Vibración: sí" : "📴 Vibración: no";
  $("[data-action=rotate]").hidden = !(screen.orientation && screen.orientation.lock);
}

// Chrome (Android) avisa cuando la web se puede instalar: se muestra el botón.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  android.installPrompt = e;
  $("#install-btn").hidden = false;
});
window.addEventListener("appinstalled", () => {
  $("#install-btn").hidden = true;
  toast("¡Instalada! Ya la tienes en tu pantalla de inicio.", 4000);
});
$("#install-btn").addEventListener("click", async () => {
  const prompt = android.installPrompt;
  if (!prompt) return;
  android.installPrompt = null;
  prompt.prompt();
  await prompt.userChoice.catch(() => {});
  $("#install-btn").hidden = true;
});

// Botón "atrás" de Android: dentro del juego abre o cierra el menú en vez de salir.
function trapBack() {
  if (!history.state || !history.state.gba) history.pushState({ gba: 1 }, "");
}
window.addEventListener("popstate", () => {
  if ($("#console").hidden) return;
  const open = ["#invite-modal", "#game-sheet", "#menu"].map((id) => $(id)).find((el) => !el.hidden);
  if (open) {
    if (open.id === "invite-modal") friends.answerInvite(false);
    else open.hidden = true;
  } else {
    openMenu();
  }
  trapBack();
});

$("#app-version").textContent = "Versión " + APP_VERSION;

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch((e) => console.warn("Sin modo sin conexión", e));
  // Si llega una versión nueva mientras estás en el menú, se recarga sola para usarla.
  // (la primera vez que se instala no hace falta: ya estás usando la versión nueva).
  let swReloaded = !navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (swReloaded || engine || net.role) { swReloaded = true; return; }
    swReloaded = true;
    location.reload();
  });
}

/* ---------- Sin zoom accidental del navegador (iPhone ignora user-scalable=no) ---------- */

let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd < 350 && !e.target.closest(".sheet-body, input, textarea")) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault());

/* ---------- Inicio ---------- */

loadLibrary().then(async () => {
  // Cambio de partida o de juego desde dentro del emulador: se recargó la página para arrancarla.
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem("gbaweb-play") || "null"); sessionStorage.removeItem("gbaweb-play"); } catch (e) { /* nada */ }
  if (pending) {
    const rom = await safeGet("roms", pending.name);
    if (rom) startGame(new File([rom.data], rom.name), rom, pending.pid);
  }
});
renderBios();
renderAndroid();
applyGraphics();
setPadHidden(lsGet("gbaweb-pad-hidden") === "1");
applyLook();
render();
friends.start();
// Invitación aceptada desde otro juego: se recargó la página para abrir el correcto.
const pendingJoin = sessionStorage.getItem("gbaweb-join");
sessionStorage.removeItem("gbaweb-join");
const joinCode = (new URLSearchParams(location.search).get("join") || pendingJoin || "").trim().toUpperCase();
if (joinCode) net.join(joinCode);
