"use strict";

/* Dibuja la pantalla de la GBA con WebGL y filtros ("shaders").
 *   pixel → píxeles nítidos (sharp bilinear: bordes limpios aunque el tamaño no sea múltiplo exacto)
 *   hd    → suavizado de bordes: Scale2x (EPX) aplicado dos veces = x4, y luego escalado suave
 *   lcd   → rejilla de la pantalla LCD de la GBA
 *   crt   → televisor antiguo: líneas, curvatura y máscara de fósforo
 * Opción "colores GBA": corrige los colores como los mostraba la pantalla original.
 * Si WebGL no está disponible, se usa un lienzo 2D normal.
 */

const GBA_W = 240, GBA_H = 160;

const VERT = `
attribute vec2 a_pos;
uniform float u_flip;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, mix(a_pos.y * 0.5 + 0.5, 0.5 - a_pos.y * 0.5, u_flip));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const COMMON = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;      // tamaño de la textura de entrada (en texels)
uniform vec2 u_out;       // tamaño de salida (en píxeles)
uniform float u_cc;       // 1.0 = corrección de color GBA
vec3 gbaColor(vec3 c) {
  // Aproximación de la pantalla de la GBA (más oscura y con colores menos saturados).
  c = pow(c, vec3(2.4));
  c = mat3(0.82, 0.125, 0.195,
           0.24, 0.665, 0.075,
           -0.06, 0.21, 0.73) * c;
  return pow(max(c, 0.0) * 0.98, vec3(1.0 / 2.2));
}
vec3 finish(vec3 c) { return mix(c, gbaColor(c), u_cc * 0.5); }
`;

const FRAG = {
  // Nitidez sin dientes de sierra al escalar a tamaños no enteros.
  pixel: COMMON + `
void main() {
  vec2 texel = v_uv * u_size;
  vec2 scale = max(floor(u_out / u_size), 1.0);
  vec2 region = 0.5 - 0.5 / scale;
  vec2 d = fract(texel) - 0.5;
  vec2 f = (d - clamp(d, -region, region)) * scale + 0.5;
  vec2 uv = (floor(texel) + f) / u_size;
  gl_FragColor = vec4(finish(texture2D(u_tex, uv).rgb), 1.0);
}`,

  // Rejilla LCD: separa ligeramente cada píxel, como la pantalla real.
  lcd: COMMON + `
void main() {
  vec2 texel = v_uv * u_size;
  vec2 f = fract(texel);
  vec2 px = u_size / u_out;                 // tamaño de un píxel de salida en texels
  vec2 g = smoothstep(vec2(0.0), px * 1.2, f) * smoothstep(vec2(0.0), px * 1.2, 1.0 - f);
  vec3 c = texture2D(u_tex, (floor(texel) + 0.5) / u_size).rgb;
  float grid = mix(0.62, 1.0, g.x * g.y);
  c = finish(c) * grid * 1.08;
  gl_FragColor = vec4(c, 1.0);
}`,

  // Televisor CRT: curvatura, líneas de barrido, máscara RGB y viñeta.
  crt: COMMON + `
void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv *= 1.0 + vec2(0.035, 0.05) * dot(uv, uv) * 0.6;
  uv = uv * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 texel = uv * u_size;
  // Desenfoque horizontal suave, nítido en vertical.
  vec2 base = vec2(texel.x, floor(texel.y) + 0.5) / u_size;
  vec3 c = texture2D(u_tex, base).rgb;
  float y = fract(texel.y);
  float scan = mix(0.5, 1.0, pow(sin(y * 3.14159), 0.7));
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 mask = m < 1.0 ? vec3(1.0, 0.82, 0.82) : m < 2.0 ? vec3(0.82, 1.0, 0.82) : vec3(0.82, 0.82, 1.0);
  vec2 v = uv * (1.0 - uv.yx);
  float vig = clamp(pow(v.x * v.y * 18.0, 0.25), 0.0, 1.0);
  c = finish(c) * scan * mask * vig * 1.25;
  gl_FragColor = vec4(c, 1.0);
}`,

  // Escalado suave final para el modo HD (la textura ya viene a x4).
  smooth: COMMON + `
void main() {
  gl_FragColor = vec4(finish(texture2D(u_tex, v_uv).rgb), 1.0);
}`,

  // Scale2x / EPX: duplica la resolución redondeando las diagonales.
  epx: `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;
bool eq(vec3 a, vec3 b) { return dot(abs(a - b), vec3(1.0)) < 0.02; }
vec3 at(vec2 p) { return texture2D(u_tex, (p + 0.5) / u_size).rgb; }
void main() {
  vec2 o = floor(v_uv * u_size * 2.0);
  vec2 p = floor(o / 2.0);
  vec2 q = o - p * 2.0;                     // cuadrante: (0|1, 0|1)
  vec3 P = at(p);
  vec3 A = at(p + vec2(0.0, -1.0));         // arriba
  vec3 B = at(p + vec2(1.0, 0.0));          // derecha
  vec3 C = at(p + vec2(-1.0, 0.0));         // izquierda
  vec3 D = at(p + vec2(0.0, 1.0));          // abajo
  vec3 r = P;
  if (q.y < 0.5) {
    if (q.x < 0.5) { if (eq(C, A) && !eq(C, D) && !eq(A, B)) r = A; }
    else           { if (eq(A, B) && !eq(A, C) && !eq(B, D)) r = B; }
  } else {
    if (q.x < 0.5) { if (eq(D, C) && !eq(D, B) && !eq(C, A)) r = C; }
    else           { if (eq(B, D) && !eq(B, A) && !eq(D, C)) r = D; }
  }
  gl_FragColor = vec4(r, 1.0);
}`,
};

