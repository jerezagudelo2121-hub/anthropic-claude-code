"use strict";

/* GBA Web: interfaz para iPhone sobre EmulatorJS (núcleo mGBA) + multijugador por WebRTC. */

const EJS_DATA = "vendor/emulatorjs/data/";
const PEER_PREFIX = "gbaweb-v1-";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // Si tu red bloquea conexiones directas, añade aquí un servidor TURN:
  // { urls: "turn:tu-servidor:3478", username: "usuario", credential: "clave" },
];
const SLOTS = 3;
const MAX_RECENT = 5;

// Índices de botones del RetroPad que usa EmulatorJS para GBA.
const BUTTONS = { B: 0, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, L: 10, R: 11 };
// Mismas teclas que EmulatorJS usa por defecto en el anfitrión.
const KEYMAP = {
  ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  KeyZ: "A", KeyX: "B", KeyQ: "L", KeyE: "R", Enter: "START", KeyV: "SELECT",
};

const $ = (sel) => document.querySelector(sel);

/* ---------- Audio: se puede reanudar en iOS y se puede enviar al amigo ---------- */

const audioContexts = [];
(function patchAudio() {
  const Base = window.AudioContext || window.webkitAudioContext;
  if (!Base) return;
  class TappedAudioContext extends Base {
    constructor(...args) {
      super(...args);
      audioContexts.push(this);
      try { this.__tap = this.createMediaStreamDestination(); } catch (e) { this.__tap = null; }
    }
  }
  window.AudioContext = TappedAudioContext;
  window.webkitAudioContext = TappedAudioContext;
  // Todo lo que suena por los altavoces también va a una pista que se puede transmitir.
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const result = connect.call(this, dest, ...rest);
    const tap = this.context && this.context.__tap;
    if (tap && dest === this.context.destination) {
      try { connect.call(this, tap); } catch (e) { /* ignorar */ }
    }
    return result;
  };
  const resume = () => audioContexts.forEach((c) => c.state !== "running" && c.resume().catch(() => {}));
  ["touchend", "pointerdown", "keydown"].forEach((t) => window.addEventListener(t, resume, true));
})();

function gameAudioTrack() {
  for (let i = audioContexts.length - 1; i >= 0; i--) {
    const tap = audioContexts[i].__tap;
    const track = tap && tap.stream.getAudioTracks()[0];
    if (track) return track;
  }
  return null;
}

/* ---------- IndexedDB: ROMs recientes y estados guardados ---------- */

const db = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open("gbaweb", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("roms", { keyPath: "name" });
      req.result.createObjectStore("states");
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

function emu() {
  return window.EJS_emulator && window.EJS_emulator.started ? window.EJS_emulator : null;
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

$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#join-code").value.trim().toUpperCase();
  if (code.length < 4) return toast("Escribe el código que te envió tu amigo");
  joinGame(code);
});

/* ---------- Arrancar el emulador (anfitrión / un jugador) ---------- */

let romName = "";

function startGame(file) {
  romName = baseName(file.name);
  rememberRom(file);
  document.body.classList.remove("guest");
  showView("console");
  $("#game-title").textContent = romName;
  screenMsg("Cargando…");

  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: "gba",
    EJS_pathtodata: EJS_DATA,
    EJS_gameUrl: file,
    EJS_gameName: romName,
    EJS_startOnLoaded: true,
    EJS_DEBUG_XX: true, // carga los scripts sin minificar que incluimos
    EJS_threads: false,
    EJS_color: "#7b5cff",
    EJS_backgroundColor: "#000000",
    EJS_language: "es-ES",
    EJS_defaultOptions: {
      "virtual-gamepad": "disabled",
      "save-save-interval": "30",
      "save-state-location": "browser",
    },
    EJS_onGameStart: onGameStart,
  });
  const s = document.createElement("script");
  s.src = EJS_DATA + "loader.js";
  s.onerror = () => screenMsg("No se pudo cargar el emulador.");
  document.body.appendChild(s);
}

