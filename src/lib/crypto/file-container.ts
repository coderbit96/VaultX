import { createSHA256 } from "hash-wasm";
import { z } from "zod";
import { V1_CHUNK_BYTES, V1_HEADER_BYTES, V1_MAX_METADATA_CIPHER_BYTES, V1_TAG_BYTES, v1ChunkCount, v1ChunkRange, v1ObjectBytes, type V1Layout } from "./format-v1";
import { assertVaultKeyActive, leaseVaultRootKey, registerVaultKeyBuffer } from "./key-memory";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAGIC = encoder.encode("VAULTX01");
const META_DOMAIN = encoder.encode("VaultX/meta/v1\0");
const CHUNK_DOMAIN = encoder.encode("VaultX/chunk/v1\0");
const WRAP_DOMAIN = encoder.encode("VaultX/file-key/v1\0");
const WRAP_AAD_DOMAIN = encoder.encode("VaultX/file-key-aad/v1\0");
const ZERO_VARIANT = new Uint8Array(16);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type EncryptedKind = "file" | "thumbnail";
export type MediaCategory = "image" | "video" | "document" | "other";

const encoded16 = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const encoded32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const encoded12 = z.string().regex(/^[A-Za-z0-9_-]{16}$/);
const encoded48 = z.string().regex(/^[A-Za-z0-9_-]{64}$/);
export const fileManifestSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["file", "thumbnail"]),
  vaultId: encoded16,
  header: z.string().regex(/^[A-Za-z0-9_-]{107}$/),
  objectBytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
  wrappedKey: z.strictObject({ version: z.literal(1), revision: z.literal(1), salt: encoded32, nonce: encoded12, ciphertext: encoded48 }),
});
export type FileManifest = z.infer<typeof fileManifestSchema>;

const metadataSchema = z.strictObject({
  version: z.literal(1),
  storedName: z.string().min(1).max(255),
  extension: z.string().max(16).regex(/^[a-zA-Z0-9]*$/),
  mimeType: z.string().min(1).max(127),
  sha256: encoded32,
});
export type FileMetadata = z.infer<typeof metadataSchema>;
export type MetadataInput = Omit<FileMetadata, "version" | "sha256">;

// The digest is always 32 bytes (43 base64url characters), so this JSON has
// exactly the same byte length as the eventual authenticated metadata.
export function estimateEncryptedFileBytes(plaintextBytes: number, input: MetadataInput): bigint {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0) throw new FileContainerError("invalid_input");
  const parsed = metadataSchema.safeParse({ version: 1, ...input, sha256: "A".repeat(43) });
  if (!parsed.success) throw new FileContainerError("invalid_input");
  const metadataLength = encoder.encode(JSON.stringify(parsed.data)).length + V1_TAG_BYTES;
  if (metadataLength > V1_MAX_METADATA_CIPHER_BYTES) throw new FileContainerError("invalid_input");
  const length = BigInt(plaintextBytes);
  return v1ObjectBytes({ plaintextLength: length, metadataCiphertextLength: metadataLength, chunkCount: v1ChunkCount(length) });
}

export class FileContainerError extends Error {
  constructor(readonly code: "invalid_container" | "locked" | "size_limit" | "invalid_input") {
    super(code);
    this.name = "FileContainerError";
  }
}

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function encoded(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decoded(value: string, length: number): Uint8Array {
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    if (bytes.length !== length || encoded(bytes) !== value) throw new Error();
    return bytes;
  } catch { throw new FileContainerError("invalid_container"); }
}
function random(length: number): Uint8Array { return crypto.getRandomValues(new Uint8Array(length)); }
function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes; }
function u64(value: bigint): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value); return bytes; }
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, i) => value === b[i]); }
async function digest(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)); }

