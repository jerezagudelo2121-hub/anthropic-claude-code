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
const MAX_RECENT = 5;
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

async function renderRecent() {
  let roms = [];
  try { roms = await db.all("roms"); } catch (e) { /* modo privado, etc. */ }
  roms.sort((a, b) => b.lastPlayed - a.lastPlayed);
  const list = $("#recent-list");
  list.innerHTML = "";
  for (const rom of roms) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.innerHTML = `<span></span><small>${timeAgo(rom.lastPlayed)}</small>`;
    btn.firstChild.textContent = baseName(rom.name);
    btn.onclick = () => startGame(new File([rom.data], rom.name));
    li.appendChild(btn);
    list.appendChild(li);
  }
  $("#recent").hidden = roms.length === 0;
}

async function renderBios() {
  const bios = await safeGet("files", "bios");
  const el = $("#bios-status");
  el.textContent = bios ? "Cargada ✓" : "No cargada";
  el.classList.toggle("ok", !!bios);
}

async function rememberRom(file) {
  try {
    await db.put("roms", { name: file.name, data: file, lastPlayed: Date.now() });
    const roms = (await db.all("roms")).sort((a, b) => b.lastPlayed - a.lastPlayed);
    for (const old of roms.slice(MAX_RECENT)) await db.del("roms", old.name);
  } catch (e) {
    console.warn("No se pudo recordar la ROM", e);
  }
}

$("#rom-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) startGame(file);
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

async function startGame(file) {
  if (engine) return location.reload();
  showView("console");
  document.body.classList.remove("guest");
  screenMsg("Cargando…");
  try {
    const rom = await readRom(file);
    romName = baseName(rom.name);
    $("#game-title").textContent = romName;
    rememberRom(file);
    const bios = await safeGet("files", "bios");
    engine = await GbaEngine.create(CORE_URL, $("#game"));
    if (!engine.load(rom.data, bios)) throw new Error("El emulador no pudo abrir este juego.");
    const saved = await safeGet("saves", romName);
    if (saved) engine.setSave(saved);
    lastSave = engine.getSave();
    engine.onFrame = pollGamepads;
    engine.resumeAudio();
    engine.start();
    screenMsg("");
    renderSlots();
    setInterval(persistSave, 5000);
    if (net.pendingLink) net.sendReady();
  } catch (err) {
    console.error(err);
    screenMsg("No se pudo cargar: " + err.message);
  }
}

async function persistSave() {
  if (!engine) return;
  const data = engine.getSave();
  if (!data || sameBytes(data, lastSave)) return;
  lastSave = data;
  try { await db.put("saves", data, romName); } catch (e) { console.warn(e); }
}

// iOS puede cerrar la pestaña sin avisar: guarda al salir de la app.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistSave();
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

// Avance rápido: botón ⏩ mantenido o interruptor del menú. En multijugador se desactiva,
// porque la otra consola seguiría a velocidad normal y se perdería la conexión.
let ffHold = false, ffToggle = false;

function linkActive() {
  return net.mode === "link" && (net.role === "host" || net.role === "guest");
}

function ffAllowed() {
  return !net.role;
}

function updateFastForward() {
  const allowed = ffAllowed();
  if (!allowed) ffToggle = false;
  const on = !!engine && allowed && (ffHold || ffToggle);
  if (engine) engine.fastForward = on;
  padButtons.FF.classList.toggle("on", on);
  padButtons.FF.classList.toggle("disabled", !allowed);
  const btn = $("[data-action=ff-toggle]");
  btn.textContent = !allowed ? "⏩ No disponible online" : ffToggle ? "⏩ Velocidad x1" : "⏩ Velocidad x2";
  btn.disabled = !allowed;
}

/* ---------- Menú ---------- */

function openMenu() {
  updatePressed([]);
  $("#menu").hidden = false;
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
    await persistSave();
    net.stop(true);
    location.replace(location.pathname);
  },
  mute: (btn) => {
    if (!engine) return;
    engine.setMuted(!engine.muted);
    btn.textContent = engine.muted ? "🔇 Sin sonido" : "🔊 Sonido";
  },
  "ff-toggle": () => {
    if (!ffAllowed()) return toast("La velocidad rápida no funciona en multijugador");
    ffToggle = !ffToggle;
    updateFastForward();
    closeMenu();
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
      ? "🔗 Jugar juntos: cada uno con su partida."
      : "📺 Compartiendo pantalla.";
    let players = "";
    if (isHost) players = this.conns.size ? `Conectados: ${this.conns.size + 1} jugadores` : "Esperando a tu amigo…";
    else if (this.role === "guest") players = `Conectado a la partida de tu amigo (código ${this.code}).`;
    $("#mp-players").textContent = players;
  },

  /* ----- Anfitrión ----- */

  host(mode) {
    if (this.role) return;
    if (!engine) return toast("Espera a que cargue el juego");
    this.role = "host";
    this.mode = mode;
    this.code = randomCode();
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
      setNetStatus("Esperando amigo · " + this.code, "wait");
      if (mode === "link") {
        engine.onNetSend = (data, client) => this.hostSend(data, client, 0);
        engine.netStart(0);
      }
    });
    peer.on("error", (err) => {
      console.error(err);
      if (err.type === "unavailable-id") {
        this.stop(true);
        return this.host(mode);
      }
      toast("Error de conexión: " + (err.type || err.message));
      setNetStatus("Sin conexión", "bad");
    });
    peer.on("disconnected", () => {
      if (this.peer === peer && !peer.destroyed) peer.reconnect();
    });
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
      toast("¡Tu amigo se ha unido!");
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

  join(code) {
    if (this.role) this.stop(true);
    this.code = code;
    history.replaceState(null, "", location.pathname);
    let peer;
    try {
      peer = this.peer = this.newPeer();
    } catch (e) {
      return toast("No se pudo iniciar el multijugador: " + e.message, 4000);
    }
    toast("Conectando con " + code + "…", 4000);
    peer.on("open", () => {
      const conn = this.conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "raw" });
      conn.on("data", (msg) => this.onHostData(msg));
      const gone = () => {
        if (this.conn !== conn) return;
        if (this.mode === "link" && this.role === "guest") engine.netStop();
        setNetStatus("Desconectado", "bad");
        if (this.role === "viewer") screenMsg("La partida ha terminado o se perdió la conexión.");
        else toast("Se perdió la conexión con tu amigo", 4000);
        this.role = null;
        this.conn = null;
        this.renderSession();
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
      const msg = err.type === "peer-unavailable"
        ? "No existe ninguna partida con el código " + code + "."
        : "No se pudo conectar (" + (err.type || err.message) + ").";
      setNetStatus("Error", "bad");
      if (this.role === "viewer") screenMsg(msg);
      else toast(msg, 5000);
    });
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
        setNetStatus(`🔗 Conectado · J${m.id + 1}`, "ok");
        toast(this.hostGame && this.hostGame !== romName
          ? `Conectado. Ojo: tu ROM («${romName}») y la de tu amigo («${this.hostGame}») tienen nombres distintos; tienen que ser la misma versión.`
          : "¡Conectado! Ya podéis usar el modo multijugador del juego.", 6000);
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
      setNetStatus("");
      toast("Multijugador terminado");
    }
  },
};

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

renderRecent();
renderBios();
const joinCode = (new URLSearchParams(location.search).get("join") || "").trim().toUpperCase();
if (joinCode) net.join(joinCode);
