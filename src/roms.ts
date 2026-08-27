export interface RomEntry {
  file: string;
  title: string;
  author: string;
  year: number;
  players: number;
  license: string;
  source: string;
  /** True for ROMs the user added themselves (stored in IndexedDB). */
  mine?: boolean;
  /** Content hash — present on user-added ROMs; keys their save data. */
  hash?: string;
}

const BASE = `${import.meta.env.BASE_URL}roms/`;

export async function loadManifest(): Promise<RomEntry[]> {
  const res = await fetch(`${BASE}manifest.json`);
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const data = (await res.json()) as { roms: RomEntry[] };
  return data.roms;
}

export async function fetchRom(entry: RomEntry): Promise<Uint8Array> {
  const res = await fetch(BASE + entry.file);
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
