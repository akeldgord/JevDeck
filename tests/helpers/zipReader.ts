/**
 * A minimal ZIP reader, so an exported package is opened rather than trusted.
 *
 * The export writes stored (uncompressed) entries, so a reader that only has to handle that is
 * enough to make the assertions real: the bytes come out of the package the download produced, not
 * out of the object the test happened to have in memory.
 *
 * It throws on a malformed container rather than returning what it managed to parse — a package
 * whose central directory is broken is the defect, and a partial map would hide it.
 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let index = bytes.length - 22; index >= 0; index--) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP container: no end-of-central-directory record.');

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  for (let index = 0; index < entryCount; index++) {
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
