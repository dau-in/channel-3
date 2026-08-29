import { Emulator, NES_WIDTH, NES_HEIGHT } from "./emulator";
import { BTN } from "./input";

const WARMUP = 200; // ignore boot/logo frames entirely
export const SLICE = 30; // frames per macrotask so generation never janks the UI
const FIRST_TAP = 300; // unconditional: get off the title screen
const DULL = 12000; // score of a near-monochrome screen (blank/fade)
/**
 * The headless run that finds a label frame. Pure: no DOM, no canvas, no
 * storage — so it can run in a Worker (which is where it belongs, since it
 * emulates thousands of frames) and fall back to the main thread unchanged.
 *
 * `yieldEvery` is only for the fallback path: on the main thread the loop has
 * to hand time back or the gallery janks. In a Worker it stays 0 and the run
 * goes flat out, which is both kinder to the UI and faster overall.
 */
export async function scanForLabel(
  romBytes: Uint8Array,
  yieldEvery = 0,
): Promise<Uint8Array> {
  const emu = new Emulator(44100, () => {});
  emu.loadROM(romBytes);

  // a random capture point 15-25 s in: deep enough to be actual gameplay
  const target = 1300 + Math.floor(Math.random() * 500);
  const HARD = target + 1800; // patient ceiling: some games park on timed cards
  let lastRich: Uint8Array | null = null;
  let lastMovingRich: Uint8Array | null = null;
  let prevCheck: Uint8Array | null = null;
  let stillSince = 0;
  let tapToggle = false;
  let releaseAt = -1;
  let transitions = 0; // big scene cuts seen (logo→title→game…)
  let movingRun = 0; // consecutive moving checkpoints (sustained motion)
  let captured: Uint8Array | null = null;
  let frame = 0;
  let sinceYield = 0;

  const changeRatio = (a: Uint8Array, b: Uint8Array): number => {
    let changed = 0, n = 0;
    for (let i = 0; i < a.length; i += 4 * 13) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) changed++;
      n++;
    }
    return changed / n;
  };

  while (frame < HARD) {
    if (frame === FIRST_TAP) emu.setPad(1, BTN.START);
    if (frame === FIRST_TAP + 20 || frame === releaseAt) emu.setPad(1, 0);
    emu.frame();
    frame++;

    if (frame >= WARMUP && frame % 30 === 0) {
      const shot = emu.rgba;
      const score = scoreFrame(shot);
      // 12%: title-screen animations (running mascots, blinking text) stay
      // below this; real gameplay scrolling/action lands well above it.
      const delta = prevCheck !== null ? changeRatio(shot, prevCheck) : 0;
      const moving = delta > 0.12;
      movingRun = moving ? movingRun + 1 : 0;
      if (delta > 0.3) transitions++; // a hard cut between screens
      prevCheck = shot.slice();
      if (score > DULL) {
        lastRich = prevCheck;
        if (movingRun >= 2) lastMovingRich = prevCheck;
      }
      if (moving) stillSince = frame;
      // Stuck on a still screen (title/menu) for ~1.5 s past the first tap?
      // Nudge it — alternating START and A, since menus differ per game.
      // After ~2 hard cuts we are almost certainly IN the game — pressing
      // START there pauses many titles (how Nova ended up on its pause menu).
      if (transitions < 3 && frame > FIRST_TAP && frame < target && frame - stillSince >= 90) {
        emu.setPad(1, tapToggle ? 1 << 0 /* A */ : BTN.START);
        tapToggle = !tapToggle;
        releaseAt = frame + 20; // HOLD ~20 frames — short taps get missed by
        // games that poll input sparsely (verified frame-by-frame)
        stillSince = frame; // grace period before the next nudge
      }
      // From the target on: grab the FIRST rich, MOVING checkpoint — motion
      // is the gameplay guarantee (a parked title can never be captured).
      if (frame >= target && movingRun >= 2 && score > DULL) {
        captured = prevCheck;
        break;
      }
    }
    if (yieldEvery && ++sinceYield >= yieldEvery) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return captured ?? lastMovingRich ?? lastRich ?? emu.rgba;
}

function scoreFrame(rgba: Uint8Array): number {
  const colors = new Set<number>();
  let lum = 0;
  let lit = 0;
  const total = NES_WIDTH * NES_HEIGHT;
  for (let i = 0; i < total; i += 13) {
    const o = i * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    colors.add((r << 16) | (g << 8) | b);
    const l = r * 0.3 + g * 0.6 + b * 0.1;
    lum += l;
    if (l > 24) lit++;
  }
  const sampled = total / 13;
  return colors.size * 1000 + (lit / sampled) * 500 + lum / sampled;
}
