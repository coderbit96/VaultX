export type ImageKind = "jpeg" | "png" | "webp" | "gif" | "heic";
export type ImageInspection = { kind: ImageKind; width?: number; height?: number; orientation: number; transparencyPossible: boolean };

export class ImageOptimizationError extends Error {
  constructor(readonly code: "unsupported" | "unsupported_heic" | "animated" | "corrupt" | "too_large" | "quality_floor" | "cancelled" | "orientation" | "encoder") {
    super(code);
    this.name = "ImageOptimizationError";
  }
}

export const MAX_IMAGE_SOURCE_BYTES = 50_000_000;
export const MAX_IMAGE_PIXELS = 40_000_000;
const decoder = new TextDecoder("ascii");

function checkDimensions(width: number, height: number): void {
  if (!width || !height || width > 12_000 || height > 12_000 || width * height > MAX_IMAGE_PIXELS) {
    throw new ImageOptimizationError("too_large");
  }
}

function parseExifOrientation(bytes: Uint8Array): number {
  if (bytes.length < 14 || decoder.decode(bytes.subarray(0, 6)) !== "Exif\0\0") throw new ImageOptimizationError("orientation");
  const start = 6;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  if (!little && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d)) throw new ImageOptimizationError("orientation");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(start + offset, little);
  const u32 = (offset: number) => view.getUint32(start + offset, little);
  if (u16(2) !== 42) throw new ImageOptimizationError("orientation");
  const ifd = u32(4);
  if (start + ifd + 2 > bytes.length) throw new ImageOptimizationError("orientation");
  const count = u16(ifd);
  if (count > 256 || start + ifd + 2 + count * 12 > bytes.length) throw new ImageOptimizationError("orientation");
  for (let index = 0; index < count; index++) {
    const offset = ifd + 2 + index * 12;
    if (u16(offset) !== 0x0112) continue;
    if (u16(offset + 2) !== 3 || u32(offset + 4) !== 1) throw new ImageOptimizationError("orientation");
    const value = u16(offset + 8);
    if (value < 1 || value > 8) throw new ImageOptimizationError("orientation");
    return value;
  }
  return 1;
}

function inspectJpeg(bytes: Uint8Array): ImageInspection {
  let offset = 2, width = 0, height = 0, orientation = 1;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new ImageOptimizationError("corrupt");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new ImageOptimizationError("corrupt");
    const payload = bytes.subarray(offset + 2, offset + length);
    if (marker === 0xe1 && payload.length >= 6 && decoder.decode(payload.subarray(0, 6)) === "Exif\0\0") {
      orientation = parseExifOrientation(payload);
    }
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (payload.length < 5) throw new ImageOptimizationError("corrupt");
      height = (payload[1] << 8) | payload[2]; width = (payload[3] << 8) | payload[4];
      break;
    }
    offset += length;
  }
  if (!width || !height) throw new ImageOptimizationError("corrupt");
  checkDimensions(width, height);
  return { kind: "jpeg", width, height, orientation, transparencyPossible: false };
}

async function inspectPng(blob: Blob, head: Uint8Array): Promise<ImageInspection> {
  if (head.length < 29 || new DataView(head.buffer, head.byteOffset + 8, 4).getUint32(0) !== 13
    || decoder.decode(head.subarray(12, 16)) !== "IHDR") throw new ImageOptimizationError("corrupt");
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  checkDimensions(width, height);
  let transparencyPossible = head[25] === 4 || head[25] === 6;
  let offset = 8;
  for (let count = 0; count < 1000 && offset + 12 <= blob.size; count++) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    const chunkView = new DataView(chunk.buffer);
    const length = chunkView.getUint32(0);
    const name = decoder.decode(chunk.subarray(4, 8));
    if (offset + length + 12 > blob.size) throw new ImageOptimizationError("corrupt");
    if (name === "acTL") throw new ImageOptimizationError("animated");
    if (name === "tRNS") transparencyPossible = true;
    if (name === "IDAT" || name === "IEND") return { kind: "png", width, height, orientation: 1, transparencyPossible };
    offset += length + 12;
  }
  throw new ImageOptimizationError("corrupt");
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (!length) return offset;
    offset += length;
    if (offset > bytes.length) break;
  }
  throw new ImageOptimizationError("corrupt");
}

