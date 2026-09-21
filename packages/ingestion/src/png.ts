/**
 * A PNG encoder, so an image read out of a document can be stored as a real image file.
 *
 * Extraction of a PDF image hands back *samples* — three bytes per pixel, or one, or an alpha
 * channel — and those have to leave this build as a file a browser, a note editor and Anki will all
 * open. A PNG is the format that can hold every one of those shapes losslessly, and writing one
 * needs two things this file implements directly: a CRC (for the chunk checksums) and a zlib
 * container (for the compressed pixel data).
 *
 * The deflate stream is written with **stored** blocks — a valid zlib stream that compresses
 * nothing. That is deliberate, and it is the whole reason this encoder is dependency-free:
 *
 *   - it is synchronous, so it works identically in the browser and in Node without dragging in
 *     `zlib` on one side and `CompressionStream` on the other;
 *   - it cannot fail on a pathological input, which matters because this runs inside the upload
 *     path where a thrown error loses the whole document;
 *   - the alternative — an asynchronous compressor — would make every extraction step async for a
 *     few percent of file size, and the bytes are stored in a database per document whose size is
 *     already bounded by the media limits.
 *
 * A reader never sees the difference: stored blocks are what every inflate implementation handles,
 * which is the property that makes the file a PNG rather than something that merely resembles one.
 */

/** The PNG chunk type's four ASCII bytes, and the rest of the file's fixed structure. */
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32, as PNG defines it for every chunk. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32, the checksum a zlib stream ends with. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream whose deflate blocks are all stored, so nothing has to be compressed. */
export function zlibStored(bytes: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(bytes.length / 0xffff));
  const out = new Uint8Array(2 + bytes.length + blockCount * 5 + 4);
  let offset = 0;

  // CMF/FLG: deflate, 32 KiB window, no preset dictionary, no compression level to state.
  out[offset++] = 0x78;
  out[offset++] = 0x01;

  if (bytes.length === 0) {
    out[offset++] = 0x01; // BFINAL, BTYPE 00
    out[offset++] = 0x00;
    out[offset++] = 0x00;
    out[offset++] = 0xff;
    out[offset++] = 0xff;
  } else {
    for (let start = 0; start < bytes.length; start += 0xffff) {
      const length = Math.min(0xffff, bytes.length - start);
      const last = start + length >= bytes.length;

      out[offset++] = last ? 0x01 : 0x00;
      out[offset++] = length & 0xff;
      out[offset++] = (length >>> 8) & 0xff;
      out[offset++] = ~length & 0xff;
      out[offset++] = (~length >>> 8) & 0xff;
      out.set(bytes.subarray(start, start + length), offset);
      offset += length;
    }
  }

  const checksum = adler32(bytes);
  out[offset++] = (checksum >>> 24) & 0xff;
  out[offset++] = (checksum >>> 16) & 0xff;
  out[offset++] = (checksum >>> 8) & 0xff;
  out[offset++] = checksum & 0xff;

  return out.subarray(0, offset);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);

  const forCrc = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(forCrc));

  return out;
}

export interface PngInput {
  width: number;
  height: number;
  /** Row-major samples: `channels` bytes per pixel, no padding. */
  pixels: Uint8Array;
  channels: 1 | 3 | 4;
}

/**
 * Whether the samples describe an image this encoder will write.
 *
 * Checked rather than assumed: a malformed image lifted out of a document would otherwise be stored
 * as a PNG whose declared size disagrees with its contents, which renders as garbage instead of
 * failing where the mistake was made.
 */
export function isEncodablePng(input: PngInput): boolean {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height)) return false;
  if (input.width <= 0 || input.height <= 0) return false;
  if (input.pixels.length !== input.width * input.height * input.channels) return false;
  return true;
}

/**
 * Encodes samples as a PNG.
 *
 * One filter byte per scanline, always `0` (None): the samples are lifted from a document that has
 * already encoded them once, so filtering them a second time buys little and costs an encoder that
 * has to reason about row edges.
 */
export function encodePng(input: PngInput): Uint8Array {
  const { width, height, pixels, channels } = input;
  if (!isEncodablePng(input)) {
    throw new Error('The image samples do not match their stated size.');
  }

  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/**
 * Expands a 1-bit-per-pixel mask to one grey byte per pixel.
 *
 * A PDF packs a monochrome image one bit per pixel, with each row padded to a byte boundary. PNG
 * has no 1-bit grey type here (it does, but only as a packed form this encoder does not write), so
 * the bits are unpacked — which is also what makes the stored image readable by anything that
 * understands PNG at all.
 */
export function expandOneBitRow(
  data: Uint8Array,
  width: number,
  height: number,
  invert = false
): Uint8Array {
  const out = new Uint8Array(width * height);
  const rowBytes = Math.ceil(width / 8);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = data[y * rowBytes + (x >> 3)] ?? 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      out[y * width + x] = (invert ? 1 - bit : bit) === 1 ? 255 : 0;
    }
  }

  return out;
}

/** The PNG's own signature, so a caller can check what it produced without a decoder. */
export const PNG_SIGNATURE = SIGNATURE;
