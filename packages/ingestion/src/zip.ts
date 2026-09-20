/**
 * A minimal ZIP reader, enough for OOXML containers (.docx, .pptx).
 *
 * Why not a library: a DOCX or PPTX is a ZIP whose entries are XML, and the only parts of the
 * format this needs are the central directory and two compression methods. A dependency here
 * would be a supply-chain surface for reading two well-specified offsets.
 *
 * What it deliberately does not do, and says so instead of guessing:
 *   - ZIP64 (an entry or archive above 4 GiB, or more than 65535 entries) is refused with a clear
 *     error rather than misread. A textbook-sized DOCX never reaches that.
 *   - Encryption is refused.
 *   - Only `store` (0) and `deflate` (8) are accepted, which is everything Word and PowerPoint
 *     write. Deflate is inflated with the platform's own `DecompressionStream`, so the bytes are
 *     decompressed by the same code path the browser uses, not by a hand-rolled inflater.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** Path inside the container, forward-slashed, as written. */
  name: string;
  /** Compression method: 0 stored, 8 deflated. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Offset of the entry's data, resolved through the local header. */
  dataOffset: number;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The central directory: every entry the container claims to hold. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = dataView(bytes);
  const minimumOffset = Math.max(0, bytes.byteLength - (22 + 0xffff));

  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }

  if (eocd < 0) {
    throw new ZipError('This file is not a ZIP container, so it is not a readable .docx or .pptx.');
  }

  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new ZipError(
      'This container uses ZIP64, which this reader does not support. Re-save the file without ZIP64.'
    );
  }

  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('This ZIP container is damaged: its central directory ends early.');
    }

    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    if ((flags & 0x1) !== 0) {
      throw new ZipError('This container is encrypted, so its contents cannot be read.');
    }

    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (view.getUint32(localHeaderOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`This container is damaged: no local header for ${name}.`);
    }

    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: localHeaderOffset + 30 + localNameLength + localExtraLength,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** One entry's bytes. Every returned array owns its memory, so it outlives the input. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const compressed = bytes.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);

  if (entry.method === 0) {
    return compressed;
  }

  if (entry.method !== 8) {
    throw new ZipError(
      `${entry.name} uses compression method ${entry.method}, which this reader does not support.`
    );
  }

  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries whose name starts with a prefix, in container order. */
export function entriesWithPrefix(entries: ZipEntry[], prefix: string): ZipEntry[] {
  return entries.filter(entry => entry.name.startsWith(prefix) && !entry.name.endsWith('/'));
}

/** One entry by exact name, or `null`. */
export function findEntry(entries: ZipEntry[], name: string): ZipEntry | null {
  return entries.find(entry => entry.name === name) ?? null;
}

/** Decodes an entry that is known to be XML or text. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}
