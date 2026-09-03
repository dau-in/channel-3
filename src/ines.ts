// Reading the iNES header, which is the only thing that can answer two
// questions before a ROM is ever run: is this actually a NES ROM, and is its
// mapper one the core implements.

/** Mappers jsnes actually has an implementation for. */
export const SUPPORTED_MAPPERS = new Set([0, 1, 2, 3, 4, 5, 7, 11, 34, 38, 66, 94, 140, 180]);

export interface INesHeader {
  mapper: number;
  /** Program ROM in KiB. */
  prgKb: number;
  /** Character ROM in KiB — zero means the cart generates its own tiles. */
  chrKb: number;
  /** NES 2.0 carries extra fields; we only note that it is the newer format. */
  nes2: boolean;
}

const MAGIC = [0x4e, 0x45, 0x53, 0x1a]; // "NES" + EOF

/** Parse the 16-byte header, or null if this is not a NES ROM at all.
 *
 *  Used on every file the player adds: the file picker's `accept` attribute is
 *  a hint the dialog lets you override, so a .zip — or anything else — reached
 *  the shelf and sat there as a cartridge that could never run. The header is
 *  the honest check, and it also catches a ROM someone renamed. */
export function readINes(bytes: Uint8Array): INesHeader | null {
  if (bytes.length < 16) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return null;

  const flags6 = bytes[6];
  const flags7 = bytes[7];

  // Old dumping tools wrote their name into bytes 7..15, so the high nibble of
  // byte 7 is garbage on those and would report a wildly wrong mapper. The
  // usual tell is any non-zero byte in 12..15.
  let dirty = false;
  for (let i = 12; i < 16; i++) if (bytes[i] !== 0) dirty = true;

  const nes2 = !dirty && (flags7 & 0x0c) === 0x08;
  const high = dirty ? 0 : flags7 & 0xf0;
  const mapper = (flags6 >> 4) | high;

  return { mapper, prgKb: bytes[4] * 16, chrKb: bytes[5] * 8, nes2 };
}

/** True when the file looks like a NES ROM at all. */
export function isNesRom(bytes: Uint8Array): boolean {
  return readINes(bytes) !== null;
}

/** What is wrong with this ROM, in words, or null if nothing is. */
export function romProblem(bytes: Uint8Array): string | null {
  const head = readINes(bytes);
  if (!head) return "NOT A NES ROM";
  if (!SUPPORTED_MAPPERS.has(head.mapper)) return `MAPPER ${head.mapper} NOT SUPPORTED`;
  return null;
}