function onGameStart() {
  screenMsg("");
  renderSlots();
  // iOS puede cerrar la pestaña sin avisar: guarda la partida al salir de la app.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
  window.addEventListener("pagehide", flushSave);
}

function flushSave() {
  const e = emu();
  if (!e) return;
  try { e.gameManager.saveSaveFiles(); } catch (err) { console.warn(err); }
}

/* ---------- Entrada: mando táctil, teclado ---------- */

const local = new Uint8Array(12);   // botones pulsados en este dispositivo
const remote = new Uint8Array(12);  // botones pulsados por el amigo (solo anfitrión)
const applied = new Uint8Array(12); // lo que se le ha enviado al núcleo
let fastForward = false;

function applyButton(i) {
  const v = local[i] || (net.guestControl && remote[i]) ? 1 : 0;
  if (v === applied[i]) return;
  applied[i] = v;
  const e = emu();
  if (e) e.gameManager.simulateInput(0, i, v);
}

function setLocal(name, pressed) {
  if (name === "FF") return setFastForward(pressed);
  const i = BUTTONS[name];
  const v = pressed ? 1 : 0;
  if (local[i] === v) return;
  local[i] = v;
  if (net.role === "guest") net.send({ t: "k", b: i, v });
  else applyButton(i);
}

function setFastForward(on) {
  const e = emu();
  if (!e || net.role === "guest" || on === fastForward) return;
  fastForward = on;
  e.gameManager.toggleFastForward(on ? 1 : 0);
  $("[data-action=ff]").classList.toggle("on", on);
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
  for (const name of pressedNow) if (!next.has(name)) release(name);
  for (const name of next) if (!pressedNow.has(name)) press(name);
  pressedNow = next;
}

function press(name) {
  (arms[name] || padButtons[name]).classList.add("on");
  setLocal(name, true);
}

function release(name) {
  (arms[name] || padButtons[name]).classList.remove("on");
  setLocal(name, false);
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

// En el anfitrión el teclado lo gestiona EmulatorJS; el invitado usa el mismo esquema.
function onKey(e) {
  if (net.role !== "guest" || !$("#menu").hidden) return;
  const name = KEYMAP[e.code];
  if (!name) return;
  e.preventDefault();
  setLocal(name, e.type === "keydown");
}
window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);

/* ---------- Menú ---------- */

function openMenu() {
  updatePressed([]);
  $("#menu").hidden = false;
  if (net.role !== "guest") renderSlots();
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
    let saved = null;
    try { saved = await db.get("states", stateKey(slot)); } catch (e) { /* sin IndexedDB */ }
    const div = document.createElement("div");
    div.className = "slot";
    div.innerHTML = `<b>Ranura ${slot}</b><small>${saved ? timeAgo(saved.time) : "Vacía"}</small>
      <button class="btn" data-save="${slot}">Guardar</button>
      <button class="btn" data-load="${slot}" ${saved ? "" : "disabled"}>Cargar</button>`;
    wrap.appendChild(div);
  }
}