class GbaRenderer {
  constructor(canvas, force2d) {
    this.canvas = canvas;
    this.shader = "pixel";
    this.colorCorrection = false;
    const opts = { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false };
    const gl = this.gl = force2d ? null : canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
    if (!gl) {
      // Sin WebGL: lienzo 2D clásico a resolución nativa.
      canvas.width = GBA_W;
      canvas.height = GBA_H;
      this.ctx2d = canvas.getContext("2d");
      this.image = this.ctx2d.createImageData(GBA_W, GBA_H);
      return;
    }
    this.programs = {};
    for (const name of Object.keys(FRAG)) this.programs[name] = this.program(FRAG[name]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.source = this.texture(GBA_W, GBA_H);
    this.pass1 = this.target(GBA_W * 2, GBA_H * 2);
    this.pass2 = this.target(GBA_W * 4, GBA_H * 4);
    this.resize();
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener("resize", () => this.resize());
  }

  get webgl() {
    return !!this.gl;
  }

  program(fragSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = (n) => gl.getUniformLocation(p, n);
    return { p, pos: gl.getAttribLocation(p, "a_pos"), tex: loc("u_tex"), size: loc("u_size"), out: loc("u_out"), cc: loc("u_cc"), flip: loc("u_flip") };
  }

  texture(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  target(w, h) {
    const gl = this.gl;
    const tex = this.texture(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  resize() {
    if (!this.gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(GBA_W, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(GBA_H, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      if (this.lastPixels) this.draw(this.lastPixels);
    }
  }

  setShader(name) {
    if (FRAG[name] && name !== "epx" && name !== "smooth") this.shader = name;
    else if (name === "hd") this.shader = "hd";
    if (this.lastPixels) this.draw(this.lastPixels);
  }

  setColorCorrection(on) {
    this.colorCorrection = !!on;
    if (this.lastPixels) this.draw(this.lastPixels);
  }

  pass(prog, tex, size, out, fb, viewport, flip) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, viewport[0], viewport[1]);
    gl.useProgram(prog.p);
    gl.enableVertexAttribArray(prog.pos);
    gl.vertexAttribPointer(prog.pos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.tex, 0);
    gl.uniform2f(prog.size, size[0], size[1]);
    if (prog.out) gl.uniform2f(prog.out, out[0], out[1]);
    if (prog.cc) gl.uniform1f(prog.cc, this.colorCorrection ? 1 : 0);
    gl.uniform1f(prog.flip, flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /* pixels: Uint8ClampedArray RGBA de 240×160 */
  draw(pixels) {
    this.lastPixels = pixels;
    if (!this.gl) {
      this.image.data.set(pixels);
      this.ctx2d.putImageData(this.image, 0, 0);
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GBA_W, GBA_H, gl.RGBA, gl.UNSIGNED_BYTE,
      pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length));
    const W = this.canvas.width, H = this.canvas.height;
    if (this.shader === "hd") {
      this.pass(this.programs.epx, this.source, [GBA_W, GBA_H], null, this.pass1.fb, [this.pass1.w, this.pass1.h], false);
      this.pass(this.programs.epx, this.pass1.tex, [this.pass1.w, this.pass1.h], null, this.pass2.fb, [this.pass2.w, this.pass2.h], false);
      this.pass(this.programs.smooth, this.pass2.tex, [this.pass2.w, this.pass2.h], [W, H], null, [W, H], true);
    } else {
      this.pass(this.programs[this.shader], this.source, [GBA_W, GBA_H], [W, H], null, [W, H], true);
    }
  }
}

window.GbaRenderer = GbaRenderer;
