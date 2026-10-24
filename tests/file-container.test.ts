import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { V1_CHUNK_BYTES, v1ChunkRange } from "../src/lib/crypto/format-v1";
import { assertStoredByteLimit, blobCiphertextSource, estimateEncryptedFileBytes, openEncryptedContainer, prepareEncryptedFile, prepareEncryptedThumbnail, type CiphertextSource, type MetadataInput } from "../src/lib/crypto/file-container";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";

const vaultId = Buffer.from(randomBytes(16)).toString("base64url");
const root = new Uint8Array(randomBytes(32));
const metadata: MetadataInput = { storedName: "private-photo.jpg", extension: "jpg", mimeType: "image/jpeg" };

function unlock(): void { installVaultRootKey(root, vaultId); }
async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}
function blobOf(chunks: Uint8Array[]): Blob { return new Blob(chunks.map((chunk) => Buffer.from(chunk))); }
async function fixture(plain: Uint8Array, category: "image" | "video" = "video") {
  unlock();
  const prepared = await prepareEncryptedFile(blobOf([plain]), metadata, category);
  assert.equal(estimateEncryptedFileBytes(plain.length, metadata).toString(), prepared.manifest.objectBytes);
  const cipher = blobOf(await collect(prepared.chunks()));
  assert.equal(BigInt(cipher.size), BigInt(prepared.manifest.objectBytes));
  return { cipher, manifest: prepared.manifest };
}
function changed(blob: Blob, index: number): Promise<Blob> {
  return blob.arrayBuffer().then((buffer) => { const bytes = new Uint8Array(buffer); bytes[index] ^= 1; return blobOf([bytes]); });
}

test("multi-chunk round trip, exact ranges, separate authenticated metadata and digest", async () => {
  const plain = new Uint8Array(2 * V1_CHUNK_BYTES + 7);
  for (let i = 0; i < plain.length; i++) plain[i] = i % 251;
  const { cipher, manifest } = await fixture(plain);
  const reads: Array<[bigint, bigint]> = [];
  const base = blobCiphertextSource(cipher);
  const source: CiphertextSource = { size: base.size, async read(start, end) { reads.push([start, end]); return base.read(start, end); } };
  const opened = await openEncryptedContainer(source, manifest);
  assert.equal(opened.metadata.storedName, metadata.storedName);
  const third = await opened.decryptChunk(2);
  assert.deepEqual(third, plain.slice(2 * V1_CHUNK_BYTES));
  const all = Buffer.concat((await collect(opened.chunks())).map(Buffer.from));
  assert.deepEqual(all, Buffer.from(plain));
  assert.equal(reads.length, 6); // header, metadata, one seek, three full-file chunks
  const metaLength = new DataView(Buffer.from(manifest.header, "base64url").buffer, Buffer.from(manifest.header, "base64url").byteOffset).getUint32(72);
  const range = v1ChunkRange({ plaintextLength: BigInt(plain.length), metadataCiphertextLength: metaLength, chunkCount: 3 }, 2);
  assert.deepEqual(reads[2], [range.start, range.endInclusive + BigInt(1)]);
  assert.equal(reads.slice(2).every(([start, end]) => end - start <= BigInt(V1_CHUNK_BYTES + 16)), true);
  clearVaultKeyMaterial();
});

test("empty file still has a content authentication tag; thumbnail has independent key and variant", async () => {
  const { cipher, manifest } = await fixture(new Uint8Array(), "image");
  const opened = await openEncryptedContainer(blobCiphertextSource(cipher), manifest);
  assert.deepEqual(await collect(opened.chunks()), [new Uint8Array()]);
  const thumb = await prepareEncryptedThumbnail(blobOf([new Uint8Array([1, 2, 3])]), metadata, manifest);
  const thumbBlob = blobOf(await collect(thumb.chunks()));
  const mainHeader = Buffer.from(manifest.header, "base64url"), thumbHeader = Buffer.from(thumb.manifest.header, "base64url");
  assert.deepEqual(thumbHeader.subarray(16, 32), mainHeader.subarray(16, 32));
  assert.notDeepEqual(thumbHeader.subarray(32, 48), mainHeader.subarray(32, 48));
  assert.notDeepEqual(thumbHeader.subarray(64, 72), mainHeader.subarray(64, 72));
  assert.notDeepEqual(thumb.manifest.wrappedKey.ciphertext, manifest.wrappedKey.ciphertext);
  const reopened = await openEncryptedContainer(blobCiphertextSource(thumbBlob), thumb.manifest);
  assert.deepEqual(await collect(reopened.chunks()), [new Uint8Array([1, 2, 3])]);
  clearVaultKeyMaterial();
});

test("exact chunk boundary creates one chunk and does not expose the encrypted filename", async () => {
  const { cipher, manifest } = await fixture(new Uint8Array(V1_CHUNK_BYTES));
  const header = Buffer.from(manifest.header, "base64url");
  assert.equal(header.readUInt32BE(60), 1);
  assert.equal(Buffer.from(await cipher.arrayBuffer()).includes(Buffer.from(metadata.storedName)), false);
  const opened = await openEncryptedContainer(blobCiphertextSource(cipher), manifest);
  assert.equal((await collect(opened.chunks())).length, 1);
  clearVaultKeyMaterial();
});

