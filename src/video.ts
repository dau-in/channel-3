import { NES_WIDTH, NES_HEIGHT } from "./emulator";

export interface CrtParams {
  enabled: boolean;
  curvature: number; // 0..1
  scanline: number; // 0..1
  mask: number; // 0..1
  glow: number; // 0..1
  aberration: number; // 0..1
  vignette: number; // 0..1
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // Flip Y: framebuffer row 0 is the top scanline, GL's v axis points up.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Real TVs hid ~8px of overscan on EVERY edge: rows top/bottom AND the side
// columns many games leave black/garbled (scroll masking). We crop to the
// 240x224 safe area — that's what makes the picture reach the bezel edge.
const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_outSize;
uniform float u_time;
uniform float u_enabled;
uniform float u_curvature;
uniform float u_scanline;
uniform float u_mask;
uniform float u_glow;
uniform float u_aberration;
uniform float u_vignette;
uniform float u_power;
uniform float u_vhs;
uniform float u_epx;

const float SRC_H = 240.0;
const float CROP = 8.0;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 cropUV(vec2 uv) {
  return vec2(
    (CROP + uv.x * (256.0 - 2.0 * CROP)) / 256.0,
    (CROP + uv.y * (SRC_H - 2.0 * CROP)) / SRC_H
  );
}

vec2 warp(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 sq = uv * uv;
  uv *= vec2(1.0 + sq.y * u_curvature * 0.22, 1.0 + sq.x * u_curvature * 0.28);
  return uv * 0.5 + 0.5;
}

vec3 sampleCRT(vec2 uv) {
  vec2 suv = cropUV(uv);
  if (u_aberration < 0.01) return texture2D(u_tex, suv).rgb; // 1 read, not 3
  vec2 texel = vec2(1.0 / 256.0, 1.0 / SRC_H);
  vec2 dir = uv * 2.0 - 1.0;
  vec2 ab = dir * u_aberration * 1.5 * texel;
  float r = texture2D(u_tex, suv + ab).r;
  float g = texture2D(u_tex, suv).g;
  float b = texture2D(u_tex, suv - ab).b;
  return vec3(r, g, b);
}

// EPX / Scale2x: the classic 90s emulator upscaling filter. Each source
// pixel splits into quadrants that copy a neighbour when the surrounding
// edges agree — smooths diagonals while keeping hard pixel art edges.
bool eq(vec3 a, vec3 b) {
  return dot(abs(a - b), vec3(1.0)) < 0.05;
}
vec3 sampleEPX(vec2 uv) {
  vec2 suv = cropUV(uv);
  vec2 px = vec2(256.0, SRC_H);
  vec2 f = fract(suv * px);
  vec2 base = (floor(suv * px) + 0.5) / px;
  vec2 o = 1.0 / px;
  vec3 P = texture2D(u_tex, base).rgb;
  vec3 A = texture2D(u_tex, base - vec2(0.0, o.y)).rgb; // above
  vec3 B = texture2D(u_tex, base + vec2(o.x, 0.0)).rgb; // right
  vec3 C = texture2D(u_tex, base - vec2(o.x, 0.0)).rgb; // left
  vec3 D = texture2D(u_tex, base + vec2(0.0, o.y)).rgb; // below
  if (eq(C, A) && !eq(C, D) && !eq(A, B) && f.x < 0.5 && f.y < 0.5) return A;
  if (eq(A, B) && !eq(A, C) && !eq(B, D) && f.x >= 0.5 && f.y < 0.5) return B;
  if (eq(D, C) && !eq(D, B) && !eq(C, A) && f.x < 0.5 && f.y >= 0.5) return C;
  if (eq(B, D) && !eq(B, A) && !eq(D, C) && f.x >= 0.5 && f.y >= 0.5) return D;
  return P;
}

void main() {
  if (u_enabled < 0.5) {
    vec3 raw = u_epx > 0.5 ? sampleEPX(v_uv) : texture2D(u_tex, cropUV(v_uv)).rgb;
    gl_FragColor = vec4(raw, 1.0);
    return;
  }

  vec2 uv = warp(v_uv);

  // CRT power on/off: the picture opens from a bright horizontal line.
  float flash = 1.0;
  if (u_power < 1.0) {
    float p = clamp(u_power, 0.0, 1.0);
    float openY = smoothstep(0.0, 0.75, p);
    float openX = smoothstep(0.0, 0.25, p);
    uv = (uv - 0.5) / vec2(max(openX, 0.001), max(openY, 0.002)) + 0.5;
    flash = 1.0 + (1.0 - p) * 5.0;
  }

  // VHS rewind: per-row jitter + a rolling tracking band.
  if (u_vhs > 0.0) {
    float band = smoothstep(0.94, 1.0, fract(uv.y * 2.0 - u_time * 1.7));
    uv.x += u_vhs * (sin(uv.y * 130.0 + u_time * 32.0) * 0.003 + band * 0.02 * sin(u_time * 47.0));
  }

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 color = u_epx > 0.5 ? sampleEPX(uv) : sampleCRT(uv);

  // VHS speckle noise on top of the distorted image.
  if (u_vhs > 0.0) {
    float n = hash(uv * 251.0 + fract(u_time) * 97.0);
    color = mix(color, vec3(n), 0.15 * u_vhs);
    color *= 1.0 + 0.1 * u_vhs;
  }

  // Phosphor glow: a cheap 2-tap horizontal bloom (authentic to CRT beam
  // smear) — half the texture reads of the old 4-tap, and skipped when off.
  vec2 texel = vec2(1.0 / 256.0, 1.0 / SRC_H);
  if (u_glow > 0.01) {
    vec3 blur = texture2D(u_tex, cropUV(uv + vec2(texel.x, 0.0) * 1.6)).rgb
              + texture2D(u_tex, cropUV(uv - vec2(texel.x, 0.0) * 1.6)).rgb;
    color += blur * 0.5 * u_glow * 0.6;
  }

  // Scanlines: darken exactly ONE backing row per game row. The old cosine
  // pattern cancelled to a flat dim at even scales (2x monitors showed no
  // lines at all); this stepped version is visible at every scale.
  float kRows = max(u_outSize.y / (SRC_H - 16.0), 1.0);
  float sub = fract(uv.y * (SRC_H - 16.0));
  float line = step(1.0 - 1.0 / kRows, sub);
  float scan = 1.0 - u_scanline * 0.6 * line;
  color *= scan;

  // Aperture grille tied to output pixels.
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 grille = vec3(0.55);
  if (m < 1.0) grille.r = 1.0;
  else if (m < 2.0) grille.g = 1.0;
  else grille.b = 1.0;
  color *= mix(vec3(1.0), grille, u_mask * 0.7);

  // Vignette + corner falloff.
  vec2 d = uv * 2.0 - 1.0;
  float vig = 1.0 - dot(d, d) * 0.25 * u_vignette;
  color *= vig;

  // Subtle brightness compensation so effects don't dim the image too much.
  color *= 1.0 + 0.25 * (u_scanline + u_mask) * 0.5;

  // Faint flicker for life.
  color *= 1.0 + 0.008 * sin(u_time * 90.0);

  color *= flash;
  gl_FragColor = vec4(color, 1.0);
}
`;

export class Renderer {
  readonly params: CrtParams = {
    // OFF by default: the raw fast path (single texture read). CRT flavors
    // are opt-in presets that switch `enabled` on with their own params.
    enabled: false,
    curvature: 0,
    scanline: 0,
    mask: 0,
    glow: 0,
    aberration: 0,
    vignette: 0,
  };

  /** 0 = screen off, 1 = full picture; animate for CRT power on/off. */
  power = 1;
  /** 0..1 VHS-rewind distortion amount. */
  vhs = 0;
  /** Source scaling filter, independent of the CRT effect. */
  filter: "nearest" | "smooth" | "epx" = "nearest";
  /** Integer pixel scale (backing = 256k × 224k). Desktop snaps the CSS box
   *  to the same k (see fitScreen in main.ts) for a mathematically exact
   *  NEStation-style presentation; coarse devices keep a fluid 2×. */
  private scale = matchMedia("(pointer: coarse)").matches ? 2 : 3;

  setScale(k: number): void {
    this.scale = Math.max(1, Math.min(4, Math.round(k)));
  }

  private gl: WebGLRenderingContext;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private start = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;

    const program = this.buildProgram(VERT, FRAG);
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      NES_WIDTH,
      NES_HEIGHT,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    for (const name of [
      "u_tex",
      "u_outSize",
      "u_time",
      "u_enabled",
      "u_curvature",
      "u_scanline",
      "u_mask",
      "u_glow",
      "u_aberration",
      "u_vignette",
      "u_power",
      "u_vhs",
      "u_epx",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(this.uniforms.u_tex, 0);
  }

  /** Upload the latest framebuffer and draw with current CRT params. */
  render(rgba: Uint8Array): void {
    const { gl, canvas, params, uniforms } = this;

    // Cap the backing buffer: beyond ~960 rows the CRT effects gain nothing
    // visible and the per-fragment cost hurts integrated GPUs.
    // Fixed integer-scaled backing store: every scanline covers exactly
    // rowScale device rows, so the CRT patterns stay clean at any window size.
    const h = 224 * this.scale;
    const w = 240 * this.scale; // 240 visible columns after the side crop
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);

    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      NES_WIDTH,
      NES_HEIGHT,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    );

    gl.uniform2f(uniforms.u_outSize, w, h);
    gl.uniform1f(uniforms.u_time, (performance.now() - this.start) / 1000);
    gl.uniform1f(uniforms.u_enabled, params.enabled ? 1 : 0);
    gl.uniform1f(uniforms.u_curvature, params.curvature);
    gl.uniform1f(uniforms.u_scanline, params.scanline);
    gl.uniform1f(uniforms.u_mask, params.mask);
    gl.uniform1f(uniforms.u_glow, params.glow);
    gl.uniform1f(uniforms.u_aberration, params.aberration);
    gl.uniform1f(uniforms.u_vignette, params.vignette);
    gl.uniform1f(uniforms.u_power, this.power);
    gl.uniform1f(uniforms.u_vhs, this.vhs);
    gl.uniform1f(uniforms.u_epx, this.filter === "epx" ? 1 : 0);
    // "smooth" rides on the GPU's bilinear filtering
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      this.filter === "smooth" ? gl.LINEAR : gl.NEAREST,
    );

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private buildProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const { gl } = this;
    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error("Shader compile error: " + gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("Program link error: " + gl.getProgramInfoLog(program));
    }
    return program;
  }
}
