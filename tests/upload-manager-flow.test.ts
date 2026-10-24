import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { prepareEncryptedFile, prepareEncryptedThumbnail, type MediaCategory, type MetadataInput } from "../src/lib/crypto/file-container";
import { encryptFileName } from "../src/lib/crypto/file-names";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { uploadJobSchema, type UploadJob, type VaultFile } from "../src/lib/database/models";
import { completeUpload, type CompletionMetadata, type ProviderAsset, type UploadStore } from "../src/lib/uploads/lifecycle";
import { readCiphertextBody, transferCiphertext, type CiphertextTransferProvider } from "../src/lib/uploads/transfer";
import { classifyOtherFile } from "../src/lib/uploads/local-file";
import { isEnabledPrivateApiMethod } from "../src/lib/auth/api-policy";

function request(bytes: Uint8Array, declared = bytes.length): Request {
  return new Request("http://localhost/api/uploads/id/ciphertext", { method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-length": String(declared) },
    body: new Blob([Uint8Array.from(bytes)]) });
}

test("ciphertext route is explicitly enabled and bounded reader rejects truncated and oversized bodies", async () => {
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/abc/ciphertext", "PUT"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/abc/ciphertext", "GET"), false);
  await assert.rejects(readCiphertextBody(request(new Uint8Array(100), 101), 101));
  await assert.rejects(readCiphertextBody(request(new Uint8Array(101), 100), 100));
  await assert.rejects(readCiphertextBody(request(new Uint8Array(100)), 10_000_000));
});