async function inspectGif(blob: Blob): Promise<ImageInspection> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 14) throw new ImageOptimizationError("corrupt");
  const width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8);
  checkDimensions(width, height);
  let offset = 13 + (bytes[10] & 0x80 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let frames = 0, transparencyPossible = false;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9 && bytes[offset] === 4) transparencyPossible ||= !!(bytes[offset + 1] & 1);
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) throw new ImageOptimizationError("corrupt");
    frames++;
    if (frames > 1) throw new ImageOptimizationError("animated");
    const flags = bytes[offset + 8]; offset += 9;
    if (flags & 0x80) offset += 3 * (1 << ((flags & 7) + 1));
    if (offset >= bytes.length) throw new ImageOptimizationError("corrupt");
    offset++; // LZW minimum code size.
    offset = skipGifSubBlocks(bytes, offset);
  }
  if (frames !== 1 || bytes[offset - 1] !== 0x3b) throw new ImageOptimizationError("corrupt");
  return { kind: "gif", width, height, orientation: 1, transparencyPossible };
}

async function inspectWebp(blob: Blob): Promise<ImageInspection> {
  const riff = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (riff.getUint32(4, true) + 8 !== blob.size) throw new ImageOptimizationError("corrupt");
  let offset = 12, hasImage = false, transparencyPossible = true;
  for (let count = 0; count < 1000 && offset + 8 <= blob.size; count++) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + 8).arrayBuffer());
    const name = decoder.decode(chunk.subarray(0, 4));
    const length = new DataView(chunk.buffer).getUint32(4, true);
    const next = offset + 8 + length + (length & 1);
    if (next > blob.size) throw new ImageOptimizationError("corrupt");
    if (name === "ANIM" || name === "ANMF") throw new ImageOptimizationError("animated");
    if (name === "VP8X") {
      if (length < 10) throw new ImageOptimizationError("corrupt");
      const flags = new Uint8Array(await blob.slice(offset + 8, offset + 9).arrayBuffer())[0];
      if (flags & 0x02) throw new ImageOptimizationError("animated");
      transparencyPossible = !!(flags & 0x10);
    }
    if (name === "VP8 " || name === "VP8L") hasImage = true;
    offset = next;
    if (offset === blob.size) break;
  }
  if (!hasImage || offset !== blob.size) throw new ImageOptimizationError("corrupt");
  return { kind: "webp", orientation: 1, transparencyPossible };
}

export async function inspectImage(blob: Blob): Promise<ImageInspection> {
  if (!blob.size) throw new ImageOptimizationError("corrupt");
  if (blob.size > MAX_IMAGE_SOURCE_BYTES) throw new ImageOptimizationError("too_large");
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 524_288)).arrayBuffer());
  let kind: ImageKind;
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) kind = "jpeg";
  else if (head.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => head[index] === value)) kind = "png";
  else if (head.length >= 12 && decoder.decode(head.subarray(0, 4)) === "RIFF" && decoder.decode(head.subarray(8, 12)) === "WEBP") kind = "webp";
  else if (head.length >= 6 && /^GIF8[79]a$/.test(decoder.decode(head.subarray(0, 6)))) kind = "gif";
  else if (head.length >= 12 && decoder.decode(head.subarray(4, 8)) === "ftyp" && /^(heic|heix|hevc|hevx|heif|mif1)$/.test(decoder.decode(head.subarray(8, 12)))) kind = "heic";
  else throw new ImageOptimizationError("unsupported");
  const declared = blob.type.toLowerCase();
  const matches: Record<ImageKind, string[]> = { jpeg: ["image/jpeg", "image/jpg"], png: ["image/png"],
    webp: ["image/webp"], gif: ["image/gif"], heic: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"] };
  if (declared && declared !== "application/octet-stream" && !matches[kind].includes(declared)) throw new ImageOptimizationError("unsupported");
  if (kind === "jpeg") return inspectJpeg(head);
  if (kind === "png") return inspectPng(blob, head);
  if (kind === "gif") return inspectGif(blob);
  if (kind === "webp") return inspectWebp(blob);
  return { kind: "heic", orientation: 1, transparencyPossible: true };
}
