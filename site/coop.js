"use strict";

/* Cooperativo compartido: cada jugador juega SU partida y se comparten los objetos y el progreso.
 * Basado en emu-coop 1.2, Copyright (C) 2017 Andi McClure (licencia MIT, ver README); los "modos" de cada juego son CC0, de
 * Andi McClure y megmacattack), pasado de Lua a JavaScript y con los nombres en español.
 * Se vigilan direcciones de la memoria del juego en cada fotograma; cuando cambian, se envían
 * al amigo, que las aplica con una regla ("high": el valor más alto; "bitOr": suma de bits;
 * "delta": sumar la diferencia; o una función propia). */

const AND = (a, b) => (a & b) >>> 0;
const OR = (a, b) => (a | b) >>> 0;
const XOR = (a, b) => (a ^ b) >>> 0;
const BIT = (n) => 1 << n;

/* ---------- Juegos ---------- */

// Zelda: A Link to the Past (los dos modos comparten casi todo).
const LTTP_ITEMS = {
  0x7EF340: { nameMap: ["el Arco", "el Arco", "las Flechas de plata", "las Flechas de plata"], kind: "high" },
  0x7EF341: { nameMap: ["el Bumerán", "el Bumerán mágico"], kind: "high" },
  0x7EF342: { name: "el Gancho", kind: "high" },
  0x7EF344: { nameMap: ["la Seta", "los Polvos mágicos"], kind: "high" },
  0x7EF345: { name: "la Vara de fuego", kind: "high" },
  0x7EF346: { name: "la Vara de hielo", kind: "high" },
  0x7EF347: { name: "el Medallón Bombos", kind: "high" },
  0x7EF348: { name: "el Medallón Éter", kind: "high" },
  0x7EF349: { name: "el Medallón Temblor", kind: "high" },
  0x7EF34A: { name: "la Lámpara", kind: "high" },
  0x7EF34B: { name: "el Martillo", kind: "high" },
  0x7EF34C: { nameMap: ["la Pala", "la Flauta", "el Pájaro"], kind: "high" },
  0x7EF34D: { name: "la Red", kind: "high" },
  0x7EF34E: { name: "el Libro de Mudora", kind: "high" },
  0x7EF34F: { kind: "high" },  // número de botellas
  0x7EF350: { name: "el Cetro de Somaria", kind: "high" },
  0x7EF351: { name: "el Cetro de Byrna", kind: "high" },
  0x7EF352: { name: "la Capa mágica", kind: "high" },
  0x7EF353: { name: "el Espejo mágico", kind: "high" },
  0x7EF354: { name: "los Guantes", kind: "high" },
  0x7EF355: { name: "las Botas de Pegaso", kind: "high" },
  0x7EF356: { name: "las Aletas de Zora", kind: "high" },
  0x7EF357: { name: "la Perla de la Luna", kind: "high" },
  0x7EF35A: { nameMap: ["el Escudo", "el Escudo de fuego", "el Escudo espejo"], kind: "high" },
  0x7EF35B: { nameMap: ["la Armadura azul", "la Armadura roja"], kind: "high" },
  0x7EF366: { name: "una Llave grande", kind: "bitOr" },
  0x7EF367: { name: "una Llave grande", kind: "bitOr" },
  0x7EF379: { kind: "bitOr" },  // habilidades
  0x7EF374: { name: "un Colgante", kind: "bitOr" },
  0x7EF37A: { name: "un Cristal", kind: "bitOr" },
  0x7EF37B: { name: "Media magia", kind: "high" },
};
const LTTP_SWORD = { nameMap: ["la Espada de luchador", "la Espada maestra", "la Espada templada", "la Espada dorada"], kind: "high" };
const LTTP_BOTTLE = { name: "una Botella", kind: "high", cond: (v) => v === 2 };  // solo botellas vacías nuevas

function lttpMode(id, name, title) {
  return {
    id, name, system: "snes",
    match: { addr: 0xFFC0, value: title },
    running: { addr: 0x7E0010, gte: 0x6, lte: 0x13 },
    sync: {
      ...LTTP_ITEMS,
      0x7EF359: { ...LTTP_SWORD, cond: (v) => v >= 1 && v <= 4 },  // evita el 0xFF de la misión del herrero
      0x7EF35C: LTTP_BOTTLE, 0x7EF35D: LTTP_BOTTLE, 0x7EF35E: LTTP_BOTTLE, 0x7EF35F: LTTP_BOTTLE,
      0x7EF3C9: { kind: "bitOr", mask: 0x20 },  // herrero rescatado (para la tienda de bombas)
    },
  };
}

