/**
 * Low-latency audio out. jsnes pushes samples on the main thread; we batch
 * them into Float32Array chunks and post them to an AudioWorklet that plays
 * from a ring buffer, emitting silence on underrun (e.g. netplay stalls).
 */

// Kept as a plain-JS string and loaded via Blob URL so no extra build
// config is needed for the worklet file.
const WORKLET_SOURCE = `
class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.primed = false;
    this.primeTarget = 4096;   // ~85ms cushion before playback starts (mobile-safe)
    this.lastL = 0; this.lastR = 0;
    this.report = 0;
    this.port.onmessage = (e) => {
      const { l, r } = e.data;
      for (let i = 0; i < l.length; i++) {
        // full: drop the OLDEST sample so latency stays bounded and we keep
        // the freshest audio (better than dropping incoming samples)
        if (this.available >= this.capacity) {
          this.readPos = (this.readPos + 1) % this.capacity;
          this.available--;
        }
        this.left[this.writePos] = l[i];
        this.right[this.writePos] = r[i];
        this.writePos = (this.writePos + 1) % this.capacity;
        this.available++;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;

    // tell the main thread how full we are (throttled) so it can pace emulation
    this.report += n;
    if (this.report >= 480) { this.report = 0; this.port.postMessage(this.available); }

    // wait for a cushion before the first sample so startup doesn't crackle
    if (!this.primed) {
      if (this.available >= this.primeTarget) this.primed = true;
      else { outL.fill(0); if (outR !== outL) outR.fill(0); return true; }
    }

    for (let i = 0; i < n; i++) {
      if (this.available > 0) {
        this.lastL = this.left[this.readPos];
        this.lastR = this.right[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      } else {
        // underrun: decay the held sample toward zero instead of a hard click
        this.lastL *= 0.985; this.lastR *= 0.985;
      }
      outL[i] = this.lastL;
      outR[i] = this.lastR;
    }
    return true;
  }
}
registerProcessor("nes-audio", NesAudioProcessor);
`;

const CHUNK = 1024;
// Fixed rate so the emulator (built at load, before the context exists) and the
// AudioContext agree without resampling. Both 44100 and 48000 are universally
// supported; forcing one avoids a device-vs-emulator sample-rate mismatch.
const RATE = 44100;

const RING = 16384; // fallback ring-buffer capacity (samples per channel)

export class AudioPipe {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private spNode: ScriptProcessorNode | null = null; // fallback path
  private gainNode: GainNode | null = null;
  private volume = 1;
  private bufL = new Float32Array(CHUNK);
  private bufR = new Float32Array(CHUNK);
  private fill = 0;
  private buffered = 0; // ring-buffer level (from worklet, or our own ring)
  private ready = false;

  // main-thread ring for the ScriptProcessor fallback
  private ringL = new Float32Array(RING);
  private ringR = new Float32Array(RING);
  private rRead = 0;
  private rWrite = 0;
  private rAvail = 0;
  private primed = false;
  private lastL = 0;
  private lastR = 0;

  /** Create the context lazily — the first call must happen inside a user
   *  gesture, or mobile browsers leave it permanently silent. */
  get ctx(): AudioContext {
    if (!this.context) {
      try {
        this.context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
      } catch {
        // some devices reject a forced sampleRate — fall back to the default
        this.context = new AudioContext({ latencyHint: "interactive" });
      }
    }
    return this.context;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gainNode) this.gainNode.gain.value = this.volume;
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? RATE;
  }

  /** True once an output node exists and the context is actually running. */
  get active(): boolean {
    return this.ready && this.context?.state === "running";
  }

  get bufferedSamples(): number {
    return this.buffered;
  }

  get targetSamples(): number {
    return Math.round(this.sampleRate * 0.09); // ~90ms standing buffer
  }

  async init(): Promise<void> {
    if (this.ready) return;
    const ctx = this.ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.volume;
    this.gainNode.connect(ctx.destination);

    // Preferred path: AudioWorklet. It fails on some mobile WebViews (Blob-URL
    // modules), so fall back to a ScriptProcessorNode that plays from a
    // main-thread ring buffer — deprecated but supported everywhere.
    try {
      if (!ctx.audioWorklet) throw new Error("no AudioWorklet");
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(ctx, "nes-audio", { outputChannelCount: [2] });
      this.node.port.onmessage = (e) => {
        this.buffered = e.data as number;
      };
      this.node.connect(this.gainNode);
    } catch {
      this.initFallback(ctx);
    }
    this.ready = true;
  }

  private initFallback(ctx: AudioContext): void {
    const sp = ctx.createScriptProcessor(4096, 1, 2); // bigger = fewer main-thread-starved callbacks
    sp.onaudioprocess = (e) => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      const n = outL.length;
      this.buffered = this.rAvail;
      if (!this.primed) {
        if (this.rAvail >= 4096) this.primed = true;
        else { outL.fill(0); outR.fill(0); return; }
      }
      for (let i = 0; i < n; i++) {
        if (this.rAvail > 0) {
          this.lastL = this.ringL[this.rRead];
          this.lastR = this.ringR[this.rRead];
          this.rRead = (this.rRead + 1) % RING;
          this.rAvail--;
        } else {
          this.lastL *= 0.985;
          this.lastR *= 0.985;
        }
        outL[i] = this.lastL;
        outR[i] = this.lastR;
      }
    };
    sp.connect(this.gainNode!);
    this.spNode = sp;
  }

  /** Browsers require a user gesture before audio can start. */
  resume(): void {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  pushSample(l: number, r: number): void {
    if (this.spNode) {
      // fallback ring: drop the oldest sample on overflow to bound latency
      if (this.rAvail >= RING) {
        this.rRead = (this.rRead + 1) % RING;
        this.rAvail--;
      }
      this.ringL[this.rWrite] = l;
      this.ringR[this.rWrite] = r;
      this.rWrite = (this.rWrite + 1) % RING;
      this.rAvail++;
      return;
    }
    if (!this.node) return; // worklet not up yet
    this.bufL[this.fill] = l;
    this.bufR[this.fill] = r;
    if (++this.fill === CHUNK) this.flush();
  }

  flush(): void {
    if (this.fill === 0 || !this.node) return;
    const l = this.bufL.slice(0, this.fill);
    const r = this.bufR.slice(0, this.fill);
    this.node.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    this.fill = 0;
  }
}
