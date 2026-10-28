"use strict";

/* GBA Web: interfaz para iPhone sobre gpSP (WebAssembly) + multijugador por WebRTC. */

const CORE_URL = "gpsp/gpsp.wasm";
const PEER_PREFIX = "gbaweb-v2-";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Si vuestra red bloquea conexiones directas, añade aquí un servidor TURN:
  // { urls: "turn:tu-servidor:3478", username: "usuario", credential: "clave" },
];
const SLOTS = 3;
const COVER_EVERY_MS = 30000;
const MAX_GUESTS = 4; // el adaptador inalámbrico admite hasta 5 consolas
const BROADCAST = 0xffff;

// Bits del mando (RetroPad de libretro).
const BUTTONS = { B: 0, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, L: 10, R: 11 };
const KEYMAP = {
  ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  KeyZ: "A", KeyX: "B", KeyQ: "L", KeyE: "R", KeyA: "L", KeyS: "R",
  Enter: "START", KeyV: "SELECT", Backspace: "SELECT",
};
// Mando Bluetooth (mapeo estándar): botón derecho = A, inferior = B.
const PADMAP = { 1: "A", 0: "B", 4: "L", 5: "R", 6: "L", 7: "R", 8: "SELECT", 9: "START", 12: "UP", 13: "DOWN", 14: "LEFT", 15: "RIGHT" };

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
  library.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || romTitle(a).localeCompare(romTitle(b)));
  renderLibrary();
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
    const info = document.createElement("div");
    info.className = "meta-info";
    info.innerHTML = "<b></b><small></small>";
    info.firstChild.textContent = title;
    info.lastChild.textContent = rom.lastPlayed ? "Jugado " + timeAgo(rom.lastPlayed) : "Nuevo";
    const more = document.createElement("button");
    more.className = "more";
    more.textContent = "⋯";
    more.setAttribute("aria-label", "Opciones de " + title);
    more.onclick = (e) => {
      e.stopPropagation();
      openGameSheet(rom);
    };
    card.append(cover, info, more);
    card.onclick = () => playRom(rom);
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