// Randomizer de A Link to the Past.
const zeroRising = (v, prev) => [v !== 0 && prev === 0, v];
const zeroRisingOrFlute = (v, prev) => [(v !== 0 && prev === 0) || (v === 3 && prev === 2), v];
const LTTPR = {
  id: "lttp_rando", name: "Zelda: A Link to the Past Randomizer", system: "snes",
  match: { addr: 0xFFC0, value: "VT" },
  running: { addr: 0x7E0010, gte: 0x6, lte: 0x13 },
  sync: {
    ...LTTP_ITEMS,
    0x7EF38C: {
      nameBitmap: ["el Pájaro", "la Flauta", "la Pala", "un objeto", "los Polvos mágicos", "la Seta", "el Bumerán mágico", "el Bumerán"],
      kind: (v, prev) => {
        let r = OR(v, prev);
        if (AND(r, BIT(0))) r = AND(r, XOR(0xFF, BIT(1)));  // con el pájaro, fuera la flauta
        return [r !== prev, r];
      },
      receiveTrigger: (v, prev, m) => {
        const mush = 0x7EF344;
        if (AND(v, BIT(4)) && !AND(prev, BIT(4)) && !m.read(mush)) m.write(mush, 2);
        if (AND(v, BIT(5)) && !AND(prev, BIT(5)) && !m.read(mush)) m.write(mush, 1);
      },
    },
    0x7EF38E: { nameBitmap: ["un objeto", "un objeto", "un objeto", "un objeto", "un objeto", "un objeto", "las Flechas de plata", "el Arco"], kind: "bitOr" },
    0x7EF410: { nameBitmap: ["llevó al anciano a casa"], mask: 0x1, kind: "bitOr", verbOnly: true },
    0x7EF416: { kind: "high" },
    0x7EF340: { kind: zeroRising },
    0x7EF341: { kind: zeroRising },
    0x7EF344: undefined,
    0x7EF34C: { kind: zeroRisingOrFlute },
    0x7EF359: {
      ...LTTP_SWORD,
      cond: (v, size, m) => {
        if (v > 4) return false;
        const open = m.read(0x308032) > 0;
        return open ? v >= 1 : v >= 2;
      },
    },
    0x7EF35C: { name: "una Botella", kind: zeroRising }, 0x7EF35D: { name: "una Botella", kind: zeroRising },
    0x7EF35E: { name: "una Botella", kind: zeroRising }, 0x7EF35F: { name: "una Botella", kind: zeroRising },
  },
};
delete LTTPR.sync[0x7EF344];

// Super Metroid.
const difference = (a, b) => AND(a, XOR(b, 0xFF));
const missileTrigger = (target) => (v, prev, m) => m.write(target, (m.read(target, 2) + (v - prev)) & 0xFFFF, 2);
const itemTrigger = (target, mask) => (v, prev, m) => m.write(target, OR(m.read(target), AND(mask, difference(v, prev))));
const METROID = {
  id: "super_metroid", name: "Super Metroid", system: "snes",
  match: { addr: 0xFFC0, value: "Super Metroid" },
  running: { addr: 0x7E0998, gte: 0x8, lte: 0x18 },
  sync: {
    0x7E09C4: { name: "un Tanque de energía", kind: "high", size: 2, receiveTrigger: (v, prev, m) => m.write(0x7E09C2, v, 2) },
    0x7E09C8: { name: "una Ampliación de misiles", kind: "high", size: 2, receiveTrigger: missileTrigger(0x7E09C6) },
    0x7E09CC: { name: "Supermisiles", kind: "high", size: 2, receiveTrigger: missileTrigger(0x7E09CA) },
    0x7E09D0: { name: "Superbombas", kind: "high", size: 2, receiveTrigger: missileTrigger(0x7E09CE) },
    0x7E09D4: { name: "un Tanque de reserva", kind: "high", size: 2, receiveTrigger: missileTrigger(0x7E09C6) },
    0x7E09A4: { nameBitmap: ["el Traje Varia", "la Bola muelle", "la Morfosfera", "el Ataque giratorio", "un objeto", "el Traje de gravedad"],
      kind: "bitOr", mask: 0x2F, receiveTrigger: itemTrigger(0x7E09A2, 0x2F) },
    0x7E09A5: { nameBitmap: ["las Botas de salto", "el Salto espacial", "un objeto", "un objeto", "la Bomba", "el Turbo", "el Rayo enganche", "el Visor de rayos X"],
      kind: "bitOr", mask: 0xF3, receiveTrigger: itemTrigger(0x7E09A3, 0xF3) },
    0x7E09A8: { nameBitmap: ["el Rayo de onda", "el Rayo de hielo", "el Rayo Spazer", "el Rayo de plasma"], kind: "bitOr", mask: 0x0F,
      receiveTrigger: (v, prev, m) => {
        const t = 0x7E09A6, rising = AND(0x0F, difference(v, prev));
        let r = OR(m.read(t), rising);
        if (AND(rising, 0x08)) r = AND(r, XOR(0xFF, 0x04));        // plasma y spazer nunca a la vez
        else if (AND(rising, 0x04)) r = AND(r, XOR(0xFF, 0x08));
        m.write(t, r);
      } },
    0x7E09A9: { nameBitmap: ["un rayo", "un rayo", "un rayo", "un rayo", "el Rayo de carga"], kind: "bitOr", mask: 0x10, receiveTrigger: itemTrigger(0x7E09A7, 0x10) },
    0x7ED829: { nameBitmap: ["a Kraid"], verb: "derrotó", kind: "bitOr", mask: 0x1 },
    0x7ED82A: { nameBitmap: ["a Ridley"], verb: "derrotó", kind: "bitOr", mask: 0x1 },
    0x7ED82B: { nameBitmap: ["a Phantoon"], verb: "derrotó", kind: "bitOr", mask: 0x1 },
    0x7ED82C: { nameBitmap: ["a Draygon"], verb: "derrotó", kind: "bitOr", mask: 0x1 },
    0x7ED820: { nameBitmap: ["despertó al planeta"], kind: "bitOr", mask: 0x01, verbOnly: true },
  },
};

