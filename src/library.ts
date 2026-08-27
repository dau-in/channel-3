// Persistent, browser-local library for ROMs the user adds themselves.
//
// Everything here lives only in the visitor's own browser (IndexedDB for the
// ROM binaries, localStorage for their saves). Nothing is ever uploaded or
// redistributed — this is the same posture as any desktop emulator opening a
// local file, which is what keeps the feature clean legally.

const DB_NAME = "channel3";
const DB_VERSION = 1;
const STORE = "roms";

export interface UserRom {
  hash: string; // sha-256 hex — primary key and stable identity for saves
  name: string; // original file name
  title?: string; // resolved display title (from the NES DB, if catalogued)
  author?: string; // developer/publisher, if catalogued
  year?: number; // release year, if catalogued
  bytes: Uint8Array;
  addedAt: number;
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "hash" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Content hash — dedup key. Falls back to a JS hash if SubtleCrypto is
 *  unavailable (e.g. served over plain http on a LAN address). */
export async function hashRom(bytes: Uint8Array): Promise<string> {
  if (crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // FNV-1a fallback — weaker, but still content-derived so dedup holds.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return "fnv" + (h >>> 0).toString(16).padStart(8, "0") + "-" + bytes.length.toString(16);
}

/** Store a ROM. If its hash already exists, nothing is written and
 *  `dup` is true (this is what enforces "no re-adding until removed"). */
export async function addUserRom(
  name: string,
  bytes: Uint8Array,
  info?: { title?: string; author?: string; year?: number },
): Promise<{ rom: UserRom; dup: boolean }> {
  const hash = await hashRom(bytes);
  const existing = await getUserRom(hash);
  if (existing) return { rom: existing, dup: true };
  const rom: UserRom = { hash, name, ...info, bytes, addedAt: Date.now() };
  const d = await db();
  await wrap(d.transaction(STORE, "readwrite").objectStore(STORE).add(rom));
  return { rom, dup: false };
}

export async function listUserRoms(): Promise<UserRom[]> {
  const d = await db();
  const all = await wrap(d.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return (all as UserRom[]).sort((a, b) => a.addedAt - b.addedAt);
}

export async function getUserRom(hash: string): Promise<UserRom | undefined> {
  const d = await db();
  return wrap(d.transaction(STORE, "readonly").objectStore(STORE).get(hash)) as Promise<UserRom | undefined>;
}

export async function deleteUserRom(hash: string): Promise<void> {
  const d = await db();
  await wrap(d.transaction(STORE, "readwrite").objectStore(STORE).delete(hash));
}

export async function clearUserRoms(): Promise<void> {
  const d = await db();
  await wrap(d.transaction(STORE, "readwrite").objectStore(STORE).clear());
}

// -------------------------------------------------------- saves backup

const SAVE_PREFIXES = ["channel3-state:", "channel3-meta:"];

/** Bundle every save + its "where you left off" thumbnail into one file. */
export function exportSaves(): string {
  const saves: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) {
    if (SAVE_PREFIXES.some((p) => k.startsWith(p))) {
      const v = localStorage.getItem(k);
      if (v !== null) saves[k] = v;
    }
  }
  return JSON.stringify({ "channel3-backup": 1, savedAt: Date.now(), saves });
}

/** Restore a backup file; returns how many save entries were written. */
export function importSaves(json: string): number {
  const data = JSON.parse(json) as { "channel3-backup"?: number; saves?: Record<string, string> };
  if (!data.saves || typeof data.saves !== "object") throw new Error("not a Channel 3 backup");
  let n = 0;
  for (const [k, v] of Object.entries(data.saves)) {
    if (SAVE_PREFIXES.some((p) => k.startsWith(p)) && typeof v === "string") {
      localStorage.setItem(k, v);
      n++;
    }
  }
  return n;
}

/** Human-readable "X MB of Y MB" for the settings panel. */
export async function storageSummary(): Promise<string> {
  if (!navigator.storage?.estimate) return "";
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1);
  return quota ? `USING ${mb(usage)} MB OF ~${mb(quota)} MB AVAILABLE` : `USING ${mb(usage)} MB`;
}
