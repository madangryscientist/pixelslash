/**
 * A PNG's chunks read the way pngjs's `PNG.sync.read` reads them, down to its error messages, so
 * a file it refused is refused by `diff.wasm`'s decode with the same words (PS-210). The CRCs are
 * the module's (`crc` takes an offset into the file), the pixels are `diff-wasm.ts`'s.
 */

export const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the chunk walk read: the header, the IDAT data in order, the palette and tRNS's colour. */
export type Png = {
  width: number;
  height: number;
  depth: number;
  colour: number;
  interlace: number;
  idat: Buffer[];
  /** RGBA entries, tRNS's alpha applied. */
  palette: number[][];
  /** The transparent grey (one value) or RGB (three), raw samples; empty when none. */
  trans: number[];
};

/** pngjs's colour types and their channel counts (`COLORTYPE_TO_BPP_MAP`). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = [1, 2, 4, 8, 16];
/** The chunks pngjs reads, and checks the CRC of; any other is skipped, or refused if critical. */
const KNOWN = new Set(["IHDR", "IEND", "IDAT", "PLTE", "tRNS", "gAMA"]);

/** 8-bit RGB and RGBA's channels: not interlaced and without tRNS, they unfilter straight to RGBA. */
const PLAIN: Record<number, number> = { 2: 3, 6: 4 };

/** `png`'s channels when its lines unfilter straight to RGBA (`PLAIN`); 0 for any other shape. */
export function plainChannels({ depth, colour, interlace, trans }: Png): number {
  if (depth !== 8 || interlace || trans.length > 0) return 0;
  return PLAIN[colour] ?? 0;
}

const WAITING = "There are some read requests waitng on finished stream";
const TRAILING = "unrecognised content at end of stream";

/** A parse error pngjs reports through `error()`: it then stops reading, and its reader throws. */
class Stop extends Error {}

/** The file read front to back, as pngjs's sync reader feeds its parser. */
class Reader {
  pos = 0;
  constructor(readonly bytes: Buffer) {}

  get left(): number {
    return this.bytes.length - this.pos;
  }

  /** The next `length` bytes, or pngjs's error when fewer are left (or none, even for 0). */
  read(length: number): Buffer {
    if (this.left <= 0 || this.left < length) throw new Error(WAITING);
    this.pos += length;
    return this.bytes.subarray(this.pos - length, this.pos);
  }
}

/** The walk's state: the reader, the CRC of the file's bytes, and the image once IHDR is read. */
type Walk = { reader: Reader; crc: (at: number, len: number) => number; png: Png | null };

// Ported from pngjs (MIT): see NOTICE.
/** The IHDR fields, or the error pngjs gives for the first one it does not support. */
function headerOf(data: Buffer): Png {
  const [depth, colour, compression, filter, interlace] = [8, 9, 10, 11, 12].map((i) => data[i]);
  if (depth === undefined || !DEPTHS.includes(depth))
    throw new Stop(`Unsupported bit depth ${depth}`);
  if (colour === undefined || !(colour in CHANNELS)) throw new Stop("Unsupported color type");
  if (compression !== 0) throw new Stop("Unsupported compression method");
  if (filter !== 0) throw new Stop("Unsupported filter method");
  if (interlace !== 0 && interlace !== 1) throw new Stop("Unsupported interlace method");
  const [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)];
  return { width, height, depth, colour, interlace, idat: [], palette: [], trans: [] };
}

// Ported from pngjs (MIT): see NOTICE.
/** A tRNS chunk applied to `png` as pngjs's `_parseTRNS` does. */
function readTrns(png: Png, data: Buffer) {
  if (png.colour === 3) {
    if (png.palette.length === 0) throw new Stop("Transparency chunk must be after palette");
    if (data.length > png.palette.length)
      throw new Stop("More transparent colors than palette size");
    data.forEach((alpha, i) => {
      const entry = png.palette[i];
      if (entry) entry[3] = alpha;
    });
  }
  if (png.colour === 0) png.trans = [data.readUInt16BE(0)];
  if (png.colour === 2)
    png.trans = [data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)];
}

/** One known chunk's data applied: IHDR starts the image, any other adds to it. */
function readChunk(png: Png | null, type: string, data: Buffer): Png | null {
  if (type === "IHDR") return headerOf(data);
  if (!png) return png;
  if (type === "PLTE") {
    for (let i = 0; i + 3 <= data.length; i += 3)
      png.palette.push([...data.subarray(i, i + 3), 255]);
  } else if (type === "tRNS") readTrns(png, data);
  else if (type === "gAMA") data.readUInt32BE(0);
  else if (type === "IDAT") {
    if (png.colour === 3 && png.palette.length === 0) throw new Error("Expected palette not found");
    png.idat.push(data);
  }
  return png;
}

/** A known chunk read and its CRC checked; the image when the chunk is IEND, else null. */
function readKnown(walk: Walk, type: string, length: number): Png | null {
  const { reader } = walk;
  const start = reader.pos - 4;
  // IDAT is pngjs's one short-allowed read: it takes what is left, then waits for the rest.
  const data = reader.read(type === "IDAT" ? Math.min(length, reader.left) : length);
  walk.png = readChunk(walk.png, type, data);
  if (data.length < length) reader.read(length - data.length);
  const fileCrc = reader.read(4).readInt32BE(0);
  const calcCrc = walk.crc(start, 4 + length) | 0;
  if (calcCrc !== fileCrc) throw new Stop(`Crc error - ${fileCrc} - ${calcCrc}`);
  return type === "IEND" ? walk.png : null;
}

/** The next chunk; the image at IEND, else null. An unknown chunk is skipped if ancillary. */
function nextChunk(walk: Walk): Png | null {
  const begin = walk.reader.read(8);
  const length = begin.readUInt32BE(0);
  const type = begin.toString("latin1", 4, 8);
  if (!walk.png && type !== "IHDR") throw new Stop("Expected IHDR on beggining");
  if (KNOWN.has(type)) return readKnown(walk, type, length);
  if (!((begin[4] ?? 0) & 0x20)) throw new Stop(`Unsupported critical chunk type ${type}`);
  walk.reader.read(length + 4);
  return null;
}

// Ported from pngjs (MIT): see NOTICE.
/**
 * Walk `bytes` chunk by chunk, as pngjs's parser and sync reader do; `crc(at, len)` is the CRC of
 * `len` bytes from offset `at`. The errors are pngjs's too, including its quirk: an error raised
 * through `error()` with bytes still unread surfaces as "unrecognised content at end of stream".
 */
export function walkPng(bytes: Buffer, crc: Walk["crc"]): Png {
  const walk: Walk = { reader: new Reader(bytes), crc, png: null };
  try {
    const signature = walk.reader.read(8);
    if (SIGNATURE.some((byte, i) => signature[i] !== byte))
      throw new Stop("Invalid file signature");
    let png: Png | null = null;
    while (!png) png = nextChunk(walk);
    if (walk.reader.left > 0) throw new Error(TRAILING);
    return png;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    throw new Error(walk.reader.left > 0 ? TRAILING : error.message, { cause: error });
  }
}
