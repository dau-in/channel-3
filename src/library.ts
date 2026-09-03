// Persistent, browser-local library for ROMs the user adds themselves.
//
// Everything here lives only in the visitor's own browser — IndexedDB for the
// ROM binaries and for save states. Nothing is ever uploaded or redistributed:
// the same posture as any desktop emulator opening a local file, which is what
// keeps the feature clean legally.

const DB_NAME = "channel3";
const DB_VERSION = 2;
const STORE = "roms";
const SAVES = "saves";

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
      if (!d.objectStoreNames.contains(SAVES)) d.createObjectStore(SAVES, { keyPath: "key" });
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
async function hashRom(bytes: Uint8Array): Promise<string> {
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

/** Bundle every save and its "where you left off" thumbnail into one file.
 *  Backup file, version 2: states come out of the database now. Version 1
 *  files are still readable on the way back in. */
export async function exportSaves(): Promise<string> {
  const d = await db();
  const tx = d.transaction(SAVES, "readonly");
  const rows = await wrap(tx.objectStore(SAVES).getAll() as IDBRequest<SaveRow[]>);
  return JSON.stringify({ "channel3-backup": 2, savedAt: Date.now(), states: rows });
}

/** Restore a backup file; returns how many save entries were written. */
export async function importSaves(json: string): Promise<number> {
  const data = JSON.parse(json) as {
    "channel3-backup"?: number;
    states?: SaveRow[];
    saves?: Record<string, string>;
  };
  let n = 0;
  if (Array.isArray(data.states)) {
    for (const row of data.states) {
      if (typeof row?.key !== "string" || typeof row?.state !== "string") continue;
      await putSave(row.key, row.state, row.meta ?? { t: Date.now() });
      n++;
    }
    return n;
  }
  // A version 1 file: flat localStorage keys, states and metadata mixed.
  if (!data.saves || typeof data.saves !== "object") throw new Error("not a Channel 3 backup");
  const statePrefix = "channel3-state:";
  for (const [k, v] of Object.entries(data.saves)) {
    if (!k.startsWith(statePrefix) || typeof v !== "string") continue;
    const key = k.slice(statePrefix.length);
    let meta: SaveMeta = { t: Date.now() };
    try {
      const raw = data.saves[`channel3-meta:${key}`];
      if (raw) meta = JSON.parse(raw) as SaveMeta;
    } catch {
      // keep the default stamp
    }
    await putSave(key, v, meta);
    n++;
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


// --------------------------------------------------------------- save states
//
// These used to sit in localStorage, which is a few megabytes for the whole
// origin and shared with cart art and settings. A serialised jsnes state does
// not fit in what is left, so saving reported TOO LARGE and autosave quietly
// wrote nothing at all. IndexedDB has room for them.
//
// The metadata index is mirrored in memory because "is there a save for this
// cart?" is asked while deciding what to show on screen, and that decision is
// synchronous everywhere it happens.

export interface SaveMeta {
  /** When it was written. */
  t: number;
  /** Small JPEG data URL of the frame, for the continue prompt. */
  shot?: string;
}

interface SaveRow {
  key: string;
  state: string;
  meta: SaveMeta;
}

const metaIndex = new Map<string, SaveMeta>();

/** Read the index, and move anything still in localStorage into the database.
 *  Call once at boot, before anything asks whether a save exists. */
export async function initSaves(): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(SAVES, "readonly");
    const rows = await wrap(tx.objectStore(SAVES).getAll() as IDBRequest<SaveRow[]>);
    for (const row of rows) metaIndex.set(row.key, row.meta);
  } catch {
    // no database: saving will fail loudly rather than silently
  }
  await migrateLegacySaves();
}

/** Saves written by the localStorage era, brought across and cleared out. */
async function migrateLegacySaves(): Promise<void> {
  const prefix = "channel3-state:";
  const keys = Object.keys(localStorage).filter((k) => k.startsWith(prefix));
  for (const storageKey of keys) {
    const key = storageKey.slice(prefix.length);
    const state = localStorage.getItem(storageKey);
    if (state === null) continue;
    let meta: SaveMeta = { t: Date.now() };
    try {
      const raw = localStorage.getItem(`channel3-meta:${key}`);
      if (raw) meta = JSON.parse(raw) as SaveMeta;
    } catch {
      // a broken meta blob is not worth losing the state over
    }
    try {
      await putSave(key, state, meta);
      localStorage.removeItem(storageKey);
      localStorage.removeItem(`channel3-meta:${key}`);
    } catch {
      // leave it where it is and try again next boot
    }
  }
}

export function hasSave(key: string): boolean {
  return metaIndex.has(key);
}

export function saveMeta(key: string): SaveMeta | null {
  return metaIndex.get(key) ?? null;
}

export function savedKeys(): string[] {
  return [...metaIndex.keys()];
}

export async function putSave(key: string, state: string, meta: SaveMeta): Promise<void> {
  const d = await db();
  const tx = d.transaction(SAVES, "readwrite");
  await wrap(tx.objectStore(SAVES).put({ key, state, meta } satisfies SaveRow));
  metaIndex.set(key, meta);
}

export async function getSave(key: string): Promise<string | null> {
  try {
    const d = await db();
    const tx = d.transaction(SAVES, "readonly");
    const row = await wrap(tx.objectStore(SAVES).get(key) as IDBRequest<SaveRow | undefined>);
    return row?.state ?? null;
  } catch {
    return null;
  }
}

export async function dropSave(key: string): Promise<void> {
  metaIndex.delete(key);
  try {
    const d = await db();
    const tx = d.transaction(SAVES, "readwrite");
    await wrap(tx.objectStore(SAVES).delete(key));
  } catch {
    // gone from the index either way
  }
}

export async function clearSaves(): Promise<void> {
  metaIndex.clear();
  try {
    const d = await db();
    const tx = d.transaction(SAVES, "readwrite");
    await wrap(tx.objectStore(SAVES).clear());
  } catch {
    // nothing to clear
  }
}