async function addToLibrary(files) {
  let added = 0;
  for (const file of files) {
    try {
      const old = library.find((r) => r.name === file.name);
      await db.put("roms", { ...old, name: file.name, data: file, size: file.size, added: (old && old.added) || Date.now() });
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

function playRom(rom) {
  startGame(new File([rom.data], rom.name), rom);
}

function openGameSheet(rom) {
  sheetRom = rom;
  $("#gs-title").textContent = romTitle(rom);
  const parts = [formatSize(rom.size || rom.data.size)];
  parts.push(rom.lastPlayed ? "jugado " + timeAgo(rom.lastPlayed) : "sin jugar");
  $("#gs-info").textContent = parts.join(" · ");
  $("[data-gs=cover]").hidden = !rom.cover;
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
    case "rename": {
      const title = prompt("Nuevo nombre:", romTitle(rom));
      if (!title || !title.trim()) return;
      await updateRom(rom.name, { title: title.trim() });
      break;
    }
    case "export": {
      const save = await safeGet("saves", baseName(rom.name));
      if (!save) return toast("Este juego aún no tiene partida guardada");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([save]));
      a.download = baseName(rom.name) + ".sav";
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
let romName = "";
let lastSave = null;
let libraryName = "";
let lastCover = 0;

async function readRom(file) {
  let data = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  if (data[0] === 0x50 && data[1] === 0x4b) { // .zip
    const files = fflate.unzipSync(data, { filter: (f) => /\.(gba|agb|bin)$/i.test(f.name) });
    const entry = Object.keys(files)[0];
    if (!entry) throw new Error("El .zip no contiene ningún archivo .gba");
    data = files[entry];
    name = entry.split("/").pop();
  }
  return { data, name };
}

async function startGame(file, record) {
  if (engine) return location.reload();
  showView("console");
  document.body.classList.remove("guest");
  screenMsg("Cargando…");
  try {
    const rom = await readRom(file);
    romName = baseName(rom.name);
    libraryName = file.name;
    $("#game-title").textContent = record ? romTitle(record) : romName;
    updateRom(libraryName, { lastPlayed: Date.now() });
    const bios = await safeGet("files", "bios");
    engine = await GbaEngine.create(CORE_URL, $("#game"));
    if (!engine.load(rom.data, bios)) throw new Error("El emulador no pudo abrir este juego.");
    const saved = await safeGet("saves", romName);
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
    else net.autoConnect();
  } catch (err) {
    console.error(err);
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
    const px = $("#game").getContext("2d").getImageData(0, 0, 240, 160).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
    if (sum / (px.length / 64) < 30) return;
    updateRom(libraryName, { cover: $("#game").toDataURL("image/jpeg", 0.85) });
  } catch (e) { /* lienzo no disponible */ }
}

async function persistSave() {
  if (!engine) return;
  saveCover(false);
  const data = engine.getSave();
  if (!data || sameBytes(data, lastSave)) return;
  lastSave = data;
  try { await db.put("saves", data, romName); } catch (e) { console.warn(e); }
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
  for (const name of next) if (!pressedNow.has(name)) (arms[name] || padButtons[name]).classList.add("on");
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
  return net.mode === "link" && (net.role === "host" || net.role === "guest");
}

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

const stateKey = (slot) => `${romName}#${slot}`;

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
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el);
    else toast("En iPhone: Compartir → Añadir a pantalla de inicio");
  },
  "host-link": () => net.host("link"),
  "host-screen": () => net.host("screen"),
  "stop-net": () => net.stop(),
  "room-connect": () => {
    net.autoPaused = false;
    net.autoConnect();
  },
  "room-forget": () => {
    if (!confirm("¿Olvidar la sala? Tendréis que volver a invitaros con un código.")) return;
    if (net.auto) net.stop(true);
    forgetRoom();
    net.renderSession();
    toast("Sala olvidada");
  },
  share: () => {
    const url = net.inviteUrl();
    const text = net.mode === "link"
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
  auto: false,          // sesión abierta sola al entrar en el juego (sala guardada)
  autoPaused: false,    // el jugador pulsó "Terminar multijugador"
  room: loadRoom(),     // código de la sala de amigos guardada

  inviteUrl() {
    return `${location.origin}${location.pathname}?join=${this.code}`;
  },

  sendJSON(conn, msg) {
    if (conn && conn.open) conn.send(JSON.stringify(msg));
  },

  newPeer(id) {
    if (!window.Peer) throw new Error("PeerJS no está disponible");
    // window.GBA_PEER_OPTIONS permite usar un servidor PeerJS propio ({ host, port, path, secure }).
    const opts = { config: { iceServers: ICE_SERVERS }, debug: 1, ...window.GBA_PEER_OPTIONS };
    return id ? new Peer(id, opts) : new Peer(opts);
  },

  renderSession() {
    updateFastForward();
    $("#room-box").hidden = !this.room || !!this.role;
    $("#room-code").textContent = this.room || "";
    const active = !!this.role;
    $("#mp-host").hidden = active;
    $("#mp-session").hidden = !active;
    if (!active) return;
    const isHost = this.role === "host";
    $("#mp-code-box").hidden = !isHost;
    $("#guest-control-row").hidden = !(isHost && this.mode === "screen");
    $("#mp-mode").textContent = this.mode === "link"
      ? `🔗 Sala ${this.code}: cada uno con su partida. Al abrir el juego os conectáis solos; invitaos desde el menú multijugador del juego.`
      : "📺 Compartiendo pantalla.";
    let players = "";
    if (isHost) players = this.conns.size ? `Conectados: ${this.conns.size + 1} jugadores` : "Esperando a tu amigo…";
    else if (this.role === "guest") players = `Conectado a la partida de tu amigo (código ${this.code}).`;
    $("#mp-players").textContent = players;
  },

  /* ----- Anfitrión ----- */

  host(mode, fixedCode) {
    if (this.role) return;
    if (!engine) return toast("Espera a que cargue el juego");
    this.role = "host";
    this.mode = mode;
    this.code = fixedCode || randomCode();
    if (!fixedCode) this.auto = false;
    if (mode === "link") saveRoom(this.code);
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
      setNetStatus(this.auto ? "🔗 Sala · esperando a tu amigo" : "Esperando amigo · " + this.code, "wait");
      if (mode === "link") {
        engine.onNetSend = (data, client) => this.hostSend(data, client, 0);
        engine.netStart(0);
      }
    });
    peer.on("error", (err) => {
      console.error(err);
      if (err.type === "unavailable-id") {
        this.stop(true);
        // En una sala, si el código ya está ocupado es que tu amigo ya es el anfitrión: te unes a él.
        if (fixedCode) return this.join(fixedCode, { auto: this.auto });
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
  },

  acceptGuest(conn) {
    let id = 0;
    const gone = () => {
      if (!id || this.conns.get(id) !== conn) return;
      this.conns.delete(id);
      if (this.mode === "link") engine.netDisconnected(id);
      else {
        if (this.call) this.call.close();
        this.call = null;
        remoteMask = 0;
        applyButtons();
      }
      if (this.role === "host") {
        setNetStatus(this.conns.size ? `👥 ${this.conns.size + 1} jugadores` : "Esperando amigo · " + this.code, this.conns.size ? "ok" : "wait");
        toast("Tu amigo se ha desconectado");
        this.renderSession();
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
      this.sendJSON(conn, { t: "welcome", id });
      if (this.mode === "screen") this.call = this.peer.call(conn.peer, buildStream());
      setNetStatus(`👥 ${this.conns.size + 1} jugadores`, "ok");
      toast(this.mode === "link" ? "¡Tu amigo está conectado! Invitaos desde el menú multijugador del juego." : "¡Tu amigo se ha unido!", 5000);
      this.renderSession();
    };
    conn.on("open", () => {
      heartbeat(conn, gone);
      this.sendJSON(conn, { t: "hello", mode: this.mode, game: romName, ctl: this.guestControl });
      if (this.mode === "screen") admit();
    });
    conn.on("data", (msg) => {
      if (typeof msg === "string") {
        const m = parseJSON(msg);
        if (!m) return;
        if (m.t === "ready" && this.mode === "link" && !id) admit();
        else if (m.t === "k" && this.mode === "screen") {
          remoteMask = m.m | 0;
          applyButtons();
        }
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

  join(code, opts = {}) {
    if (this.role || this.peer) this.stop(true);
    this.code = code;
    this.auto = !!opts.auto;
    if (!opts.auto) this.autoPaused = false;
    history.replaceState(null, "", location.pathname);
    let peer;
    try {
      peer = this.peer = this.newPeer();
    } catch (e) {
      return toast("No se pudo iniciar el multijugador: " + e.message, 4000);
    }
    if (!this.auto) toast("Conectando con " + code + "…", 4000);
    peer.on("open", () => {
      const conn = this.conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "raw" });
      conn.on("data", (msg) => this.onHostData(msg));
      setTimeout(() => {
        if (this.conn === conn && !conn.open) {
          if (this.auto) return this.retryAuto();
          showNetError("No se pudo conectar directamente con tu amigo. Suele pasar con algunos datos móviles: probad los dos con Wi‑Fi, y que tu amigo tenga la web abierta en pantalla.");
          conn.close();
        }
      }, 20000);
      const gone = () => {
        if (this.conn !== conn) return;
        if (this.mode === "link" && this.role === "guest") engine.netStop();
        const wasGuest = this.role === "guest";
        lastNetError = "Se perdió la conexión con tu amigo. Si tenéis una sala guardada, os volveréis a conectar solos.";
        setNetStatus("Desconectado", "bad");
        if (this.role === "viewer") screenMsg("La partida ha terminado o se perdió la conexión.");
        else toast("Se perdió la conexión con tu amigo", 4000);
        this.role = null;
        this.conn = null;
        this.renderSession();
        // En una sala, si el anfitrión se va, se vuelve a buscar (o a ser el anfitrión) solo.
        if (wasGuest && this.room && engine) this.retryAuto();
      };
      conn.on("open", () => heartbeat(conn, gone));
      conn.on("close", gone);
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
      // En la sala automática, si tu amigo aún no ha llegado, se reintenta en silencio.
      if (this.auto && err.type === "peer-unavailable") return this.retryAuto();
      const msg = explainPeerError(err, code);
      showNetError(msg);
      if (this.role === "viewer") screenMsg(msg);
    });
    peer.on("disconnected", () => reconnectLater(peer));
  },

  onHostData(msg) {
    if (typeof msg !== "string") {
      if (this.role !== "guest") return;
      const bytes = new Uint8Array(msg);
      engine.netReceive(bytes[0] | (bytes[1] << 8), bytes.slice(2));
      return;
    }
    const m = parseJSON(msg);
    if (!m) return;
    if (m.t === "hello") {
      this.mode = m.mode;
      this.hostGame = m.game;
      if (m.mode === "screen") this.becomeViewer(m);
      else if (engine) this.sendReady();
      else this.waitForRom(m.game);
    } else if (m.t === "welcome") {
      if (this.mode === "link") {
        this.role = "guest";
        engine.onNetSend = (data, client) => {
          const framed = new Uint8Array(data.length + 2);
          framed[0] = client & 0xff;
          framed[1] = client >> 8;
          framed.set(data, 2);
          if (this.conn && this.conn.open) this.conn.send(framed.buffer);
        };
        engine.netStart(m.id);
        saveRoom(this.code);
        setNetStatus(`🔗 Conectado · J${m.id + 1}`, "ok");
        toast(this.hostGame && this.hostGame !== romName
          ? `Conectado. Ojo: tu ROM («${romName}») y la de tu amigo («${this.hostGame}») tienen nombres distintos; tienen que ser la misma versión.`
          : "¡Conectados! Ya podéis invitaros desde el menú multijugador del juego.", 6000);
      }
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
    banner.textContent = `🔗 Tu amigo te espera en «${game}». Carga tu ROM (la misma versión) para jugar juntos.`;
    setNetStatus("Esperando tu ROM", "wait");
  },

  sendReady() {
    this.pendingLink = false;
    this.sendJSON(this.conn, { t: "ready", game: romName });
    setNetStatus("Conectando…", "wait");
  },

  becomeViewer(m) {
    if (engine) {
      persistSave();
      engine.stop();
      engine.setMuted(true);
    }
    this.role = "viewer";
    document.body.classList.add("guest");
    showView("console");
    $("#game-title").textContent = "Partida de tu amigo · " + m.game;
    setNetStatus("👥 Conectado", "ok");
    screenMsg("Esperando la imagen…");
    if (!m.ctl) toast("Tu amigo ha desactivado tus controles");
  },

  // Sala de amigos: al abrir un juego, el primero que llega es el anfitrión y el otro se une solo.
  autoConnect() {
    if (!engine || !this.room || this.role || this.peer || this.autoPaused || this.pendingLink) return;
    this.auto = true;
    this.host("link", this.room);
  },

  retryAuto() {
    this.stop(true);
    this.auto = true;
    setNetStatus("🔗 Sala · buscando a tu amigo", "wait");
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.autoConnect(), 4000 + Math.random() * 2000);
  },

  stop(silent) {
    if (engine && this.mode === "link") engine.netStop();
    if (this.call) this.call.close();
    if (this.conn) this.conn.close();
    for (const conn of this.conns.values()) conn.close();
    if (this.peer) this.peer.destroy();
    this.peer = this.conn = this.call = null;
    this.conns.clear();
    this.role = this.mode = null;
    remoteMask = 0;
    applyButtons();
    this.renderSession();
    if (!silent) {
      this.autoPaused = true;
      clearTimeout(this.retryTimer);
      setNetStatus("");
      toast("Multijugador terminado");
    }
  },
};

function loadRoom() {
  try { return localStorage.getItem("gbaweb-sala") || ""; } catch (e) { return ""; }
}

function saveRoom(code) {
  net.room = code;
  try { localStorage.setItem("gbaweb-sala", code); } catch (e) { /* sin almacenamiento */ }
}

function forgetRoom() {
  net.room = "";
  try { localStorage.removeItem("gbaweb-sala"); } catch (e) { /* sin almacenamiento */ }
}

const SIGNALING_ERRORS = ["network", "server-error", "socket-error", "socket-closed", "disconnected"];
let lastNetError = "";

function explainPeerError(err, code) {
  switch (err.type) {
    case "peer-unavailable":
      return `No se encuentra la partida ${code || ""}. Revisa el código y pide a tu amigo que tenga la web abierta en pantalla (si bloquea el móvil, la partida se cierra).`;
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

/* ---------- Inicio ---------- */

loadLibrary();
renderBios();
const joinCode = (new URLSearchParams(location.search).get("join") || "").trim().toUpperCase();
if (joinCode) net.join(joinCode);