async function sha256Blob(blob: Blob, check: () => void): Promise<Uint8Array> {
  const hasher = await createSHA256();
  hasher.init();
  for (let offset = 0; offset < blob.size; offset += V1_CHUNK_BYTES) {
    check();
    const end = Math.min(blob.size, offset + V1_CHUNK_BYTES);
    const part = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    try {
      check();
      if (part.length !== end - offset) throw new FileContainerError("invalid_input");
      hasher.update(part);
    }
    finally { part.fill(0); }
  }
  return hasher.digest("binary");
}
function nonce(prefix: Uint8Array, index: number): Uint8Array { return join(prefix, u32(index)); }
function chunkAad(header: Uint8Array, index: number, plaintextLength: number): Uint8Array {
  return join(CHUNK_DOMAIN, header, u32(index), u64(BigInt(index) * BigInt(V1_CHUNK_BYTES)), u32(plaintextLength));
}
async function aes(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, bytes: Uint8Array, operation: "encrypt" | "decrypt"): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [operation]);
  const params = { name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 };
  return new Uint8Array(operation === "encrypt"
    ? await crypto.subtle.encrypt(params, imported, bytes as BufferSource)
    : await crypto.subtle.decrypt(params, imported, bytes as BufferSource));
}
async function wrapKey(root: Uint8Array, vaultId: Uint8Array, header: Uint8Array, key: Uint8Array): Promise<FileManifest["wrappedKey"]> {
  const salt = random(32), iv = random(12);
  const hkdf = await crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveBits"]);
  const wrappingKey = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource,
    info: join(WRAP_DOMAIN, vaultId, header.slice(16, 48), u32(1)) as BufferSource }, hkdf, 256));
  try {
    const ciphertext = await aes(wrappingKey, iv, join(WRAP_AAD_DOMAIN, vaultId, await digest(header), u32(1)), key, "encrypt");
    return { version: 1, revision: 1, salt: encoded(salt), nonce: encoded(iv), ciphertext: encoded(ciphertext) };
  } finally { wrappingKey.fill(0); }
}
async function unwrapKey(root: Uint8Array, vaultId: Uint8Array, header: Uint8Array, wrap: FileManifest["wrappedKey"]): Promise<Uint8Array> {
  const hkdf = await crypto.subtle.importKey("raw", root as BufferSource, "HKDF", false, ["deriveBits"]);
  const wrappingKey = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: decoded(wrap.salt, 32) as BufferSource,
    info: join(WRAP_DOMAIN, vaultId, header.slice(16, 48), u32(wrap.revision)) as BufferSource }, hkdf, 256));
  try { return await aes(wrappingKey, decoded(wrap.nonce, 12), join(WRAP_AAD_DOMAIN, vaultId, await digest(header), u32(wrap.revision)), decoded(wrap.ciphertext, 48), "decrypt"); }
  finally { wrappingKey.fill(0); }
}

function makeHeader(kind: EncryptedKind, fileId: Uint8Array, variantId: Uint8Array, length: bigint, metadataLength: number, prefix: Uint8Array): Uint8Array {
  const header = new Uint8Array(V1_HEADER_BYTES), view = new DataView(header.buffer);
  header.set(MAGIC); view.setUint16(8, 1); view.setUint16(10, kind === "file" ? 1 : 2);
  view.setUint32(12, V1_HEADER_BYTES); header.set(fileId, 16); header.set(variantId, 32);
  view.setBigUint64(48, length); view.setUint32(56, V1_CHUNK_BYTES); view.setUint32(60, v1ChunkCount(length));
  header.set(prefix, 64); view.setUint32(72, metadataLength);
  return header;
}
function parseHeader(header: Uint8Array, kind: EncryptedKind): { layout: V1Layout; prefix: Uint8Array } {
  if (header.length !== V1_HEADER_BYTES || !equal(header.slice(0, 8), MAGIC)) throw new FileContainerError("invalid_container");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const length = view.getBigUint64(48), metadataCiphertextLength = view.getUint32(72);
  if (view.getUint16(8) !== 1 || view.getUint16(10) !== (kind === "file" ? 1 : 2)
    || view.getUint32(12) !== V1_HEADER_BYTES || view.getUint32(56) !== V1_CHUNK_BYTES
    || view.getUint32(76) !== 0 || (kind === "file" ? !equal(header.slice(32, 48), ZERO_VARIANT) : equal(header.slice(32, 48), ZERO_VARIANT))
    || length > MAX_SAFE || metadataCiphertextLength < V1_TAG_BYTES || metadataCiphertextLength > V1_MAX_METADATA_CIPHER_BYTES) throw new FileContainerError("invalid_container");
  try { if (view.getUint32(60) !== v1ChunkCount(length)) throw new Error(); }
  catch { throw new FileContainerError("invalid_container"); }
  return { layout: { plaintextLength: length, metadataCiphertextLength, chunkCount: view.getUint32(60) }, prefix: header.slice(64, 72) };
}