test("image, video and other ciphertext reach one ready record only after provider verification", async () => {
  for (const category of ["image", "video", "document", "other"] as MediaCategory[]) {
    const vaultId = randomBytes(16).toString("base64url");
    installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
    const extension = category === "image" ? "webp" : category === "video" ? "mp4" : category === "document" ? "pdf" : "zip";
    const mimeType = category === "image" ? "image/webp" : category === "video" ? "video/mp4"
      : category === "document" ? "application/pdf" : "application/zip";
    const metadata: MetadataInput = { storedName: `saved.${extension}`, extension, mimeType };
    const plain = new Uint8Array([14, 29, 42, 57, 60]);
    const prepared = await prepareEncryptedFile(new Blob([plain]), metadata, category);
    const chunks: Uint8Array[] = [];
    for await (const chunk of prepared.chunks()) chunks.push(chunk);
    const cipher = Uint8Array.from(Buffer.concat(chunks));
    assert.equal(cipher.length, Number(prepared.manifest.objectBytes));
    assert.equal(Buffer.from(cipher).includes(Buffer.from(plain)), false);
    const ownerId = new ObjectId(), fileId = new ObjectId(), jobId = new ObjectId();
    const publicId = `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`;
    let job: UploadJob = uploadJobSchema.parse({ _id: jobId, ownerId, fileId, folderId: null, category,
      manifest: prepared.manifest, ciphertextBytes: cipher.length, intentExpiresAt: new Date("2030-01-01"),
      status: "pending", attempts: 0, cloudAssets: [{ publicId, resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false }],
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") });
    let ready: VaultFile | null = null;
    let remote: Uint8Array | null = null;
    let uploads = 0, inserts = 0;
    const identity = (): ProviderAsset => ({ assetId: "synthetic-asset", publicId,
      resourceType: "raw", deliveryType: "authenticated", format: "", bytes: remote!.length, version: 1 });
    const store: UploadStore = {
      async getJob(owner, id) { return owner.equals(ownerId) && id.equals(jobId) ? job : null; },
      async getReadyFile(owner, id) { return owner.equals(ownerId) && id.equals(fileId) ? ready : null; },
      async acquire(owner, id, operation, token, expiry, now, details) {
        if (!owner.equals(ownerId) || !id.equals(jobId) || !["pending", "failed", "retrying"].includes(job.status)) return null;
        job = { ...job, status: "running", operation, leaseToken: token, leaseExpiresAt: expiry,
          completionMetadata: details ?? job.completionMetadata, updatedAt: now };
        return job;
      },
      async recordAsset(_job, token, asset, now) {
        assert.equal(job.leaseToken, token);
        job = { ...job, status: "pending", operation: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
          cloudAssets: [{ ...job.cloudAssets[0], assetId: asset.assetId, version: asset.version }], updatedAt: now };
      },
      async commitReady(_job, token, file, now) {
        assert.equal(job.leaseToken, token); ready = file; inserts++;
        job = { ...job, status: "completed", operation: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: now };
      },
      async recordState(_job, token, status) { assert.equal(job.leaseToken, token); job = { ...job, status, operation: undefined, leaseToken: undefined, leaseExpiresAt: undefined }; },
      async requestCancel() { return false; },
    };
    const provider: CiphertextTransferProvider = {
      async upload(_asset, bytes) { remote = Uint8Array.from(bytes); uploads++; return identity(); },
      async lookup() { return remote ? identity() : null; },
      async readHeader() { return remote!.subarray(0, 80); },
      async destroy() { remote = null; },
    };
    const completion: CompletionMetadata = { nameEncrypted: await encryptFileName(fileId.toHexString(), metadata.storedName),
      sourceNameEncrypted: await encryptFileName(fileId.toHexString(), `original.${extension}`),
      extension, mimeType, ...(category === "image" ? { width: 2, height: 2 } : {}),
      ...(category === "video" ? { width: 2, height: 2, durationSeconds: 1 } : {}) };
    assert.equal(await transferCiphertext(store, provider, ownerId, jobId, request(cipher), new Date("2026-01-02")), "transferred");
    assert.equal(uploads, 1);
    assert.equal((await completeUpload(store, provider, ownerId, jobId, completion, new Date("2026-01-02"))).status, "completed");
    assert.equal((await completeUpload(store, provider, ownerId, jobId, completion, new Date("2026-01-02"))).status, "completed");
    assert.equal(inserts, 1);
    assert.equal((ready as VaultFile | null)?.storedSizeBytes, cipher.length);
    assert.deepEqual((ready as VaultFile | null)?.sourceNameEncrypted, completion.sourceNameEncrypted);
    clearVaultKeyMaterial();
  }
});

test("other-file inspection checks signatures and uses download-only format", async () => {
  const pdf = new File(["%PDF-1.7\ncontent\n%%EOF"], "note.pdf", { type: "application/pdf" });
  const result = await classifyOtherFile(pdf);
  assert.equal(result.category, "document"); assert.equal(result.metadata.mimeType, "application/pdf");
  assert.equal(result.downloadOnly, true);
  await assert.rejects(classifyOtherFile(new File(["invalid"], "note.pdf", { type: "application/pdf" })));
  const unknown = await classifyOtherFile(new File([new Uint8Array([3, 4, 5])], "data.bin"));
  assert.equal(unknown.metadata.mimeType, "application/octet-stream");
  await assert.rejects(classifyOtherFile(new File([new Uint8Array(10_000_000)], "huge.bin")));
});

test("separate encrypted thumbnail transfers into its reserved identity without overwriting the main object", async () => {
  const vaultId = randomBytes(16).toString("base64url");
  installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
  try {
    const main = await prepareEncryptedFile(new Blob([new Uint8Array([1, 2, 3])]),
      { storedName: "photo.webp", extension: "webp", mimeType: "image/webp" }, "image");
    const thumbnail = await prepareEncryptedThumbnail(new Blob([new Uint8Array([4, 5, 6])]),
      { storedName: "preview.webp", extension: "webp", mimeType: "image/webp" }, main.manifest);
    const bytes: Uint8Array[] = [];
    for await (const chunk of thumbnail.chunks()) bytes.push(chunk);
    const ciphertext = Uint8Array.from(Buffer.concat(bytes));
    const ownerId = new ObjectId(), jobId = new ObjectId();
    const planned = [{ publicId: `vaultx/ciphertext/${"a".repeat(48)}.dat`, assetId: "main-asset",
      resourceType: "raw" as const, deliveryType: "authenticated" as const, format: "dat", cleanupCompleted: false },
    { publicId: `vaultx/thumbnails/${"b".repeat(48)}.dat`, resourceType: "raw" as const,
      deliveryType: "authenticated" as const, format: "dat", cleanupCompleted: false }];
    let job = uploadJobSchema.parse({ _id: jobId, ownerId, fileId: new ObjectId(), folderId: null,
      category: "image", manifest: main.manifest, thumbnailManifest: thumbnail.manifest,
      ciphertextBytes: Number(main.manifest.objectBytes), intentExpiresAt: new Date("2030-01-01"),
      status: "pending", attempts: 0, cloudAssets: planned,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") });
    let uploaded: Uint8Array | undefined;
    const identity = (): ProviderAsset => ({ publicId: planned[1].publicId, assetId: "thumb-asset",
      resourceType: "raw", deliveryType: "authenticated", format: "", bytes: ciphertext.length, version: 1 });
    const store: UploadStore = {
      async getJob() { return job; }, async getReadyFile() { return null; },
      async acquire(_owner, _id, operation, token, expiry) { job = { ...job, status: "running", operation,
        leaseToken: token, leaseExpiresAt: expiry }; return job; },
      async recordAsset(_job, _token, asset, _now, index) {
        assert.equal(index, 1);
        job = { ...job, status: "pending", cloudAssets: job.cloudAssets.map((item, position) =>
          position === 1 ? { ...item, assetId: asset.assetId } : item) };
      },
      async recordState() {}, async commitReady() {}, async requestCancel() { return false; },
    };
    const provider: CiphertextTransferProvider = {
      async upload(asset, input) { assert.equal(asset.publicId, planned[1].publicId); uploaded = Uint8Array.from(input); return identity(); },
      async lookup() { return null; }, async readHeader() { return ciphertext.subarray(0, 80); }, async destroy() {},
    };
    assert.equal(await transferCiphertext(store, provider, ownerId, jobId, request(ciphertext), new Date("2026-01-02"), 1), "transferred");
    assert.deepEqual(uploaded, ciphertext);
    assert.equal(job.cloudAssets[0].assetId, "main-asset");
    assert.equal(job.cloudAssets[1].assetId, "thumb-asset");
  } finally { clearVaultKeyMaterial(); }
});

test("cancelling during preview transfer removes both stored objects before marking the job cancelled", async () => {
  installVaultRootKey(new Uint8Array(randomBytes(32)), randomBytes(16).toString("base64url"));
  try {
    const main = await prepareEncryptedFile(new Blob([new Uint8Array([1])]),
      { storedName: "photo.webp", extension: "webp", mimeType: "image/webp" }, "image");
    const thumb = await prepareEncryptedThumbnail(new Blob([new Uint8Array([2])]),
      { storedName: "preview.webp", extension: "webp", mimeType: "image/webp" }, main.manifest);
    const parts: Uint8Array[] = []; for await (const part of thumb.chunks()) parts.push(part);
    const body = Uint8Array.from(Buffer.concat(parts));
    const ownerId = new ObjectId(), id = new ObjectId();
    const assets = [0, 1].map((index) => ({ publicId: `vaultx/${index ? "thumbnails" : "ciphertext"}/${index ? "b" : "a".repeat(48)}.dat`,
      assetId: index ? undefined : "main", resourceType: "raw" as const, deliveryType: "authenticated" as const,
      format: "dat", cleanupCompleted: false }));
    assets[1].publicId = `vaultx/thumbnails/${"b".repeat(48)}.dat`;
    let job = uploadJobSchema.parse({ _id: id, ownerId, fileId: new ObjectId(), folderId: null,
      category: "image", manifest: main.manifest, thumbnailManifest: thumb.manifest,
      ciphertextBytes: Number(main.manifest.objectBytes), intentExpiresAt: new Date("2030-01-01"),
      status: "pending", attempts: 0, cloudAssets: assets,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") });
    const remote = new Set([assets[0].publicId]);
    const store: UploadStore = {
      async getJob() { return job; }, async getReadyFile() { return null; },
      async acquire(_owner, _id, operation, token, expiry) { job = { ...job, status: "running", operation,
        leaseToken: token, leaseExpiresAt: expiry }; return job; },
      async recordAsset() { throw new Error("cancelled transfer cannot record asset"); },
      async recordState(_job, _token, status) { job = { ...job, status }; },
      async commitReady() {}, async requestCancel() { return false; },
    };
    const provider: CiphertextTransferProvider = {
      async lookup(asset) { return remote.has(asset.publicId) ? { assetId: asset.publicId === assets[0].publicId ? "main" : "thumb",
        publicId: asset.publicId, resourceType: "raw", deliveryType: "authenticated", format: "dat",
        bytes: asset.publicId === assets[0].publicId ? Number(main.manifest.objectBytes) : body.length, version: 1 } : null; },
      async upload(asset) { remote.add(asset.publicId); job = { ...job, cancelRequestedAt: new Date() };
        return { assetId: "thumb", publicId: asset.publicId, resourceType: "raw", deliveryType: "authenticated",
          format: "dat", bytes: body.length, version: 1 }; },
      async readHeader() { return body.subarray(0, 80); }, async destroy(asset) { remote.delete(asset.publicId); },
    };
    assert.equal(await transferCiphertext(store, provider, ownerId, id, request(body), new Date("2026-01-02"), 1), "cancelled");
    assert.equal(remote.size, 0);
    assert.equal(job.status, "cancelled");
  } finally { clearVaultKeyMaterial(); }
});
