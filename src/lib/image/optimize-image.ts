import { assertStoredByteLimit, estimateEncryptedFileBytes, type MetadataInput } from "@/lib/crypto/file-container";
import { ImageOptimizationError, MAX_IMAGE_PIXELS, inspectImage, type ImageInspection } from "./image-policy";

export const IMAGE_PREFERRED_OBJECT_BYTES = 950_000;
export const IMAGE_HARD_OBJECT_BYTES = 1_000_000;
export const IMAGE_MIN_QUALITY = 0.72;
export const IMAGE_MIN_LONG_EDGE = 1_024;
export const IMAGE_MAX_LONG_EDGE = 4_096;

export type ImageOptimizationResult = {
  blob: Blob;
  metadata: MetadataInput;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  estimatedCiphertextBytes: number;
  preferredTargetMet: boolean;
  encoderQuality: number | null;
  qualityWarning: boolean;
};

type Decoded = { image: CanvasImageSource; width: number; height: number; close: () => void };

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImageOptimizationError("cancelled");
}

async function decodeImage(file: File, inspection: ImageInspection, signal?: AbortSignal): Promise<Decoded> {
  cancelled(signal);
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (signal?.aborted) { bitmap.close(); throw new ImageOptimizationError("cancelled"); }
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      cancelled(signal);
      return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ""; URL.revokeObjectURL(url); } };
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  } catch (error) {
    if (error instanceof ImageOptimizationError) throw error;
    throw new ImageOptimizationError(inspection.kind === "heic" ? "unsupported_heic" : "corrupt");
  }
}

function verifyOrientation(inspection: ImageInspection, decoded: Decoded): void {
  if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_IMAGE_PIXELS
    || decoded.width > 12_000 || decoded.height > 12_000) throw new ImageOptimizationError("too_large");
  if (inspection.width && inspection.height) {
    const rotated = inspection.orientation >= 5 && inspection.orientation <= 8;
    const expectedWidth = rotated ? inspection.height : inspection.width;
    const expectedHeight = rotated ? inspection.width : inspection.height;
    if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) throw new ImageOptimizationError("orientation");
  }
}

function storedName(source: string, extension: string): string {
  const last = source.replace(/[\\/]/g, "").normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const stem = last.replace(/\.[^.]+$/, "").trim() || "image";
  const maxStem = 255 - extension.length - 1;
  return `${stem.slice(0, maxStem)}.${extension}`;
}

async function encode(canvas: HTMLCanvasElement, mimeType: "image/webp" | "image/jpeg" | "image/png", quality: number, signal?: AbortSignal): Promise<Blob | null> {
  cancelled(signal);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  cancelled(signal);
  return blob?.type === mimeType ? blob : null; // An unsupported type silently becomes PNG.
}

function blobBytes(parts: Uint8Array[], mimeType: string): Blob {
  // Copy into ordinary ArrayBuffers; BlobPart's DOM type excludes SharedArrayBuffer.
  return new Blob(parts.map((part) => Uint8Array.from(part).buffer), { type: mimeType });
}

async function stripPrivateMetadata(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (blob.type === "image/jpeg") {
    const parts: Uint8Array[] = [bytes.subarray(0, 2)];
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const start = offset;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) {
        parts.push(bytes.subarray(start));
        return blobBytes(parts, blob.type);
      }
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) throw new ImageOptimizationError("encoder");
      offset += length;
      if (!((marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe)) parts.push(bytes.subarray(start, offset));
    }
    throw new ImageOptimizationError("encoder");
  }
  if (blob.type === "image/png") {
    const parts: Uint8Array[] = [bytes.subarray(0, 8)];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const start = offset;
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const name = new TextDecoder("ascii").decode(bytes.subarray(offset + 4, offset + 8));
      if (name === "acTL") throw new ImageOptimizationError("encoder");
      offset += length + 12;
      if (offset > bytes.length) throw new ImageOptimizationError("encoder");
      if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(name)) parts.push(bytes.subarray(start, offset));
      if (name === "IEND") {
        if (offset !== bytes.length) throw new ImageOptimizationError("encoder");
        return blobBytes(parts, blob.type);
      }
    }
    throw new ImageOptimizationError("encoder");
  }
  if (blob.type === "image/webp") {
    const parts: Uint8Array[] = [];
    let offset = 12, hasImage = false;
    while (offset + 8 <= bytes.length) {
      const name = new TextDecoder("ascii").decode(bytes.subarray(offset, offset + 4));
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      if (name === "ANIM" || name === "ANMF") throw new ImageOptimizationError("encoder");
      if (name === "VP8 " || name === "VP8L") hasImage = true;
      const next = offset + 8 + length + (length & 1);
      if (["VP8X", "ALPH", "VP8 ", "VP8L"].includes(name)) {
        const part = bytes.slice(offset, next);
        if (name === "VP8X" && part.length > 8) part[8] &= ~(0x20 | 0x08 | 0x04);
        parts.push(part);
      }
      offset = next;
      if (offset > bytes.length) throw new ImageOptimizationError("encoder");
    }
    if (offset !== bytes.length || !hasImage) throw new ImageOptimizationError("encoder");
    const outputLength = 12 + parts.reduce((sum, part) => sum + part.length, 0);
    const header = bytes.slice(0, 12);
    new DataView(header.buffer).setUint32(4, outputLength - 8, true);
    return blobBytes([header, ...parts], blob.type);
  }
  throw new ImageOptimizationError("encoder");
}

