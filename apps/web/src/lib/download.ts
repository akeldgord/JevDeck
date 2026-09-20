/**
 * Saving a file the server produced.
 *
 * One helper for every download, so a package, a text export and a JSON bundle are saved the same
 * way: the bytes come from the API, the browser writes them, and the object URL is revoked
 * afterwards so a large export does not stay alive in the tab.
 */
export function saveBytes(bytes: BlobPart, fileName: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
