import { Emulator, NES_WIDTH, NES_HEIGHT } from "./emulator";
import { BTN } from "./input";
import type { RomEntry } from "./roms";

/**
 * Cartridge label art, generated instead of hand-drawn: run the game headless,
 * tap START a few times to get PAST the menus, and photograph a random moment
 * of GAMEPLAY. Every label is a gameplay shot on purpose — one consistent
 * style across the whole shelf (title screens proved impossible to detect
 * reliably across arbitrary ROMs). Results are cached in localStorage, so this
 * costs once per browser; the HUD's LABEL button overrides any label manually.
 */

const WARMUP = 200; // ignore boot/logo frames entirely
const SLICE = 30; // frames per macrotask so generation never janks the UI
const FIRST_TAP = 300; // unconditional: get off the title screen
// After that, we press again ONLY when the screen has sat still for a while
// (a moving screen is gameplay/attract — pressing START there PAUSES many
// games). Presses alternate START and A because menus differ per game.
const DULL = 12000; // score of a near-monochrome screen (blank/fade)

// v8: consistent random-gameplay shots
// v11: SUSTAINED-motion capture — one moving checkpoint can be a fade or
// scene cut (how title fade-ins sneaked in); two consecutive cannot.
const key = (file: string) => `channel3-label11:${file}`;

export function cachedLabel(entry: RomEntry): string | null {
  return localStorage.getItem(key(entry.file));
}

/** Color variety and brightness — black/blank frames score ~0. */
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

function toDataUrl(rgba: Uint8Array): string {
  const canvas = document.createElement("canvas");
  canvas.width = NES_WIDTH - 16;
  canvas.height = NES_HEIGHT - 16;
  const ctx = canvas.getContext("2d")!;
  const img = new ImageData(NES_WIDTH, NES_HEIGHT);
  img.data.set(rgba);
  ctx.putImageData(img, -8, -8); // crop 8px overscan all around, like the CRT
  return canvas.toDataURL("image/jpeg", 0.82);
}

/** Use an exact emulator frame as the cart label — the player's own pick,
 *  and the one deterministic way to get any exact shot on any ROM. */
export function storeLabel(entry: RomEntry, rgba: Uint8Array): string {
  const url = toDataUrl(rgba);
  try {
    localStorage.setItem(key(entry.file), url);
  } catch {
    /* cache full */
  }
  return url;
}

export async function generateLabel(
  entry: RomEntry,
  romBytes: Uint8Array,
): Promise<string> {
  const cached = cachedLabel(entry);
  if (cached) return cached;

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
    if (++sinceYield >= SLICE) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const shot = captured ?? lastMovingRich ?? lastRich ?? emu.rgba;
  const url = toDataUrl(shot);
  try {
    localStorage.setItem(key(entry.file), url);
  } catch {
    /* cache full — regenerate next time */
  }
  return url;
}
