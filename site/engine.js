"use strict";

/* Motor: ejecuta el núcleo (gpSP para GBA, snes9x para Super Nintendo) en WebAssembly
 * y se encarga de imagen, sonido y ritmo. */

class GbaEngine {
  static async create(wasmUrl, canvas, system = "gba") {
    const engine = new GbaEngine(canvas);
    engine.system = system;
    await engine.instantiate(wasmUrl);
    return engine;
  }

  constructor(canvas) {
    this.canvas = canvas;
    try {
      this.renderer = new GbaRenderer(canvas);
    } catch (e) {
      // Si los filtros no funcionan en este dispositivo, se dibuja sin ellos en un lienzo nuevo.
      console.warn("WebGL no disponible, se usa el dibujo 2D", e);
      const fresh = canvas.cloneNode();
      canvas.replaceWith(fresh);
      this.canvas = fresh;
      this.renderer = new GbaRenderer(fresh, true);
    }
    this.w = 240;
    this.h = 160;
    this.rgba = new Uint8ClampedArray(240 * 160 * 4);
    this.pixels = new Uint32Array(this.rgba.buffer);
    this.palette = new Uint32Array(65536);
    for (let c = 0; c < 65536; c++) {
      const r = ((c >> 11) & 31) * 255 / 31, g = ((c >> 5) & 63) * 255 / 63, b = (c & 31) * 255 / 31;
      this.palette[c] = 0xff000000 | (b << 16) | (g << 8) | r;
    }
    this.buttons = 0;
    this.buttons2 = 0;       // segundo mando (Super Nintendo)
    this.lockstep = null;    // () => [mando1, mando2] | null (juego online sincronizado)
    this.frame = 0;
    this.running = false;
    this.speed = 1;          // 1 = normal; 2, 3, 4, 8 = avance rápido
    this.muted = false;
    this.netQueue = [];      // paquetes recibidos: { client, data }
    this.onNetSend = null;   // (Uint8Array, clientId) => void
    this.onFrame = null;
  }

  async instantiate(url) {
    const decoder = new TextDecoder();
    const env = {
      js_log: (p, n) => console.log("[gpSP]", decoder.decode(this.bytes(p, n)).trim()),
      js_now_ms: () => Date.now(),
      js_tz_offset_min: () => new Date().getTimezoneOffset(),
      js_net_send: (p, n, client) => {
        if (this.onNetSend) this.onNetSend(this.bytes(p, n).slice(), client);
      },
      js_net_poll: () => this.deliverPackets(),
    };
    const response = await fetch(url);
    if (!response.ok) throw new Error("No se pudo descargar el núcleo (" + response.status + ")");
    let result;
    if (WebAssembly.instantiateStreaming) {
      try {
        result = await WebAssembly.instantiateStreaming(response.clone(), { env });
      } catch (e) {
        result = null;
      }
    }
    if (!result) result = await WebAssembly.instantiate(await response.arrayBuffer(), { env });
    this.ex = result.instance.exports;
    this.ex.fe_init();
  }

  bytes(ptr, len) {
    return new Uint8Array(this.ex.memory.buffer, ptr, len);
  }

  copyIn(data) {
    const ptr = this.ex.fe_malloc(data.length || 1);
    this.bytes(ptr, data.length).set(data);
    return ptr;
  }

  cstr(s) {
    return this.copyIn(new TextEncoder().encode(s + "\0"));
  }

  registerFile(path, data) {
    this.ex.fe_register_file(this.cstr(path), this.copyIn(data), data.length);
  }

  load(rom, bios) {
    if (this.system === "snes") {
      const ptr = this.copyIn(rom); // el núcleo usa la ROM directamente desde la memoria
      if (!this.ex.fe_load_mem(ptr, rom.length)) return false;
      this.fps = this.ex.fe_fps();
      this.sampleRate = this.ex.fe_sample_rate();
      return true;
    }
    if (bios) this.registerFile("/sys/gba_bios.bin", bios);
    this.registerFile("/rom.gba", rom);
    if (!this.ex.fe_load(this.cstr("/rom.gba"))) return false;
    this.fps = this.ex.fe_fps();
    this.sampleRate = this.ex.fe_sample_rate();
    return true;
  }

