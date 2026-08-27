// Offline title lookup for user-added ROMs. A .nes file carries no game name,
// so we match its CRC32 against a compact database (crc → title) derived from
// libretro-database's No-Intro NES DAT — factual metadata only, no ROMs. The
// DB (~220 KB, precached by the PWA) is fetched once and cached in memory.

const BASE = import.meta.env.BASE_URL;

// CRC32 (IEEE), computed over the full headered .nes file — that's the
// convention the No-Intro .nes checksums use.
let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (table = t);
}

export function crc32(bytes: Uint8Array): string {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

// Each DB row is [title, author?, year?] — trailing fields omitted when blank.
type Row = [string, string?, string?];
export interface RomInfo {
  title: string;
  author?: string;
  year?: number;
}

let dbp: Promise<Record<string, Row>> | null = null;
function loadDb(): Promise<Record<string, Row>> {
  if (!dbp) {
    dbp = fetch(`${BASE}nesdb.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, Row>>) : Promise.reject()))
      .catch(() => {
        dbp = null; // don't cache a failed load — retry on the next add (e.g. once online)
        return {} as Record<string, Row>;
      });
  }
  return dbp;
}

/** Catalogued title/author/year for these ROM bytes, or null if unknown. */
export async function lookupRom(bytes: Uint8Array): Promise<RomInfo | null> {
  const db = await loadDb();
  const row = db[crc32(bytes)];
  if (!row) return null;
  const year = row[2] ? parseInt(row[2], 10) : undefined;
  return { title: row[0], author: row[1] || undefined, year: year || undefined };
}
