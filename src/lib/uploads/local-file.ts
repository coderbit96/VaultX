import { estimateEncryptedFileBytes, type MediaCategory, type MetadataInput } from "@/lib/crypto/file-container";

export type LocalFileDecision = { category: MediaCategory; metadata: MetadataInput; downloadOnly: boolean };
const extensionPattern = /^[a-z0-9]{0,16}$/;
const documentExtensions = new Set(["pdf", "txt", "docx", "xlsx", "pptx"]);
const zipExtensions = new Set(["zip", "docx", "xlsx", "pptx"]);

function starts(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

export async function classifyOtherFile(file: File): Promise<LocalFileDecision> {
  if (!file.size) throw new Error("Empty files cannot be uploaded.");
  const name = file.name.normalize("NFC").replace(/[\\/\p{Cc}\p{Cf}]/gu, "").trim();
  const extension = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (!name || !extensionPattern.test(extension)) throw new Error("Use a file with a short, safe extension.");
  const stem = name.replace(/\.[^.]+$/, "");
  const storedName = extension ? `${[...stem].slice(0, 119 - extension.length).join("")}.${extension}` : [...name].slice(0, 120).join("");
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isPdf = starts(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  const isZip = starts(head, [0x50, 0x4b, 0x03, 0x04]);
  const isRar = starts(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]);
  const mediaClaim = /^(?:image|video)\//.test(file.type) ||
    ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "mp4", "mov", "webm"].includes(extension);
  if (mediaClaim) throw new Error("This media format needs a supported local processor before upload.");
  if ((extension === "pdf" && !isPdf) || (isPdf && extension !== "pdf")
    || (zipExtensions.has(extension) && !isZip)
    || (extension === "rar" && !isRar) || (isRar && extension !== "rar")) {
    throw new Error("The file signature does not match its extension.");
  }
  let mimeType = "application/octet-stream";
  if (isPdf) mimeType = "application/pdf";
  else if (isZip) mimeType = "application/zip";
  else if (isRar) mimeType = "application/vnd.rar";
  else if (extension === "txt") {
    try {
      const sample = new Uint8Array(await file.slice(0, Math.min(file.size, 65_536)).arrayBuffer());
      new TextDecoder("utf-8", { fatal: true }).decode(sample);
      if (sample.some((byte) => byte === 0)) throw new Error();
      mimeType = "text/plain";
    } catch { throw new Error("This text file is not valid UTF-8."); }
  }
  // Office files are ZIP containers. The subtype is deliberately not trusted;
  // they are stored as download-only opaque data.
  const category = documentExtensions.has(extension) ? "document" : "other";
  const metadata = { storedName, extension, mimeType };
  if (estimateEncryptedFileBytes(file.size, metadata) >= BigInt(10_000_000)) {
    throw new Error("This encrypted file would exceed the current 10 MB storage limit.");
  }
  return { category, metadata, downloadOnly: true };
}
