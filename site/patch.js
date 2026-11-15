"use strict";

/* Parches de ROM (traducciones, mejoras y hacks): IPS, UPS y BPS.
 * applyPatch(rom, patch) → { data, format, warning }. UPS y BPS llevan la huella (CRC32) de la
 * ROM original: si no coincide, se avisa de que el parche es para otra versión del juego. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = 0; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, start + len));
const readU32 = (u8, p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;

function applyIPS(rom, patch) {
  let out = rom.slice();
  const grow = (size) => {
    if (size <= out.length) return;
    const bigger = new Uint8Array(size);
    bigger.set(out);
    out = bigger;
  };
  let p = 5;
  while (p + 3 <= patch.length) {
    if (ascii(patch, p, 3) === "EOF") {
      p += 3;
      if (p + 3 <= patch.length) out = out.slice(0, (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2]);
      return out;
    }
    const off = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2];
    const size = (patch[p + 3] << 8) | patch[p + 4];
    p += 5;
    if (size) {
      grow(off + size);
      out.set(patch.subarray(p, p + size), off);
      p += size;
    } else {
      const count = (patch[p] << 8) | patch[p + 1];
      grow(off + count);
      out.fill(patch[p + 2], off, off + count);
      p += 3;
    }
  }
  throw new Error("parche IPS incompleto");
}

function varint(patch, state) {
  let data = 0, shift = 1;
  for (;;) {
    const x = patch[state.p++];
    data += (x & 0x7f) * shift;
    if (x & 0x80) break;
    shift *= 128;
    data += shift;
  }
  return data;
}

function applyUPS(rom, patch) {
  const s = { p: 4 };
  const srcSize = varint(patch, s), dstSize = varint(patch, s);
  const srcCrc = readU32(patch, patch.length - 12);
  const warning = rom.length !== srcSize || crc32(rom) !== srcCrc;
  const out = new Uint8Array(dstSize);
  out.set(rom.subarray(0, Math.min(rom.length, dstSize)));
  let o = 0;
  const end = patch.length - 12;
  while (s.p < end) {
    o += varint(patch, s);
    for (;;) {
      const x = patch[s.p++];
      if (o < dstSize) out[o] = (o < rom.length ? rom[o] : 0) ^ x;
      o++;
      if (!x) break;
    }
  }
  return { data: out, warning };
}

function applyBPS(rom, patch) {
  const s = { p: 4 };
  const srcSize = varint(patch, s), dstSize = varint(patch, s), metaSize = varint(patch, s);
  s.p += metaSize;
  const srcCrc = readU32(patch, patch.length - 12);
  const warning = rom.length !== srcSize || crc32(rom) !== srcCrc;
  const out = new Uint8Array(dstSize);
  let o = 0, srcRel = 0, dstRel = 0;
  const end = patch.length - 12;
  while (s.p < end) {
    const d = varint(patch, s), cmd = d & 3, len = (d >> 2) + 1;
    if (cmd === 0) {            // SourceRead
      for (let i = 0; i < len; i++, o++) out[o] = rom[o] || 0;
    } else if (cmd === 1) {     // TargetRead
      out.set(patch.subarray(s.p, s.p + len), o);
      s.p += len;
      o += len;
    } else if (cmd === 2) {     // SourceCopy
      const r = varint(patch, s);
      srcRel += (r & 1 ? -1 : 1) * (r >> 1);
      for (let i = 0; i < len; i++) out[o++] = rom[srcRel++] || 0;
    } else {                    // TargetCopy
      const r = varint(patch, s);
      dstRel += (r & 1 ? -1 : 1) * (r >> 1);
      for (let i = 0; i < len; i++) out[o++] = out[dstRel++];
    }
  }
  return { data: out, warning };
}

function applyPatch(rom, patch) {
  const magic = ascii(patch, 0, 5);
  if (magic === "PATCH") return { data: applyIPS(rom, patch), format: "IPS", warning: false };
  if (magic.startsWith("UPS1")) return { ...applyUPS(rom, patch), format: "UPS" };
  if (magic.startsWith("BPS1")) return { ...applyBPS(rom, patch), format: "BPS" };
  throw new Error("formato de parche desconocido (se admiten .ips, .ups y .bps)");
}

window.RomPatch = { applyPatch, crc32 };
