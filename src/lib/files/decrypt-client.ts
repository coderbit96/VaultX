import { blobCiphertextSource, openEncryptedContainer, type CiphertextSource, type FileManifest } from "@/lib/crypto/file-container";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";

const BLOB_FALLBACK_MAX_BYTES = 32_000_000;
const TEXT_PREVIEW_MAX_BYTES = 2_000_000;
const PREVIEW_MAX_BYTES = 20_000_000;
export const VIDEO_BLOB_PREVIEW_MAX_BYTES = 10_000_000;

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none";
export type DecryptedFile = { blob: Blob; metadata: { storedName: string; extension: string; mimeType: string } };

export function previewKind(mimeType: string, extension: string): PreviewKind {
  const mime = mimeType.toLowerCase();
  const ext = extension.toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) && ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (mime === "video/mp4" && ext === "mp4") return "video";
  if (["audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"].includes(mime) && ["mp3", "m4a", "wav", "ogg"].includes(ext)) return "audio";
  if (mime === "application/pdf" && ext === "pdf") return "pdf";
  if (mime === "text/plain" && ["txt", "log", "csv", "json"].includes(ext)) return "text";
  return "none";
}

export function downloadName(storedName: string, extension: string): string {
  const ext = extension.toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(ext)) throw new Error("Invalid stored extension");
  const clean = storedName.normalize("NFC").replace(/[\\/\p{Cc}\p{Cf}]/gu, "").trim();
  const stem = clean.replace(/\.[^.]*$/, "").trim().slice(0, 180) || "vaultx-file";
  return `${stem}.${ext}`;
}