test("tampered header, metadata, chunk, wrap, wrong key, truncation and trailing bytes fail closed", async () => {
  const { cipher, manifest } = await fixture(new Uint8Array([10, 20, 30]));
  for (const offset of [0, 80, cipher.size - 1]) {
    const corrupt = await changed(cipher, offset);
    if (offset === cipher.size - 1) {
      const opened = await openEncryptedContainer(blobCiphertextSource(corrupt), manifest);
      await assert.rejects(collect(opened.chunks()));
    } else await assert.rejects(openEncryptedContainer(blobCiphertextSource(corrupt), manifest));
  }
  await assert.rejects(openEncryptedContainer(blobCiphertextSource(cipher.slice(0, -1)), manifest));
  await assert.rejects(openEncryptedContainer(blobCiphertextSource(new Blob([cipher, Buffer.from([0])])), manifest));
  const wrap = { ...manifest.wrappedKey, ciphertext: `${manifest.wrappedKey.ciphertext[0] === "A" ? "B" : "A"}${manifest.wrappedKey.ciphertext.slice(1)}` };
  await assert.rejects(openEncryptedContainer(blobCiphertextSource(cipher), { ...manifest, wrappedKey: wrap }));
  await assert.rejects(openEncryptedContainer(blobCiphertextSource(cipher), { ...manifest, version: 2 }));
  await assert.rejects(openEncryptedContainer(blobCiphertextSource(cipher), { ...manifest, objectBytes: String(cipher.size - 1) }));
  installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
  await assert.rejects(openEncryptedContainer(blobCiphertextSource(cipher), manifest));
  clearVaultKeyMaterial();
});

test("a guessed chunk URL cannot bypass length checks; lock invalidates active readers and writers", async () => {
  const { cipher, manifest } = await fixture(new Uint8Array(32));
  const base = blobCiphertextSource(cipher);
  const short: CiphertextSource = { size: base.size, read: async (start, end) => base.read(start, end - BigInt(1)) };
  await assert.rejects(openEncryptedContainer(short, manifest));
  const opened = await openEncryptedContainer(base, manifest);
  clearVaultKeyMaterial();
  await assert.rejects(opened.decryptChunk(0));
  unlock();
  const prepared = await prepareEncryptedFile(blobOf([new Uint8Array(32)]), metadata, "image");
  const iterator = prepared.chunks()[Symbol.asyncIterator]();
  await iterator.next();
  clearVaultKeyMaterial();
  await assert.rejects(iterator.next());
});

test("a swapped or incomplete chunk range cannot decrypt at a different offset", async () => {
  const { cipher, manifest } = await fixture(new Uint8Array(V1_CHUNK_BYTES + 1));
  const base = blobCiphertextSource(cipher);
  const header = Buffer.from(manifest.header, "base64url");
  const metaLength = header.readUInt32BE(72);
  const layout = { plaintextLength: BigInt(V1_CHUNK_BYTES + 1), metadataCiphertextLength: metaLength, chunkCount: 2 };
  const first = v1ChunkRange(layout, 0), second = v1ChunkRange(layout, 1);
  const swapped: CiphertextSource = { size: base.size, read: async (start, end) =>
    start === second.start ? base.read(first.start, first.start + (end - start)) : base.read(start, end) };
  const opened = await openEncryptedContainer(swapped, manifest);
  await assert.rejects(opened.decryptChunk(1));
  opened.close();
  const partial: CiphertextSource = { size: base.size, read: async (start, end) =>
    start === second.start ? base.read(start, end - BigInt(1)) : base.read(start, end) };
  const openedPartial = await openEncryptedContainer(partial, manifest);
  await assert.rejects(openedPartial.decryptChunk(1));
  openedPartial.close();
  clearVaultKeyMaterial();
});

test("actual framing overhead determines strict decimal image and video caps", async () => {
  unlock();
  const empty = await prepareEncryptedFile(new Blob([]), metadata, "image");
  const overhead = Number(empty.manifest.objectBytes);
  empty.dispose();
  const max = 999_999 - overhead;
  const allowed = await prepareEncryptedFile(new Blob([Buffer.alloc(max)]), metadata, "image");
  assert.equal(Number(allowed.manifest.objectBytes), 999_999);
  allowed.dispose();
  await assert.rejects(prepareEncryptedFile(new Blob([Buffer.alloc(max + 1)]), metadata, "image"), (error: unknown) => (error as { code?: string }).code === "size_limit");
  assert.doesNotThrow(() => assertStoredByteLimit("video", BigInt(99_999_999)));
  assert.throws(() => assertStoredByteLimit("video", BigInt(100_000_000)));
  clearVaultKeyMaterial();
});

test("plaintext reads stay within one chunk and encrypted output is single use", async () => {
  unlock();
  const plain = blobOf([new Uint8Array(V1_CHUNK_BYTES + 1)]);
  const reads: Array<[number, number]> = [];
  const tracked = new Proxy(plain, { get(target, property) {
    if (property === "size") return target.size;
    if (property === "slice") return (start: number, end: number) => { reads.push([start, end]); return target.slice(start, end); };
    return Reflect.get(target, property, target);
  } }) as Blob;
  const prepared = await prepareEncryptedFile(tracked, metadata, "video");
  await collect(prepared.chunks());
  assert.equal(reads.length, 4);
  assert.equal(reads.every(([start, end]) => end - start <= V1_CHUNK_BYTES), true);
  await assert.rejects(collect(prepared.chunks()));
  clearVaultKeyMaterial();
});