export async function optimizeImage(file: File, options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<ImageOptimizationResult> {
  const { signal, onProgress } = options;
  cancelled(signal);
  onProgress?.("Checking the image on this device");
  const inspection = await inspectImage(file);
  cancelled(signal);
  onProgress?.("Decoding and applying image orientation");
  const decoded = await decodeImage(file, inspection, signal);
  try {
    verifyOrientation(inspection, decoded);
    const originalWidth = decoded.width, originalHeight = decoded.height;
    const longest = Math.max(originalWidth, originalHeight);
    const floor = Math.min(longest, IMAGE_MIN_LONG_EDGE);
    let edge = Math.min(longest, IMAGE_MAX_LONG_EDGE);
    const qualityLevels = [0.95, 0.88, 0.8, IMAGE_MIN_QUALITY];
    let hardFallback: ImageOptimizationResult | null = null;
    for (;;) {
      cancelled(signal);
      const scale = edge / longest;
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new ImageOptimizationError("encoder");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(decoded.image, 0, 0, width, height);
      try {
        for (const quality of qualityLevels) {
          cancelled(signal);
          const formats: Array<{ mimeType: "image/webp" | "image/jpeg" | "image/png"; extension: string }> =
            inspection.transparencyPossible ? [{ mimeType: "image/webp", extension: "webp" }, { mimeType: "image/png", extension: "png" }]
              : [{ mimeType: "image/webp", extension: "webp" }, { mimeType: "image/jpeg", extension: "jpg" }];
          for (const format of formats) {
            if (format.mimeType === "image/png" && quality !== qualityLevels[0]) continue;
            onProgress?.(`Trying ${format.extension.toUpperCase()} at ${width} × ${height}`);
            const raw = await encode(canvas, format.mimeType, quality, signal);
            if (!raw) continue;
            const blob = await stripPrivateMetadata(raw);
            cancelled(signal);
            const metadata: MetadataInput = { storedName: storedName(file.name, format.extension), extension: format.extension, mimeType: format.mimeType };
            const estimated = estimateEncryptedFileBytes(blob.size, metadata);
            if (estimated >= BigInt(IMAGE_HARD_OBJECT_BYTES)) continue;
            assertStoredByteLimit("image", estimated);
            const candidate: ImageOptimizationResult = { blob, metadata, width, height, originalWidth, originalHeight,
              estimatedCiphertextBytes: Number(estimated), preferredTargetMet: estimated <= BigInt(IMAGE_PREFERRED_OBJECT_BYTES),
              encoderQuality: format.mimeType === "image/png" ? null : quality,
              qualityWarning: scale < 0.7 || quality < 0.82 };
            if (candidate.preferredTargetMet) return candidate;
            hardFallback ??= candidate;
          }
        }
      } finally { canvas.width = 0; canvas.height = 0; }
      if (edge <= floor) break;
      edge = Math.max(floor, Math.floor(edge * 0.82));
    }
    if (hardFallback) return hardFallback;
    throw new ImageOptimizationError("quality_floor");
  } finally { decoded.close(); }
}