function exactRange(response: Response, start: bigint, endExclusive: bigint, total: bigint): void {
  const length = endExclusive - start;
  if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${endExclusive - BigInt(1)}/${total}`
    || response.headers.get("content-length") !== String(length) || !response.body) throw new Error("Invalid ciphertext range response");
}

export function authenticatedCiphertextSource(fileId: string, totalBytes: number, signal?: AbortSignal,
  variant: "access" | "thumbnail" = "access"): CiphertextSource {
  const total = BigInt(totalBytes);
  return { size: total, async read(start, endExclusive) {
    if (start < BigInt(0) || endExclusive <= start || endExclusive > total) throw new Error("Invalid ciphertext read");
    const response = await fetch(`/api/files/${fileId}/${variant}`, { credentials: "same-origin", cache: "no-store", signal,
      headers: { Range: `bytes=${start}-${endExclusive - BigInt(1)}`, Accept: "application/octet-stream" } });
    if (response.status === 401) { clearVaultKeyMaterial(); throw new Error("Vault session is locked or expired"); }
    exactRange(response, start, endExclusive, total);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== Number(endExclusive - start)) { bytes.fill(0); throw new Error("Truncated ciphertext range"); }
    return bytes;
  } };
}

function assertMetadata(expected: { extension: string; mimeType: string }, actual: { extension: string; mimeType: string }) {
  if (expected.extension.toLowerCase() !== actual.extension.toLowerCase() || expected.mimeType.toLowerCase() !== actual.mimeType.toLowerCase()) {
    throw new Error("Authenticated metadata does not match this stored file");
  }
}

export async function decryptToBlob(fileId: string, storedSizeBytes: number, manifest: FileManifest,
  expected: { extension: string; mimeType: string }, signal?: AbortSignal): Promise<DecryptedFile> {
  const opened = await openEncryptedContainer(authenticatedCiphertextSource(fileId, storedSizeBytes, signal), manifest, signal);
  const parts: BlobPart[] = [];
  try {
    assertMetadata(expected, opened.metadata);
    for await (const chunk of opened.chunks()) {
      if (signal?.aborted) { chunk.fill(0); throw new DOMException("Aborted", "AbortError"); }
      parts.push(chunk.slice().buffer); chunk.fill(0);
    }
    return { blob: new Blob(parts, { type: opened.metadata.mimeType }), metadata: opened.metadata };
  } catch (error) {
    for (const part of parts) if (part instanceof ArrayBuffer) new Uint8Array(part).fill(0);
    throw error;
  } finally { opened.close(); }
}

export async function decryptPreview(fileId: string, storedSizeBytes: number, manifest: FileManifest,
  expected: { extension: string; mimeType: string }, kind: PreviewKind, signal?: AbortSignal): Promise<DecryptedFile> {
  const limit = kind === "text" ? TEXT_PREVIEW_MAX_BYTES : kind === "video" ? VIDEO_BLOB_PREVIEW_MAX_BYTES : PREVIEW_MAX_BYTES;
  if (kind === "none" || (kind === "video" ? storedSizeBytes >= limit : storedSizeBytes > limit + 65_536)) {
    throw new Error("This file type or size is download-only");
  }
  return decryptToBlob(fileId, storedSizeBytes, manifest, expected, signal);
}

export async function decryptThumbnail(fileId: string, storedSizeBytes: number, manifest: FileManifest,
  signal?: AbortSignal): Promise<Blob> {
  if (manifest.kind !== "thumbnail" || storedSizeBytes >= 1_000_000) throw new Error("Invalid thumbnail");
  const opened = await openEncryptedContainer(authenticatedCiphertextSource(fileId, storedSizeBytes, signal, "thumbnail"), manifest, signal);
  const parts: BlobPart[] = [];
  try {
    if (opened.metadata.mimeType !== "image/webp" || opened.metadata.extension !== "webp"
      || opened.plaintextLength > BigInt(900_000)) throw new Error("Invalid thumbnail metadata");
    for await (const chunk of opened.chunks()) { parts.push(chunk.slice().buffer); chunk.fill(0); }
    return new Blob(parts, { type: "image/webp" });
  } finally { opened.close(); }
}

type Writable = { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> };
type SaveWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<Writable> }> };

export async function chooseDownloadDestination(name: string, mimeType: string, extension: string): Promise<Writable | undefined> {
  const picker = (window as SaveWindow).showSaveFilePicker;
  if (!picker) return undefined;
  const handle = await picker.call(window, { suggestedName: name, types: [{ description: "Stored VaultX file", accept: { [mimeType]: [`.${extension}`] } }] });
  return handle.createWritable();
}

export async function downloadDecryptedFile(fileId: string, storedSizeBytes: number, manifest: FileManifest,
  expected: { extension: string; mimeType: string }, signal?: AbortSignal, destination?: Writable, suggestedName?: string): Promise<"streamed" | "blob"> {
  const opened = await openEncryptedContainer(authenticatedCiphertextSource(fileId, storedSizeBytes, signal), manifest, signal);
  const writer = destination;
  const parts: BlobPart[] = [];
  try {
    assertMetadata(expected, opened.metadata);
    const name = downloadName(suggestedName ?? opened.metadata.storedName, opened.metadata.extension);
    const writable = writer;
    if (!writable && Number(opened.plaintextLength) > BLOB_FALLBACK_MAX_BYTES) throw new Error("This browser cannot save this large file without buffering it in memory.");
    for await (const chunk of opened.chunks()) {
      if (signal?.aborted) { chunk.fill(0); throw new DOMException("Aborted", "AbortError"); }
      if (writable) await writable.write(chunk);
      else parts.push(chunk.slice().buffer);
      chunk.fill(0);
    }
    if (writable) { await writable.close(); return "streamed"; }
    const blob = new Blob(parts, { type: opened.metadata.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.style.display = "none";
    document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return "blob";
  } catch (error) {
    await writer?.abort(error).catch(() => undefined);
    for (const part of parts) if (part instanceof ArrayBuffer) new Uint8Array(part).fill(0);
    throw error;
  } finally { opened.close(); }
}

export function textFromBlob(blob: Blob): Promise<string> {
  return blob.text();
}

// Kept for isolated tests that need a bounded in-memory encrypted source.
export { blobCiphertextSource };