export function assertStoredByteLimit(category: MediaCategory, bytes: bigint): void {
  if (!["image", "video", "document", "other"].includes(category)) throw new FileContainerError("invalid_input");
  // The verified Free account raw-object cap is 10 MiB. Keep non-media
  // encrypted objects below a conservative decimal ceiling.
  const limit = category === "image" ? BigInt(1_000_000) : category === "video" ? BigInt(100_000_000) : BigInt(10_000_000);
  if (bytes < BigInt(0) || bytes >= limit) throw new FileContainerError("size_limit");
}

export interface PreparedContainer {
  readonly manifest: FileManifest;
  chunks(): AsyncIterable<Uint8Array>;
  dispose(): void;
}

async function prepare(blob: Blob, input: MetadataInput, kind: EncryptedKind, category: MediaCategory, fileId?: Uint8Array, signal?: AbortSignal): Promise<PreparedContainer> {
  if (!Number.isSafeInteger(blob.size) || blob.size < 0 || (kind === "thumbnail" && category !== "image") || (kind === "file" && !!fileId)) throw new FileContainerError("invalid_input");
  const parsedInput = metadataSchema.omit({ version: true, sha256: true }).safeParse(input);
  if (!parsedInput.success) throw new FileContainerError("invalid_input");
  assertStoredByteLimit(category, v1ObjectBytes({ plaintextLength: BigInt(blob.size), metadataCiphertextLength: V1_TAG_BYTES, chunkCount: v1ChunkCount(BigInt(blob.size)) }));
  const lease = leaseVaultRootKey();
  const check = () => { if (signal?.aborted) throw new FileContainerError("invalid_input"); try { assertVaultKeyActive(lease.generation, lease.vaultId); } catch { throw new FileContainerError("locked"); } };
  let key: Uint8Array | undefined;
  let unregister: (() => void) | undefined;
  let metadataBytes: Uint8Array | undefined;
  try {
    check();
    const hash = await sha256Blob(blob, check);
    const metadata = metadataSchema.parse({ version: 1, ...parsedInput.data, sha256: encoded(hash) });
    hash.fill(0);
    metadataBytes = encoder.encode(JSON.stringify(metadata));
    const metadataLength = metadataBytes.length + V1_TAG_BYTES;
    if (metadataLength > V1_MAX_METADATA_CIPHER_BYTES) throw new FileContainerError("invalid_input");
    const layout = { plaintextLength: BigInt(blob.size), metadataCiphertextLength: metadataLength, chunkCount: v1ChunkCount(BigInt(blob.size)) };
    const expected = v1ObjectBytes(layout);
    if (expected !== estimateEncryptedFileBytes(blob.size, parsedInput.data)) throw new FileContainerError("invalid_container");
    assertStoredByteLimit(category, expected);
    const objectId = fileId ?? random(16);
    const variant = kind === "file" ? ZERO_VARIANT : random(16);
    if (kind === "thumbnail" && equal(variant, ZERO_VARIANT)) throw new FileContainerError("invalid_input");
    const prefix = random(8);
    const header = makeHeader(kind, objectId, variant, BigInt(blob.size), metadataLength, prefix);
    key = random(32);
    unregister = registerVaultKeyBuffer(key);
    const wrappedKey = await wrapKey(lease.key, decoded(lease.vaultId, 16), header, key);
    check();
    const manifest = fileManifestSchema.parse({ version: 1, kind, vaultId: lease.vaultId, header: encoded(header), objectBytes: expected.toString(), wrappedKey });
    let used = false;
    let disposed = false;
    const contentKey = key;
    const encryptedMetadata = metadataBytes;
    const release = unregister;
    const dispose = () => { if (!disposed) { disposed = true; contentKey.fill(0); release(); encryptedMetadata.fill(0); } };
    return {
      manifest, dispose,
      async *chunks() {
        if (used || disposed) throw new FileContainerError("invalid_input");
        used = true;
    let written = BigInt(0);
        try {
          check(); yield header.slice(); written += BigInt(header.length);
          const metaCipher = await aes(contentKey, nonce(prefix, 0xffff_ffff), join(META_DOMAIN, header), encryptedMetadata, "encrypt");
          check(); yield metaCipher; written += BigInt(metaCipher.length);
          for (let i = 0; i < layout.chunkCount; i++) {
            check();
            const start = i * V1_CHUNK_BYTES, end = Math.min(blob.size, start + V1_CHUNK_BYTES);
            const plain = new Uint8Array(await blob.slice(start, end).arrayBuffer());
            let encrypted: Uint8Array;
            try {
              check();
              if (plain.length !== end - start) throw new FileContainerError("invalid_input");
              encrypted = await aes(contentKey, nonce(prefix, i), chunkAad(header, i, plain.length), plain, "encrypt");
            }
            finally { plain.fill(0); }
            check(); yield encrypted; written += BigInt(encrypted.length);
          }
          if (written !== expected) throw new FileContainerError("invalid_container");
        } finally { dispose(); }
      },
    };
  } catch (error) {
    metadataBytes?.fill(0);
    key?.fill(0); unregister?.();
    throw error;
  } finally { lease.release(); }
}

