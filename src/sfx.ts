/**
 * UI sound effects synthesized APU-style (square waves, no assets).
 * Lazy AudioContext: first call after a user gesture wins.
 */

let ctx: AudioContext | null = null;
let volume = 1;

export function setSfxVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
}

/** Share the game's AudioContext so there's a single, gesture-unlocked
 *  context — two separate contexts is what left mobile game audio silent. */
export function setSfxContext(shared: AudioContext): void {
  ctx = shared;
}

function beep(
  freq: number,
  dur: number,
  when = 0,
  type: OscillatorType = "square",
  gain = 0.04,
  slideTo?: number,
): void {
  if (volume <= 0 || !ctx) return; // no context yet, or silenced
  if (ctx.state === "suspended") void ctx.resume();
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.linearRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain * volume, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  move(): void {
    beep(880, 0.05);
  },
  select(): void {
    beep(523, 0.07);
    beep(1046, 0.12, 0.07);
  },
  back(): void {
    beep(660, 0.06, 0, "square", 0.04, 330);
  },
  connect(): void {
    beep(523, 0.09);
    beep(659, 0.09, 0.09);
    beep(784, 0.09, 0.18);
    beep(1046, 0.2, 0.27);
  },
  error(): void {
    beep(220, 0.18, 0, "square", 0.05, 110);
  },
  insert(): void {
    beep(200, 0.05, 0, "square", 0.06);
    beep(140, 0.08, 0.06, "square", 0.06);
  },
};
