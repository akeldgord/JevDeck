/**
 * Byte helpers for sending an uploaded file to the API.
 *
 * The API accepts the original file as base64 inside JSON, so these convert without
 * pulling in another dependency.
 */

const BASE64_LIMIT = 0x8000;

/** Standard base64. Chunked so a large document does not blow the argument limit. */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  // `new Uint8Array(view)` copies a view's bytes; `new Uint8Array(buffer)` wraps a buffer.
  const view = new Uint8Array(bytes as ArrayBuffer);
  let binary = '';

  for (let offset = 0; offset < view.length; offset += BASE64_LIMIT) {
    binary += String.fromCharCode(...view.subarray(offset, offset + BASE64_LIMIT));
  }

  return btoa(binary);
}

/** Hex SHA-256 of the original bytes, used as the document's content hash. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}
