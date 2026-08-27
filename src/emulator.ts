import { NES } from "jsnes";

export const NES_WIDTH = 256;
export const NES_HEIGHT = 240;

/**
 * Headless jsnes wrapper. Owns the core, exposes the framebuffer as RGBA
 * bytes ready for texture upload, and applies controller state as a
 * bitmask byte (bit i = jsnes Controller button i) so the same code path
 * serves local play and netplay lockstep.
 */
export class Emulator {
  readonly rgba = new Uint8Array(NES_WIDTH * NES_HEIGHT * 4);
  private readonly rgba32 = new Uint32Array(this.rgba.buffer);
  private nes: NES;
  private romString: string | null = null;
  private prevPad: [number, number] = [0, 0];

  private audioRate: number;

  constructor(
    sampleRate: number,
    private onAudioSample: (l: number, r: number) => void,
  ) {
    this.audioRate = sampleRate;
    this.nes = this.makeNes(sampleRate);
    this.rgba32.fill(0xff000000);
  }

  private makeNes(sampleRate: number): NES {
    return new NES({
      sampleRate,
      onFrame: (fb) => {
        // jsnes emits 0x00BBGGRR ints; OR alpha and write through the
        // Uint32 view — little-endian gives us the RGBA byte order WebGL wants.
        for (let i = 0; i < fb.length; i++) {
          this.rgba32[i] = 0xff000000 | fb[i];
        }
      },
      onAudioSample: (l, r) => this.onAudioSample(l, r),
    });
  }

  /** Match the APU output rate to the real AudioContext rate. Rebuilds the
   *  core, so call it before a ROM is loaded — otherwise the emulator produces
   *  samples at a rate the device doesn't play back at, draining the audio
   *  buffer (crackle) while the pacing loop runs the picture too fast. */
  setSampleRate(rate: number): void {
    if (rate === this.audioRate || !rate) return;
    this.audioRate = rate;
    this.nes = this.makeNes(rate);
    if (this.romString) this.nes.loadROM(this.romString);
    this.prevPad = [0, 0];
  }

  loadROM(bytes: Uint8Array): void {
    let str = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      str += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    this.nes.loadROM(str);
    this.romString = str;
    this.prevPad = [0, 0];
  }

  /** Set full controller state for a player (1 or 2) from a bitmask byte. */
  setPad(player: 1 | 2, byte: number): void {
    const prev = this.prevPad[player - 1];
    if (prev === byte) return;
    for (let b = 0; b < 8; b++) {
      const now = (byte >> b) & 1;
      const was = (prev >> b) & 1;
      if (now && !was) this.nes.buttonDown(player, b);
      else if (!now && was) this.nes.buttonUp(player, b);
    }
    this.prevPad[player - 1] = byte;
  }

  frame(): void {
    this.nes.frame();
  }

  // jsnes' toJSON skips the APU entirely, so a restored game goes silent
  // until it happens to rewrite the sound registers. We snapshot the papu's
  // own primitive state (channels + frame counter) and put it back by hand.
  private apuState(): Record<string, Record<string, number | boolean>> {
    const papu = (this.nes as unknown as { papu: Record<string, unknown> }).papu;
    const grab = (o: unknown) => {
      const out: Record<string, number | boolean> = {};
      for (const k in o as Record<string, unknown>) {
        const v = (o as Record<string, unknown>)[k];
        if (typeof v === "number" || typeof v === "boolean") out[k] = v;
      }
      return out;
    };
    return {
      papu: grab(papu),
      square1: grab(papu.square1),
      square2: grab(papu.square2),
      triangle: grab(papu.triangle),
      noise: grab(papu.noise),
      dmc: grab(papu.dmc),
    };
  }

  private apuRestore(state: ReturnType<Emulator["apuState"]> | undefined): void {
    if (!state) return;
    const papu = (this.nes as unknown as { papu: Record<string, unknown> }).papu;
    Object.assign(papu, state.papu);
    Object.assign(papu.square1 as object, state.square1);
    Object.assign(papu.square2 as object, state.square2);
    Object.assign(papu.triangle as object, state.triangle);
    Object.assign(papu.noise as object, state.noise);
    Object.assign(papu.dmc as object, state.dmc);
  }

  snapshot(): unknown {
    // toJSON returns live array references in places; clone so the
    // snapshot is immune to further emulation. structuredClone took ~50 ms
    // on this state (the periodic frame-drop players felt as "cuts");
    // fastClone knows the shape (objects + flat number arrays) and takes ~4.
    return { core: fastClone(this.nes.toJSON()), apu: this.apuState() };
  }

  restore(snap: unknown): void {
    const s = snap as { core?: unknown; apu?: ReturnType<Emulator["apuState"]> };
    // Clone again so the core can't mutate a stored snapshot.
    if (s && typeof s === "object" && "core" in s) {
      this.nes.fromJSON(fastClone(s.core));
      this.apuRestore(fastClone(s.apu) as ReturnType<Emulator["apuState"]>);
    } else {
      this.nes.fromJSON(fastClone(snap)); // pre-APU snapshot format
    }
    // Regenerate video/audio for the restored state.
    this.nes.frame();
  }

  serialize(): string {
    return JSON.stringify({ core: this.nes.toJSON(), apu: this.apuState() });
  }

  deserialize(json: string): void {
    this.restore(JSON.parse(json));
  }
}

/** Deep-copy for jsnes state: plain objects and flat arrays of numbers.
 *  ~11x faster than structuredClone on this shape (measured), which is what
 *  makes 2 rewind snapshots per second affordable inside the frame budget. */
function fastClone<T>(v: T): T {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] === "object" && v[i] !== null) return v.map(fastClone) as unknown as T;
    }
    return v.slice() as unknown as T;
  }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k in v as Record<string, unknown>) o[k] = fastClone((v as Record<string, unknown>)[k]);
    return o as T;
  }
  return v;
}
