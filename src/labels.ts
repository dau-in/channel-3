import { NES_WIDTH, NES_HEIGHT } from "./emulator";
import type { RomEntry } from "./roms";
import { scanForLabel, SLICE } from "./labelScan";

/**
 * Cartridge label art, generated instead of hand-drawn: run the game headless,
 * tap START a few times to get PAST the menus, and photograph a random moment
 * of GAMEPLAY. Every label is a gameplay shot on purpose — one consistent
 * style across the whole shelf (title screens proved impossible to detect
 * reliably across arbitrary ROMs). Results are cached in localStorage, so this
 * costs once per browser; the HUD's LABEL button overrides any label manually.
 */

// v8: consistent random-gameplay shots
// v11: SUSTAINED-motion capture — one moving checkpoint can be a fade or
// scene cut (how title fade-ins sneaked in); two consecutive cannot.
const LABEL_VERSION = 11;
const key = (file: string) => `channel3-label${LABEL_VERSION}:${file}`;

export function cachedLabel(entry: RomEntry): string | null {
  return localStorage.getItem(key(entry.file));
}

/** Drop this entry's cached art. Callers must not spell the key themselves:
 *  removal was still pointing at the v1 key ten versions later, so every
 *  deleted cart left its label behind, eating the same localStorage budget
 *  save states need. */
export function forgetLabel(entry: RomEntry): void {
  localStorage.removeItem(key(entry.file));
}

/** Key prefixes written by superseded generators, for the boot-time sweep.
 *  v1 carried no number. Derived from LABEL_VERSION so bumping it can't
 *  leave the sweep behind again. */
export function staleLabelPrefixes(): string[] {
  const out = ["channel3-label:"];
  for (let v = 2; v < LABEL_VERSION; v++) out.push(`channel3-label${v}:`);
  return out;
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

/** How many labels to scan at once. Each is ~3000 emulated frames and takes
 *  seconds, so one at a time left the shelf showing placeholders for minutes.
 *  Leave a core for the page; phones report few and shouldn't cook. */
export const LABEL_CONCURRENCY = Math.max(
  1,
  Math.min(3, (navigator.hardwareConcurrency || 2) - 1),
);

const pool: Worker[] = [];
let workerUnavailable = false;
let nextJob = 1;
const jobs = new Map<number, (rgba: Uint8Array | null) => void>();

/** A Worker from the pool, or null if this browser refused to give us one. */
function labelWorker(i: number): Worker | null {
  if (workerUnavailable) return null;
  const slot = i % LABEL_CONCURRENCY;
  if (pool[slot]) return pool[slot];
  try {
    const w = new Worker(new URL("./labelWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; rgba?: Uint8Array; error?: string }>) => {
      const done = jobs.get(e.data.id);
      if (!done) return;
      jobs.delete(e.data.id);
      done(e.data.rgba ?? null);
    };
    // some mobile WebViews reject module workers outright; fall back for good
    w.onerror = () => {
      workerUnavailable = true;
      pool.length = 0;
      for (const done of jobs.values()) done(null);
      jobs.clear();
    };
    pool[slot] = w;
  } catch {
    workerUnavailable = true;
  }
  return pool[slot] ?? null;
}

function scanInWorker(romBytes: Uint8Array, slot: number): Promise<Uint8Array | null> {
  const w = labelWorker(slot);
  if (!w) return Promise.resolve(null);
  const id = nextJob++;
  const bytes = romBytes.slice(); // transferred; the caller keeps its copy
  return new Promise((resolve) => {
    jobs.set(id, resolve);
    try {
      w.postMessage({ id, bytes }, [bytes.buffer]);
    } catch {
      jobs.delete(id);
      resolve(null);
    }
  });
}

export async function generateLabel(
  entry: RomEntry,
  romBytes: Uint8Array,
  slot = 0,
): Promise<string> {
  const cached = cachedLabel(entry);
  if (cached) return cached;

  // Off-thread when we can; on-thread with yields when we can't.
  const shot = (await scanInWorker(romBytes, slot)) ?? (await scanForLabel(romBytes, SLICE));

  const url = toDataUrl(shot);
  try {
    localStorage.setItem(key(entry.file), url);
  } catch {
    /* cache full — regenerate next time */
  }
  return url;
}