$("#slots").addEventListener("click", async (e) => {
  const em = emu();
  if (!em) return;
  const saveSlot = e.target.dataset.save;
  const loadSlot = e.target.dataset.load;
  try {
    if (saveSlot) {
      const data = em.gameManager.getState().slice();
      await db.put("states", { data, time: Date.now() }, stateKey(saveSlot));
      toast(`Guardado en la ranura ${saveSlot}`);
      renderSlots();
    } else if (loadSlot) {
      const saved = await db.get("states", stateKey(loadSlot));
      if (!saved) return;
      em.gameManager.loadState(saved.data);
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
  quit: () => {
    flushSave();
    net.stop();
    setTimeout(() => location.replace(location.pathname), 150);
  },
  mute: (btn) => {
    const em = emu();
    if (!em) return;
    em.muted = !em.muted;
    em.setVolume(em.muted ? 0 : em.volume);
    btn.textContent = em.muted ? "🔇 Sin sonido" : "🔊 Sonido";
  },
  "ff-toggle": (btn) => {
    setFastForward(!fastForward);
    btn.textContent = fastForward ? "⏩ Velocidad x1" : "⏩ Velocidad x2";
  },
  restart: () => {
    const em = emu();
    if (em && confirm("¿Reiniciar el juego? Se perderá lo que no hayas guardado.")) {
      em.gameManager.restart();
      closeMenu();
    }
  },
  "export-save": () => {
    const em = emu();
    const data = em && em.gameManager.getSaveFile();
    if (!data) return toast("Este juego aún no tiene partida guardada");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = romName + ".sav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  "import-save": () => $("#sav-input").click(),
  fullscreen: () => {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el);
    else toast("En iPhone: Compartir → Añadir a pantalla de inicio");
  },
  host: () => net.host(),
  "stop-host": () => net.stop(),
  share: () => {
    const url = net.inviteUrl();
    if (navigator.share) {
      navigator.share({ title: "GBA Web", text: `¡Juega conmigo a ${romName}! Código: ${net.code}`, url }).catch(() => {});
    } else {
      actions.copy();
    }
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

$("#sav-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  const em = emu();
  if (!file || !em) return;
  const gm = em.gameManager;
  gm.FS.writeFile(gm.getSaveFilePath(), new Uint8Array(await file.arrayBuffer()));
  gm.loadSaveFiles();
  gm.restart();
  toast("Partida importada");
  closeMenu();
});

$("#guest-control").addEventListener("change", (e) => {
  net.guestControl = e.target.checked;
  for (let i = 0; i < 12; i++) applyButton(i);
  net.send({ t: "ctl", on: net.guestControl });
});

/* ---------- Multijugador online (WebRTC con PeerJS) ----------
 * El anfitrión ejecuta el juego y transmite imagen y sonido; el invitado envía sus botones.
 * Ambos controlan la misma consola, como dos personas compartiendo una Game Boy.
 */

const net = {
  role: null, // null | "host" | "guest"
  peer: null,
  conn: null,
  call: null,
  code: "",
  guestControl: true,

  inviteUrl() {
    return `${location.origin}${location.pathname}?join=${this.code}`;
  },

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  },

  newPeer(id) {
    if (!window.Peer) throw new Error("PeerJS no está disponible");
    // window.GBA_PEER_OPTIONS permite usar un servidor PeerJS propio ({ host, port, path, secure }).
    return new Peer(id, { config: { iceServers: ICE_SERVERS }, debug: 1, ...window.GBA_PEER_OPTIONS });
  },

  host() {
    if (this.role === "host") return;
    if (!emu()) return toast("Espera a que cargue el juego");
    this.role = "host";
    this.code = randomCode();
    $("#mp-host").hidden = true;
    $("#mp-session").hidden = false;
    $("#mp-code").textContent = "······";
    setNetStatus("Conectando…", "wait");

    const peer = this.peer = this.newPeer(PEER_PREFIX + this.code);
    peer.on("open", () => {
      $("#mp-code").textContent = this.code;
      setNetStatus("Esperando amigo · " + this.code, "wait");
    });
    peer.on("error", (err) => {
      console.error(err);
      if (err.type === "unavailable-id") {
        this.stop(true);
        return this.host();
      }
      if (err.type === "peer-unavailable") return;
      toast("Error de conexión: " + (err.type || err.message));
      setNetStatus("Sin conexión", "bad");
    });
    peer.on("disconnected", () => {
      if (this.peer === peer && !peer.destroyed) peer.reconnect();
    });
    peer.on("connection", (conn) => {
      if (this.conn && this.conn.open) {
        conn.on("open", () => {
          conn.send({ t: "full" });
          setTimeout(() => conn.close(), 500);
        });
        return;
      }
      this.conn = conn;
      conn.on("open", () => {
        conn.send({ t: "hello", game: romName, ctl: this.guestControl });
        this.call = peer.call(conn.peer, this.buildStream());
        setNetStatus("👥 Amigo conectado", "ok");
        toast("¡Tu amigo se ha unido!");
        heartbeat(conn, gone);
      });
      conn.on("data", (msg) => {
        if (msg && msg.t === "k" && msg.b in remote) {
          remote[msg.b] = msg.v ? 1 : 0;
          applyButton(msg.b);
        }
      });
      const gone = () => {
        if (this.conn !== conn) return;
        this.conn = null;
        if (this.call) this.call.close();
        this.call = null;
        remote.fill(0);
        for (let i = 0; i < 12; i++) applyButton(i);
        if (this.role === "host") {
          setNetStatus("Esperando amigo · " + this.code, "wait");
          toast("Tu amigo se ha desconectado");
        }
      };
      conn.on("close", gone);
      conn.on("error", gone);
    });
  },

  buildStream() {
    const canvas = emu().canvas;
    const stream = canvas.captureStream(60);
    const audio = gameAudioTrack();
    if (audio) stream.addTrack(audio);
    return stream;
  },

  join(code) {
    this.role = "guest";
    this.code = code;
    const peer = this.peer = this.newPeer();
    setNetStatus("Conectando…", "wait");
    screenMsg("Conectando con la partida " + code + "…");

    peer.on("open", () => {
      const conn = this.conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on("open", () => {
        setNetStatus("👥 Conectado", "ok");
        screenMsg("Esperando la imagen…");
      });
      conn.on("data", (msg) => {
        if (!msg) return;
        if (msg.t === "hello") {
          $("#game-title").textContent = "Partida de tu amigo · " + msg.game;
          if (!msg.ctl) toast("Tu amigo ha desactivado tus controles");
        } else if (msg.t === "ctl") {
          toast(msg.on ? "Ya puedes usar los controles" : "Tu amigo ha desactivado tus controles");
        } else if (msg.t === "full") {
          screenMsg("La partida ya tiene un invitado.");
        }
      });
      const gone = () => {
        setNetStatus("Desconectado", "bad");
        screenMsg("La partida ha terminado o se perdió la conexión.");
        $("#remote-video").hidden = true;
      };
      conn.on("close", gone);
      conn.on("open", () => heartbeat(conn, gone));
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
      setNetStatus("Error", "bad");
      screenMsg(err.type === "peer-unavailable"
        ? "No existe ninguna partida con el código " + code + ". Revisa el código."
        : "No se pudo conectar (" + (err.type || err.message) + ").");
    });
  },

  stop(silent) {
    if (this.call) this.call.close();
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
    this.peer = this.conn = this.call = null;
    remote.fill(0);
    for (let i = 0; i < 12; i++) applyButton(i);
    if (this.role === "host") {
      this.role = null;
      $("#mp-host").hidden = false;
      $("#mp-session").hidden = true;
      if (!silent) {
        setNetStatus("");
        toast("Multijugador terminado");
      }
    }
  },
};

// Al cerrar la app en el móvil la conexión no siempre avisa: se comprueba con pings.
function heartbeat(conn, onGone) {
  let lastSeen = Date.now();
  conn.on("data", () => (lastSeen = Date.now()));
  const timer = setInterval(() => {
    if (!conn.open || Date.now() - lastSeen > 8000) {
      clearInterval(timer);
      conn.close();
      onGone();
      return;
    }
    conn.send({ t: "ping" });
  }, 2000);
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function joinGame(code) {
  document.body.classList.add("guest");
  showView("console");
  $("#game-title").textContent = "Partida de tu amigo";
  history.replaceState(null, "", location.pathname);
  try {
    net.join(code);
  } catch (e) {
    screenMsg("No se pudo iniciar el multijugador: " + e.message);
  }
}

/* ---------- Inicio ---------- */

const params = new URLSearchParams(location.search);
const joinCode = (params.get("join") || "").trim().toUpperCase();
if (joinCode) joinGame(joinCode);
else renderRecent();