// The Legend of Zelda (NES): objetos, mapas, brújulas y trozos de Trifuerza.
const TLOZ = {
  id: "tloz_progress", name: "The Legend of Zelda (objetos y progreso)", system: "nes",
  match: { addr: 0xFFEB, value: "ZELDA" },
  running: { addr: 0x12, gte: 0x4, lte: 0xD },
  sync: {
    0x0657: { nameMap: ["la Espada de madera", "la Espada blanca", "la Espada mágica"], kind: "high" },
    0x0659: { nameMap: ["la Flecha", "la Flecha de plata"], kind: "high" },
    0x065B: { nameMap: ["la Vela azul", "la Vela roja"], kind: "high" },
    0x0662: { nameMap: ["el Anillo azul", "el Anillo rojo"], kind: "high" },
    0x065A: { name: "el Arco", kind: "high" },
    0x065C: { name: "la Flauta", kind: "high" },
    0x065F: { name: "la Vara mágica", kind: "high" },
    0x0660: { name: "la Balsa", kind: "high" },
    0x0661: { name: "el Libro mágico", kind: "high" },
    0x0663: { name: "la Escalera", kind: "high" },
    0x0664: { name: "la Llave mágica", kind: "high" },
    0x0665: { name: "el Brazalete de fuerza", kind: "high" },
    0x0666: { name: "la Carta", kind: "high" },
    0x0674: { name: "el Bumerán", kind: "high" },
    0x0675: { name: "el Bumerán mágico", kind: "high" },
    0x0676: { name: "el Escudo mágico", kind: "high" },
    0x0667: { nameBitmap: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `la Brújula del nivel ${n}`), kind: "bitOr" },
    0x0668: { nameBitmap: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `el Mapa del nivel ${n}`), kind: "bitOr" },
    0x0669: { name: "la Brújula del nivel 9", kind: "high" },
    0x066A: { name: "el Mapa del nivel 9", kind: "high" },
    0x0671: { nameBitmap: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `el ${n}º trozo de la Trifuerza`), kind: "bitOr" },
    0x0672: { name: "la Trifuerza del Poder", kind: "high" },
  },
};

const COOP_MODES = [
  lttpMode("lttp_jp", "Zelda: A Link to the Past (japonés 1.0)", "ZELDANODENSETSU"),
  lttpMode("lttp_us", "Zelda: A Link to the Past (americano)", "THE LEGEND OF ZELDA"),
  LTTPR,
  METROID,
  TLOZ,
];

/* ---------- Motor de sincronización ---------- */

class CoopSync {
  // mem: { read(addr, size), write(addr, value, size), romString(addr, len) }
  constructor(mode, mem, send, notify) {
    this.mode = mode;
    this.mem = mem;
    this.send = send;        // (objeto) => void
    this.notify = notify;    // (texto) => void
    this.cache = new Map();
    this.started = false;
    this.queue = [];
  }

  static detect(system, mem) {
    return COOP_MODES.find((m) => m.system === system && mem.romString(m.match.addr, m.match.value.length) === m.match.value) || null;
  }