export function prepareEncryptedFile(blob: Blob, metadata: MetadataInput, category: MediaCategory, signal?: AbortSignal): Promise<PreparedContainer> {
  return prepare(blob, metadata, "file", category, undefined, signal);
}
export function prepareEncryptedThumbnail(blob: Blob, metadata: MetadataInput, parent: FileManifest, signal?: AbortSignal): Promise<PreparedContainer> {
  const parsed = fileManifestSchema.safeParse(parent);
  if (!parsed.success || parsed.data.kind !== "file") throw new FileContainerError("invalid_input");
  const lease = leaseVaultRootKey();
  try {
    if (lease.vaultId !== parsed.data.vaultId) throw new FileContainerError("invalid_input");
    const header = decoded(parsed.data.header, V1_HEADER_BYTES);
    parseHeader(header, "file");
    return prepare(blob, metadata, "thumbnail", "image", header.slice(16, 32), signal);
  } finally { lease.release(); }
}

export interface CiphertextSource {
  readonly size: bigint;
  read(start: bigint, endExclusive: bigint): Promise<Uint8Array>;
}
export function blobCiphertextSource(blob: Blob): CiphertextSource {
  return { size: BigInt(blob.size), async read(start, endExclusive) {
    if (start < BigInt(0) || endExclusive < start || endExclusive > BigInt(blob.size) || endExclusive > MAX_SAFE) throw new FileContainerError("invalid_container");
    return new Uint8Array(await blob.slice(Number(start), Number(endExclusive)).arrayBuffer());
  } };
}
export interface OpenContainer {
  readonly metadata: FileMetadata;
  readonly plaintextLength: bigint;
  decryptChunk(index: number): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
  close(): void;
}
export async function openEncryptedContainer(source: CiphertextSource, input: unknown, signal?: AbortSignal): Promise<OpenContainer> {
  const parsed = fileManifestSchema.safeParse(input);
  if (!parsed.success) throw new FileContainerError("invalid_container");
  const manifest = parsed.data;
  const header = decoded(manifest.header, V1_HEADER_BYTES);
  const { layout, prefix } = parseHeader(header, manifest.kind);
  const expected = v1ObjectBytes(layout);
  if (source.size !== expected || manifest.objectBytes !== expected.toString()) throw new FileContainerError("invalid_container");
  const lease = leaseVaultRootKey();
  const check = () => { if (signal?.aborted) throw new FileContainerError("invalid_input"); try { assertVaultKeyActive(lease.generation, lease.vaultId); } catch { throw new FileContainerError("locked"); } };
  let key: Uint8Array | undefined;
  let unregister: (() => void) | undefined;
  try {
    if (lease.vaultId !== manifest.vaultId) throw new FileContainerError("invalid_container");
    check();
    const onDiskHeader = await source.read(BigInt(0), BigInt(V1_HEADER_BYTES));
    if (!equal(onDiskHeader, header)) throw new FileContainerError("invalid_container");
    key = await unwrapKey(lease.key, decoded(manifest.vaultId, 16), header, manifest.wrappedKey);
    if (key.length !== 32) throw new FileContainerError("invalid_container");
    unregister = registerVaultKeyBuffer(key);
    const metaCipher = await source.read(BigInt(V1_HEADER_BYTES), BigInt(V1_HEADER_BYTES + layout.metadataCiphertextLength));
    if (metaCipher.length !== layout.metadataCiphertextLength) throw new FileContainerError("invalid_container");
    const metaPlain = await aes(key, nonce(prefix, 0xffff_ffff), join(META_DOMAIN, header), metaCipher, "decrypt");
    let metadata: FileMetadata;
    try { check(); metadata = metadataSchema.parse(JSON.parse(decoder.decode(metaPlain))); decoded(metadata.sha256, 32); }
    catch { throw new FileContainerError("invalid_container"); }
    finally { metaPlain.fill(0); }
    let closed = false;
    const contentKey = key;
    const release = unregister;
    const close = () => { if (!closed) { closed = true; contentKey.fill(0); release(); } };
    const decryptChunk = async (index: number): Promise<Uint8Array> => {
      if (closed) throw new FileContainerError("locked");
      check();
      const range = v1ChunkRange(layout, index);
      const bytes = await source.read(range.start, range.endInclusive + BigInt(1));
      const expectedLength = Number(range.endInclusive - range.start + BigInt(1));
      if (bytes.length !== expectedLength) throw new FileContainerError("invalid_container");
      try {
        const plain = await aes(contentKey, nonce(prefix, index), chunkAad(header, index, expectedLength - V1_TAG_BYTES), bytes, "decrypt");
        try { check(); }
        catch (error) { plain.fill(0); throw error; }
        return plain;
      } catch (error) { if (error instanceof FileContainerError) throw error; throw new FileContainerError("invalid_container"); }
    };
    return { metadata, plaintextLength: layout.plaintextLength, decryptChunk, close,
      async *chunks() {
        const hasher = await createSHA256(); hasher.init();
        try {
          for (let i = 0; i < layout.chunkCount; i++) { const plain = await decryptChunk(i); hasher.update(plain); yield plain; }
          if (!equal(hasher.digest("binary"), decoded(metadata.sha256, 32))) throw new FileContainerError("invalid_container");
        } finally { close(); }
      },
    };
  } catch (error) {
    key?.fill(0); unregister?.();
    if (error instanceof FileContainerError) throw error;
    throw new FileContainerError("invalid_container");
  } finally { lease.release(); }
}
import "./zod-csp";
