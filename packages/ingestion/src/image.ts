import { chunkedSections } from './text';
import type { IngestedMedia, IngestedSource } from './types';

/**
 * An uploaded picture or scan, read for what it is.
 *
 * A standalone image has no text layer, so there is nothing to extract and saying otherwise would
 * be the dishonesty this step exists to remove. What the reader can do honestly is keep the bytes,
 * record the page as *unread content* rather than as a blank page, and say in the coverage report
 * that its text is whatever the OCR pass reads off it — or nothing, if no OCR engine is configured.
 *
 * The container is checked by its own magic bytes rather than by the file name: a `.png` that is
 * really a PDF must not be stored as an image, and a reader that trusted the extension would.
 */

export interface ImageType {
  contentType: string;
  label: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

/**
 * The image type the bytes actually are, or `null`.
 *
 * Only formats with a fixed, checkable signature are accepted. A TypeScript reader cannot decode
 * every picture format, and storing bytes it cannot identify as an image would put a row in the
 * source viewer that no part of the system can render.
 */
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return { contentType: 'image/png', label: 'PNG' };

  // JPEG: SOI marker followed by any segment marker.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', label: 'JPEG' };
  }

  // GIF87a / GIF89a.
  if (bytes.length >= 6) {
    const header = new TextDecoder('latin1').decode(bytes.subarray(0, 6));
    if (header === 'GIF87a' || header === 'GIF89a') {
      return { contentType: 'image/gif', label: 'GIF' };
    }
  }

  // RIFF....WEBP
  if (bytes.length >= 12) {
    const riff = new TextDecoder('latin1').decode(bytes.subarray(0, 4));
    const webp = new TextDecoder('latin1').decode(bytes.subarray(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') {
      return { contentType: 'image/webp', label: 'WebP' };
    }
  }

  // BMP: the two-character signature `BM` and a plausible header length.
  if (bytes.length >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { contentType: 'image/bmp', label: 'BMP' };
  }

  return null;
}

export class UnreadableImageError extends Error {
  readonly fileName: string;

  constructor(fileName: string) {
    super(
      `“${fileName}” is not a picture this build can store. Accepted image formats are PNG, JPEG, ` +
        'GIF, WebP and BMP; convert the file to one of those, or upload it as a PDF.'
    );
    this.name = 'UnreadableImageError';
    this.fileName = fileName;
  }
}

/**
 * Reads an uploaded image into the shared source shape.
 * * One page, no text, `image-only`, and the bytes kept as a `scan` so the source viewer can show
 * exactly the picture a card would be read from. The OCR pass is what can turn this page into text,
 * and it runs afterwards, in the background, where a run pays for it.
 *
 * The page is given the one section that covers it, for the same reason every other reader chunks
 * a document that states no headings: a run is scoped to a section. A picture with no sections
 * could be uploaded and reported and then never generated from, because every screen and the
 * pipeline itself ask which part of the document a run should cover.
 */
export function readImageSource(input: {
  fileName: string;
  bytes: Uint8Array;
  /** Overrides the detected content type; only used when the caller knows better. */
  contentType?: string;
}): IngestedSource {
  const detected = imageTypeOf(input.bytes);
  if (!detected) throw new UnreadableImageError(input.fileName);

  const contentType = input.contentType ?? detected.contentType;

  const media: IngestedMedia = {
    pageNumber: 1,
    kind: 'scan',
    name: input.fileName,
    contentType,
    bytes: input.bytes,
    anchor: 'embedded',
  };

  return {
    format: 'image',
    fileName: input.fileName,
    pageCount: 1,
    totalWords: 0,
    pages: [{ pageNumber: 1, text: '', kind: 'image-only', textSource: 'none' }],
    sections: chunkedSections(1, [0], start => `Page ${start}`),
    media: [media],
    hasToc: false,
    pagination: 'explicit',
    blankPages: [],
    unextractedPages: [1],
    limitations: [
      `This upload is a single ${detected.label} picture, so it has no text of its own: its page is ` +
        'recorded as unread content, not as an empty page.',
      'Its text is whatever the OCR pass reads out of the picture when a run needs it. An installation ' +
        'with no OCR engine configured leaves the page unread and says so in the coverage report.',
    ],
    bytes: input.bytes,
  };
}