  running() {
    const r = this.mode.running;
    if (!r) return true;
    const v = this.mem.read(r.addr, r.size || 1);
    return v >= r.gte && v <= r.lte;
  }

  // Lo que hace emu-coop en recordChanged(): decide si se envía o se acepta, y con qué valor.
  decide(rec, value, prev, receiving) {
    if (rec.kind === "trigger") return [false, value];
    const size = rec.size || 1;
    const full = size === 2 ? 0xFFFF : size === 4 ? 0xFFFFFFFF : 0xFF;
    const mask = rec.mask !== undefined ? rec.mask : full;
    const inv = rec.mask !== undefined ? AND(~rec.mask, full) : 0;
    const masked = rec.mask !== undefined ? OR(AND(mask, value), AND(inv, prev)) : value;
    let allow = true;
    if (typeof rec.kind === "function") {
      const [a, v] = rec.kind(value, prev, receiving);
      allow = a;
      value = v === undefined ? value : v;
    } else if (rec.kind === "high") {
      // "Quedarse con el más alto" (el original comparaba AND(masked, value) con AND(masked, prev),
      // lo que a veces dejaba bajar un objeto, p. ej. espada 2 → 1).
      allow = AND(mask, masked) > AND(mask, prev);
      value = masked;
    } else if (rec.kind === "bitOr") {
      allow = masked !== prev;
      if (receiving) value = OR(masked, prev);
    } else if (rec.kind === "delta") {
      if (!receiving) {
        allow = masked !== prev;
        value = AND(mask, value) - AND(mask, prev);
      } else {
        allow = value !== 0;
        let sum = prev + value;
        if (rec.deltaMin !== undefined && sum < rec.deltaMin) sum = rec.deltaMin;
        if (rec.deltaMax !== undefined && sum > rec.deltaMax) sum = rec.deltaMax;
        value = OR(AND(inv, prev), AND(mask, sum));
      }
    } else {
      allow = masked !== prev;
      value = masked;
    }
    if (allow && rec.cond) allow = rec.cond(masked, size, this.mem);
    return [allow, value];
  }

  // Primer fotograma "en juego": se guarda lo que hay y se manda todo lo que ya tienes, para
  // que al conectar los dos queden igual (las reglas no dejan perder nada).
  first() {
    if (this.started) return;
    this.started = true;
    for (const [addr, rec] of Object.entries(this.mode.sync)) {
      const a = Number(addr), v = this.mem.read(a, rec.size || 1);
      this.cache.set(a, v);
      if (v !== 0 && rec.kind !== "delta" && rec.kind !== "trigger") this.send({ t: "coop", addr: a, value: v });
    }
    this.notify("🤝 Cooperativo compartido activado");
  }

  // En cada fotograma: ¿ha cambiado algo vigilado?
  tick() {
    if (!this.running()) return;
    this.first();
    if (this.queue.length) for (const m of this.queue.splice(0)) this.receive(m);
    for (const [addr, rec] of Object.entries(this.mode.sync)) {
      const a = Number(addr), size = rec.size || 1;
      const v = this.mem.read(a, size), prev = this.cache.get(a);
      if (v === prev) continue;
      const [allow, sendValue] = this.decide(rec, v, prev, false);
      if (allow) {
        this.cache.set(a, v);
        this.send({ t: "coop", addr: a, value: sendValue });
      }
    }
  }

  receive(m) {
    if (!this.running()) { this.queue.push(m); return; }
    this.first();
    const rec = this.mode.sync[m.addr];
    if (!rec) return;
    const size = rec.size || 1;
    const prev = this.mem.read(m.addr, size);
    const [allow, value] = this.decide(rec, m.value, prev, true);
    if (rec.receiveTrigger && (allow || rec.kind === "trigger")) rec.receiveTrigger(value, prev, this.mem);
    if (!allow) return;
    const names = [];
    if (rec.name) names.push(rec.name);
    else if (rec.nameMap && rec.nameMap[value - 1]) names.push(rec.nameMap[value - 1]);
    else if (rec.nameBitmap) for (let b = 0; b < 8; b++) if (AND(BIT(b), value) && !AND(BIT(b), prev) && rec.nameBitmap[b]) names.push(rec.nameBitmap[b]);
    for (const n of names) this.notify(rec.verbOnly ? `🤝 Tu amigo ${n}` : `🤝 Tu amigo ${rec.verb || "consiguió"} ${n}`);
    this.mem.write(m.addr, value, size);
    this.cache.set(m.addr, value);   // lo recibido no se vuelve a enviar
  }
}

window.Coop = { COOP_MODES, CoopSync };
