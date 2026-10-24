import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  V1_CHUNK_BYTES,
  V1_METADATA_NONCE_INDEX,
  v1ChunkCount,
  v1ChunkRange,
  v1ObjectBytes,
} from "../src/lib/crypto/format-v1";

test("v1 golden offset vector: two full chunks and a seven-byte tail", () => {
  const layout = { plaintextLength: BigInt(2 * V1_CHUNK_BYTES + 7), metadataCiphertextLength: 32, chunkCount: 3 };
  assert.equal(v1ChunkCount(layout.plaintextLength), 3);
  assert.deepEqual(v1ChunkRange(layout, 0), { start: BigInt(112), endInclusive: BigInt(1_048_703) });
  assert.deepEqual(v1ChunkRange(layout, 1), { start: BigInt(1_048_704), endInclusive: BigInt(2_097_295) });
  assert.deepEqual(v1ChunkRange(layout, 2), { start: BigInt(2_097_296), endInclusive: BigInt(2_097_318) });
  assert.equal(v1ObjectBytes(layout), BigInt(2_097_319));
});

test("empty plaintext still has one authenticated tag", () => {
  const layout = { plaintextLength: BigInt(0), metadataCiphertextLength: 16, chunkCount: 1 };
  assert.equal(v1ChunkCount(BigInt(0)), 1);
  assert.deepEqual(v1ChunkRange(layout, 0), { start: BigInt(96), endInclusive: BigInt(111) });
  assert.equal(v1ObjectBytes(layout), BigInt(112));
});

test("image limit includes the header, encrypted metadata and tag", () => {
  const base = { metadataCiphertextLength: 32, chunkCount: 1 };
  assert.equal(v1ObjectBytes({ ...base, plaintextLength: BigInt(999_871) }), BigInt(999_999));
  assert.equal(v1ObjectBytes({ ...base, plaintextLength: BigInt(999_872) }), BigInt(1_000_000));
});

test("invalid counts, lengths and reserved nonce index are rejected", () => {
  const layout = { plaintextLength: BigInt(10), metadataCiphertextLength: 16, chunkCount: 1 };
  assert.throws(() => v1ChunkRange({ ...layout, chunkCount: 2 }, 0), RangeError);
  assert.throws(() => v1ChunkRange({ ...layout, metadataCiphertextLength: 15 }, 0), RangeError);
  assert.throws(() => v1ChunkRange(layout, 1), RangeError);
  assert.throws(() => v1ChunkCount(BigInt(-1)), RangeError);
  assert.throws(() => v1ChunkCount(BigInt(V1_METADATA_NONCE_INDEX) * BigInt(V1_CHUNK_BYTES)), RangeError);
});

test("standard AES-256-GCM empty-message vector and AAD tampering", async () => {
  const key = await webcrypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const iv = new Uint8Array(12);
  const tag = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new Uint8Array()));
  assert.equal(Buffer.from(tag).toString("hex"), "530f8afbc74536b9a963b4f1c4cb738b");
  const aad = new Uint8Array([1, 2, 3]);
  const sealed = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, new Uint8Array([4]));
  assert.deepEqual(new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, sealed)), new Uint8Array([4]));
  await assert.rejects(webcrypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new Uint8Array([1, 2, 0]), tagLength: 128 }, key, sealed));
});
