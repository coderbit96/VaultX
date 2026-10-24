import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import { cloudinaryCiphertextUploadOptions, inspectUploadManifest, reserveUploadIntent, uploadInitInput } from "../src/lib/cloudinary/upload-intent";
import { v1ChunkCount } from "../src/lib/crypto/format-v1";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath } from "../src/lib/auth/api-policy";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { uploadJobSchema } from "../src/lib/database/models";

const vaultId = Buffer.alloc(16, 7).toString("base64url");

function request(plainBytes: number, category: "image" | "video" = "image") {
  const header = Buffer.alloc(80);
  header.write("VAULTX01", 0, "ascii");
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt32BE(80, 12);
  header.writeBigUInt64BE(BigInt(plainBytes), 48);
  header.writeUInt32BE(1_048_576, 56);
  header.writeUInt32BE(v1ChunkCount(BigInt(plainBytes)), 60);
  header.writeUInt32BE(32, 72);
  return { category, folderId: null, manifest: { version: 1 as const, kind: "file" as const, vaultId,
    header: header.toString("base64url"), objectBytes: String(80 + 32 + plainBytes + 16 * v1ChunkCount(BigInt(plainBytes))),
    wrappedKey: { version: 1 as const, revision: 1 as const, salt: "A".repeat(43), nonce: "A".repeat(16), ciphertext: "A".repeat(64) } } };
}

test("upload init accepts only owner-only POST and no caller IDs or plaintext fields", () => {
  assert.equal(isEnabledPrivateApiPath("/api/uploads/init"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/init", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/init", "GET"), false);
  assert.equal(isEnabledPrivateApiPath("/api/uploads/complete"), true);
  assert.equal(isEnabledPrivateApiPath("/api/uploads/future/action"), false);
  const valid = request(1);
  assert.equal(uploadInitInput.safeParse(valid).success, true);
  for (const property of ["publicId", "ownerId", "fileId", "filename", "file", "apiSecret", "plaintextBytes"]) {
    assert.equal(uploadInitInput.safeParse({ ...valid, [property]: "forged" }).success, false);
  }
  assert.equal(uploadInitInput.safeParse({ ...valid, manifest: { ...valid.manifest, kind: "thumbnail" } }).success, false);
  assert.throws(() => inspectUploadManifest({ ...valid,
    thumbnailManifest: { ...valid.manifest, kind: "thumbnail" } }), { code: "invalid_request" });
});

test("thumbnail intent binds a separate encrypted preview to the parent file", () => {
  const valid = request(100);
  const header = Buffer.from(valid.manifest.header, "base64url");
  header.writeUInt16BE(2, 10);
  header[32] = 1;
  const thumbnailManifest = { ...valid.manifest, kind: "thumbnail" as const, header: header.toString("base64url") };
  assert.equal(inspectUploadManifest({ ...valid, thumbnailManifest }), 228);
  const wrongParent = Buffer.from(header); wrongParent[16] = 1;
  assert.throws(() => inspectUploadManifest({ ...valid, thumbnailManifest: { ...thumbnailManifest,
    header: wrongParent.toString("base64url") } }), { code: "invalid_request" });
  assert.throws(() => cloudinaryCiphertextUploadOptions("vaultx/thumbnails/not-opaque.dat"));
  assert.equal(cloudinaryCiphertextUploadOptions(`vaultx/thumbnails/${"a".repeat(48)}.dat`).type, "authenticated");
});

test("v1 header, declared bytes and strict ciphertext caps are checked", () => {
  assert.equal(inspectUploadManifest(request(999_871)), 999_999);
  assert.throws(() => inspectUploadManifest(request(999_872)));
  assert.equal(inspectUploadManifest(request(9_000_000, "video")), 9_000_256);
  const mismatch = request(10);
  assert.throws(() => inspectUploadManifest({ ...mismatch, manifest: { ...mismatch.manifest, objectBytes: "1" } }));
  const badHeader = Buffer.from(mismatch.manifest.header, "base64url");
  badHeader.writeUInt16BE(2, 8);
  assert.throws(() => inspectUploadManifest({ ...mismatch, manifest: { ...mismatch.manifest, header: badHeader.toString("base64url") } }));
  badHeader.writeUInt16BE(1, 8);
  badHeader[32] = 1;
  assert.throws(() => inspectUploadManifest({ ...mismatch, manifest: { ...mismatch.manifest, header: badHeader.toString("base64url") } }));
});

test("Cloudinary destination is opaque, raw/authenticated, and cannot overwrite", () => {
  const options = cloudinaryCiphertextUploadOptions(`vaultx/ciphertext/${"a".repeat(48)}.dat`);
  assert.deepEqual(options, { resource_type: "raw", type: "authenticated", public_id: `vaultx/ciphertext/${"a".repeat(48)}.dat`,
    overwrite: false, use_filename: false, unique_filename: false });
  assert.throws(() => cloudinaryCiphertextUploadOptions("public/file.dat"));
  assert.equal(modelIndexes.uploadJobs.some((index) => index.name === "cloud_object_unique" && index.unique), true);
});

test("durable reservation scopes owner, vault, quota and inventories the exact object", async () => {
  const ownerId = new ObjectId();
  const inserted: unknown[] = [];
  let vault: string | null = vaultId;
  let recent = 0;
  const db = {
    client: { withSession: async (fn: (session: object) => Promise<unknown>) => fn({ withTransaction: async (action: () => Promise<unknown>) => action() }) },
    collection(name: string) {
      if (name === "owners") return { updateOne: async () => ({ matchedCount: 1 }) };
      if (name === "vaultKeys") return { findOne: async () => vault ? { vaultId: vault } : null };
      if (name === "uploadJobs") return {
        countDocuments: async (filter: { createdAt?: unknown }) => filter.createdAt ? recent : 0,
        insertOne: async (record: unknown) => { inserted.push(record); },
      };
      return {};
    },
  } as unknown as Db;
  const job = await reserveUploadIntent(db, ownerId, request(100), new Date("2026-01-01T00:00:00Z"));
  assert.equal(inserted.length, 1);
  assert.equal(job.ownerId.equals(ownerId), true);
  assert.equal(job.folderId, null);
  assert.equal(job.status, "pending");
  assert.equal(job.ciphertextBytes, 228);
  assert.equal(job.intentExpiresAt?.toISOString(), "2026-01-01T00:10:00.000Z");
  assert.match(job.cloudAssets[0].publicId, /^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/);
  assert.equal(job.cloudAssets[0].cleanupCompleted, false);
  assert.equal(uploadJobSchema.safeParse({ ...job, cloudAssets: [{ ...job.cloudAssets[0], deliveryType: "private" }] }).success, false);
  assert.equal(uploadJobSchema.safeParse({ ...job, folderId: undefined }).success, false);
  assert.equal(JSON.stringify(job).includes("apiSecret"), false);
  vault = null;
  await assert.rejects(() => reserveUploadIntent(db, ownerId, request(100)), { code: "vault_setup_required" });
  assert.equal(inserted.length, 1);
  vault = Buffer.alloc(16, 8).toString("base64url");
  await assert.rejects(() => reserveUploadIntent(db, ownerId, request(100)));
  assert.equal(inserted.length, 1);
  vault = vaultId; recent = 20;
  await assert.rejects(() => reserveUploadIntent(db, ownerId, request(100)));
  assert.equal(inserted.length, 1);
});
