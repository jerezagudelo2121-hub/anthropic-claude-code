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
    friends.broadcastStatus();
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
    const opts = { config: { iceServers: ICE_SERVERS }, debug: 1, ...window.GBA_PEER_OPTIONS };
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
    $("#mp-mode").textContent = this.mode === "link"
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
      toast(this.mode === "link" ? `¡${guestNick} ha entrado en la sala! Invitaos desde el menú multijugador del juego.` : `¡${guestNick} se ha unido!`, 5000);
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
        if (m.t === "ready" && this.mode === "link" && !id) admit();
        else if (m.t === "viewer" && this.mode === "screen" && id) {
          this.names.set(id, guestNick);
          this.updateRoster();
        }
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
    peer.on("open", () => {
      const conn = this.conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "raw" });
      conn.on("data", (msg) => this.onHostData(msg));
      setTimeout(() => {
        if (this.conn === conn && !conn.open) {
          showNetError("No se pudo conectar directamente con tu amigo. Suele pasar con algunos datos móviles: probad los dos con Wi‑Fi, y que tu amigo tenga la web abierta en pantalla.");
          conn.close();
        }
      }, 20000);
      const gone = () => {
        if (this.conn !== conn) return;
        if (this.mode === "link" && this.role === "guest") engine.netStop();
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
      this.hostNick = m.nick || "tu amigo";
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

const FRIEND_PROBE_MS = 15000;

function lsGet(key) {
  try { return localStorage.getItem(key) || ""; } catch (e) { return ""; }
}

function nickId(nick) {
  return String(nick || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

const friends = {
  nick: lsGet("gbaweb-apodo"),
  list: [].concat(parseJSON(lsGet("gbaweb-amigos") || "[]") || []), // [{ id, nick }]
  peer: null,
  conns: new Map(),     // id de amigo -> conexión abierta
  pending: new Set(),   // ids a los que se está intentando conectar
  status: new Map(),    // id de amigo -> { game, room }
  invite: null,         // invitación recibida pendiente

  save() {
    try {
      localStorage.setItem("gbaweb-apodo", this.nick);
      localStorage.setItem("gbaweb-amigos", JSON.stringify(this.list));
    } catch (e) { /* sin almacenamiento */ }
  },

  peerIdFor(id) {
    return PEER_PREFIX + "u-" + id;
  },

  start() {
    if (!this.nick || this.peer || !window.Peer) return;
    let peer;
    try { peer = this.peer = net.newPeer(this.peerIdFor(nickId(this.nick))); } catch (e) { return; }
    peer.on("open", () => {
      this.online = true;
      this.justSet = false;
      render();
      this.probe();
    });
    peer.on("connection", (conn) => this.attach(conn));
    peer.on("error", (err) => {
      if (err.type === "unavailable-id") {
        this.peer = null;
        peer.destroy();
        this.online = false;
        render();
        toast(`El apodo «${this.nick}» ya lo está usando otra persona (o tienes la web abierta en otra pestaña). Elige otro.`, 6000);
        if (this.justSet) {
          // Apodo recién elegido y ocupado: se vuelve a pedir.
          this.nick = "";
          this.save();
          render();
        }
        return;
      }
      if (err.type === "peer-unavailable") {
        // El amigo al que se intentaba llamar no está conectado.
        const m = /u-([a-z0-9]+)/.exec(err.message || "");
        if (m) this.pending.delete(m[1]);
        return;
      }
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
    for (const f of this.list) {
      if (this.conns.has(f.id) || this.pending.has(f.id)) continue;
      this.pending.add(f.id);
      const conn = this.peer.connect(this.peerIdFor(f.id), { serialization: "json", metadata: { kind: "friend" } });
      this.attach(conn);
      setTimeout(() => {
        if (!conn.open) {
          this.pending.delete(f.id);
          conn.close();
        }
      }, 10000);
    }
  },

  attach(conn) {
    let id = conn.peer.replace(PEER_PREFIX + "u-", "");
    conn.on("open", () => {
      this.pending.delete(id);
      this.conns.set(id, conn);
      conn.send(this.hello());
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

  hello() {
    return { t: "hi", nick: this.nick, game: engine ? romName : "", room: net.role === "host" && net.mode === "link" };
  },

  broadcastStatus() {
    for (const conn of this.conns.values()) if (conn.open) conn.send(this.hello());
    render();
  },

  onMessage(id, conn, m) {
    if (!m || typeof m !== "object") return;
    if (m.t === "hi") {
      this.status.set(id, { game: m.game || "", room: !!m.room });
      // Si alguien te ha añadido, también aparece en tu lista.
      if (!this.list.some((f) => f.id === id) && m.nick) {
        this.list.push({ id, nick: String(m.nick).slice(0, 20) });
        this.save();
        toast(`${m.nick} te ha añadido como amigo`, 4000);
      }
      render();
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
    this.list.push({ id, nick: nick.trim().slice(0, 20) });
    this.save();
    render();
    this.probe();
    toast(`${nick.trim()} añadido. Aparecerá en verde cuando tenga la web abierta.`, 4000);
  },

  remove(id) {
    if (!confirm(`¿Quitar a ${this.nickOf(id)} de tus amigos?`)) return;
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
    if (!engine) return toast("Abre primero tu juego para poder invitar");
    if (net.role && !(net.role === "host" && net.mode === "link")) {
      return toast("Ya estás en una sala. Termina el multijugador para crear la tuya.", 4000);
    }
    if (!net.role) net.host("link");
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
  $("#friends-box").hidden = !has;
}

function renderFriends() {
  renderProfile();
  for (const list of document.querySelectorAll(".friends-list")) {
    list.innerHTML = "";
    if (!friends.list.length) {
      list.innerHTML = '<p class="hint">Añade a tu amigo con su apodo. Él tiene que añadirte a ti con el tuyo (o aceptarte cuando te vea).</p>';
      continue;
    }
    const sorted = [...friends.list].sort((a, b) => friends.conns.has(b.id) - friends.conns.has(a.id));
    for (const f of sorted) {
      const online = friends.conns.has(f.id);
      const st = friends.status.get(f.id) || {};
      const row = document.createElement("div");
      row.className = "friend-row";
      row.innerHTML = `<span class="dot ${online ? "on" : ""}"></span>
        <div class="friend-info"><b></b><small></small></div>
        <button class="btn small primary" data-invite ${online ? "" : "disabled"}>Invitar</button>
        <button class="btn small ghost" data-remove aria-label="Quitar">✕</button>`;
      row.querySelector("b").textContent = f.nick;
      row.querySelector("small").textContent = !online ? "Desconectado" : st.game ? `Jugando ${st.game}${st.room ? " · en su sala" : ""}` : "En el menú";
      row.querySelector("[data-invite]").onclick = () => friends.sendInvite(f.id);
      row.querySelector("[data-remove]").onclick = () => friends.remove(f.id);
      list.appendChild(row);
    }
  }
}

function renderLobby() {
  const box = $("#lobby");
  const show = net.mode === "link" && (net.role === "host" || net.role === "guest");
  box.hidden = !show;
  if (!show) return;
  box.innerHTML = "";
  const players = net.roster.length ? net.roster : [{ id: 0, nick: net.hostNick || "Anfitrión" }];
  for (let i = 0; i < 4; i++) {
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

$("#nick-edit").addEventListener("click", () => {
  if (net.role) return toast("Termina el multijugador para cambiar tu apodo");
  const nick = prompt("Tu nuevo apodo:", friends.nick);
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

/* ---------- Inicio ---------- */

loadLibrary();
renderBios();
render();
friends.start();
// Invitación aceptada desde otro juego: se recargó la página para abrir el correcto.
const pendingJoin = sessionStorage.getItem("gbaweb-join");
sessionStorage.removeItem("gbaweb-join");
const joinCode = (new URLSearchParams(location.search).get("join") || pendingJoin || "").trim().toUpperCase();
if (joinCode) net.join(joinCode);