  /* ---------- Bucle principal ---------- */

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.debt = 0;
    const tick = (now) => {
      if (!this.running) return;
      // El ritmo depende del tiempo real, no de los Hz de la pantalla (60 o 120 en iPhone).
      const speed = this.speed;
      this.debt += Math.min(now - this.last, 100) * this.fps * speed / 1000;
      this.last = now;
      if (speed === 1) {
        // Ajuste fino con el búfer de audio para que no se corte el sonido.
        const level = this.audioLevel();
        if (level > 0.75) this.debt -= 0.25;
        else if (level < 0.2 && this.audioOn) this.debt += 0.25;
      }
      const frames = Math.min(Math.floor(this.debt), 4 * speed);
      // Si el móvil no llega a la velocidad pedida, va lo más rápido que puede sin acumular retraso.
      this.debt = Math.min(this.debt - frames, 4 * speed);
      for (let i = 0; i < frames; i++) {
        if (!this.runFrame(i === frames - 1)) {
          // Online: falta el mando de tu amigo para este fotograma; se espera sin acumular retraso.
          this.debt = Math.min(this.debt, 1);
          break;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
  }

  runFrame(draw) {
    if (this.onFrame) this.onFrame();
    if (this.lockstep) {
      const input = this.lockstep();
      if (!input) return false;
      this.ex.fe_set_buttons(input[0]);
      this.ex.fe_set_buttons2(input[1]);
    } else {
      this.deliverPackets();
      this.ex.fe_set_buttons(this.buttons);
      if (this.ex.fe_set_buttons2) this.ex.fe_set_buttons2(this.buttons2);
    }
    this.ex.fe_run();
    this.frame++;
    this.pushAudio();
    if (draw) this.draw();
    return true;
  }

  draw() {
    const w = this.ex.fe_width ? this.ex.fe_width() : 240;
    const h = this.ex.fe_height ? this.ex.fe_height() : 160;
    if (w !== this.w || h !== this.h || this.rgba.length !== w * h * 4) {
      this.w = w;
      this.h = h;
      this.rgba = new Uint8ClampedArray(w * h * 4);
      this.pixels = new Uint32Array(this.rgba.buffer);
      this.renderer.setSize(w, h);
    }
    const n = w * h;
    const fb = new Uint16Array(this.ex.memory.buffer, this.ex.fe_framebuffer(), n);
    const pal = this.palette, px = this.pixels;
    for (let i = 0; i < n; i++) px[i] = pal[fb[i]];
    this.renderer.draw(this.rgba);
  }

  // Huella de la memoria del juego: sirve para comprobar que las dos consolas van iguales.
  ramHash() {
    if (!this.ex.fe_ram_data) return 0;
    const ram = new Int32Array(this.ex.memory.buffer, this.ex.fe_ram_data(), this.ex.fe_ram_size() >> 2);
    let h = 0x811c9dc5;
    for (let i = 0; i < ram.length; i++) h = Math.imul(h ^ ram[i], 16777619);
    return h >>> 0;
  }

  // Captura sin filtros (para las portadas de la biblioteca).
  snapshot() {
    const c = this.snapCanvas || (this.snapCanvas = document.createElement("canvas"));
    const img = new ImageData(this.rgba.slice(), this.w, this.h);
    if (this.system !== "snes") {
      c.width = this.w;
      c.height = this.h;
      c.getContext("2d").putImageData(img, 0, 0);
      return c;
    }
    // Super Nintendo: se recorta a 3:2 para que encaje con las portadas.
    const tmp = Object.assign(document.createElement("canvas"), { width: this.w, height: this.h });
    tmp.getContext("2d").putImageData(img, 0, 0);
    c.width = 288;
    c.height = 192;
    const cropH = Math.round(this.h * 8 / 9); // se ve a 4:3; para 3:2 sobra 1/9 de alto
    const sy = Math.max(0, (this.h - cropH) / 2);
    c.getContext("2d").drawImage(tmp, 0, sy, this.w, cropH, 0, 0, 288, 192);
    return c;
  }

  // Brillo medio de la imagen (0–255): sirve para no guardar pantallas negras.
  brightness() {
    let sum = 0;
    for (let i = 0; i < this.rgba.length; i += 64) sum += this.rgba[i] + this.rgba[i + 1] + this.rgba[i + 2];
    return sum / (this.rgba.length / 64) / 3;
  }

  /* ---------- Sonido ---------- */

  initAudio() {
    if (this.audioCtx) return this.audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = this.audioCtx = new AC();
    this.ring = new Float32Array(16384 * 2);
    this.ringRead = 0;
    this.ringWrite = 0;
    this.resamplePos = 0;
    const node = ctx.createScriptProcessor(2048, 0, 2);
    node.onaudioprocess = (e) => this.fillAudio(e.outputBuffer);
    this.gain = ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : 1;
    node.connect(this.gain);
    this.gain.connect(ctx.destination);
    this.streamDest = ctx.createMediaStreamDestination ? ctx.createMediaStreamDestination() : null;
    if (this.streamDest) node.connect(this.streamDest);
    this.audioNode = node;
    this.audioOn = true;
    return ctx;
  }

  resumeAudio() {
    const ctx = this.initAudio();
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : 1;
  }

  ringFill() {
    const size = this.ring.length / 2;
    return (this.ringWrite - this.ringRead + size) % size;
  }

  audioLevel() {
    return this.ring ? this.ringFill() / (this.ring.length / 2) : 0.5;
  }

  pushAudio() {
    const frames = this.ex.fe_audio_frames();
    if (!this.ring || !frames || this.speed !== 1) return;
    const src = new Int16Array(this.ex.memory.buffer, this.ex.fe_audio(), frames * 2);
    const size = this.ring.length / 2;
    for (let i = 0; i < frames; i++) {
      if (this.ringFill() >= size - 1) break;
      const w = this.ringWrite * 2;
      this.ring[w] = src[i * 2] / 32768;
      this.ring[w + 1] = src[i * 2 + 1] / 32768;
      this.ringWrite = (this.ringWrite + 1) % size;
    }
  }

  fillAudio(out) {
    const left = out.getChannelData(0), right = out.getChannelData(1);
    const step = this.sampleRate / this.audioCtx.sampleRate;
    const size = this.ring.length / 2;
    for (let i = 0; i < left.length; i++) {
      if (this.ringFill() < 2) {
        left[i] = right[i] = 0;
        continue;
      }
      const a = this.ringRead * 2, b = ((this.ringRead + 1) % size) * 2, t = this.resamplePos;
      left[i] = this.ring[a] + (this.ring[b] - this.ring[a]) * t;
      right[i] = this.ring[a + 1] + (this.ring[b + 1] - this.ring[a + 1]) * t;
      this.resamplePos += step;
      while (this.resamplePos >= 1) {
        this.resamplePos -= 1;
        this.ringRead = (this.ringRead + 1) % size;
      }
    }
  }

  /* ---------- Partidas ---------- */

  getSave() {
    const size = this.ex.fe_save_size();
    return size ? this.bytes(this.ex.fe_save_data(), size).slice() : null;
  }

  setSave(data) {
    const size = this.ex.fe_save_size();
    if (!size || !data) return;
    const dst = this.bytes(this.ex.fe_save_data(), size);
    dst.fill(0xff);
    dst.set(data.subarray(0, size));
  }

  saveState() {
    const size = this.ex.fe_state_size();
    const ptr = this.ex.fe_malloc(size);
    try {
      if (!this.ex.fe_state_save(ptr, size)) throw new Error("No se pudo guardar el estado");
      return this.bytes(ptr, size).slice();
    } finally {
      this.ex.fe_free(ptr);
    }
  }

  loadState(data) {
    const ptr = this.copyIn(data);
    try {
      if (!this.ex.fe_state_load(ptr, data.length)) throw new Error("Estado no válido");
    } finally {
      this.ex.fe_free(ptr);
    }
  }

  reset() {
    this.ex.fe_reset();
  }

  /* ---------- Adaptador inalámbrico (netpacket) ---------- */

  netStart(clientId) { this.netQueue.length = 0; if (this.ex.fe_net_start) this.ex.fe_net_start(clientId); }
  netStop() { this.netQueue.length = 0; if (this.ex.fe_net_stop) this.ex.fe_net_stop(); }
  netConnected(clientId) { return this.ex.fe_net_connected ? !!this.ex.fe_net_connected(clientId) : true; }
  netDisconnected(clientId) { if (this.ex.fe_net_disconnected) this.ex.fe_net_disconnected(clientId); }

  netReceive(clientId, data) {
    this.netQueue.push({ client: clientId, data });
  }

  deliverPackets() {
    if (!this.ex.fe_net_receive) return;
    while (this.netQueue.length) {
      const { client, data } = this.netQueue.shift();
      const ptr = this.copyIn(data);
      this.ex.fe_net_receive(ptr, data.length, client);
      this.ex.fe_free(ptr);
    }
  }
}

window.GbaEngine = GbaEngine;
