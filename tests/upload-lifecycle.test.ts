import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath } from "../src/lib/auth/api-policy";
import { uploadJobSchema, type UploadJob, type VaultFile } from "../src/lib/database/models";
import { cancelUpload, completeInputSchema, completeUpload, uploadStatus, type CompletionMetadata,
  type ProviderAsset, type UploadProvider, type UploadStore } from "../src/lib/uploads/lifecycle";

const now = new Date("2026-01-01T00:01:00.000Z");
const vaultId = "A".repeat(22);
const metadata: CompletionMetadata = { nameEncrypted: { version: 1, vaultId, salt: "A".repeat(43),
  ciphertext: "A".repeat(24), nonce: "A".repeat(16), algorithm: "AES-256-GCM" },
  extension: "webp", mimeType: "image/webp", width: 100, height: 80 };

function fixture() {
  const ownerId = new ObjectId();
  const job = uploadJobSchema.parse({ _id: new ObjectId(), ownerId, fileId: new ObjectId(), folderId: null,
    category: "image", manifest: { version: 1, kind: "file", vaultId, header: "A".repeat(107), objectBytes: "228",
      wrappedKey: { version: 1, revision: 1, salt: "A".repeat(43), nonce: "A".repeat(16), ciphertext: "A".repeat(64) } },
    ciphertextBytes: 228, intentExpiresAt: new Date("2026-01-01T00:10:00.000Z"),
    status: "pending", attempts: 0, cloudAssets: [{ publicId: `vaultx/ciphertext/${"a".repeat(48)}.dat`,
      assetId: "asset-1", resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false }],
    createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z") });
  const asset: ProviderAsset = { assetId: "asset-1", publicId: job.cloudAssets[0].publicId,
    resourceType: "raw", deliveryType: "authenticated", format: "dat", bytes: 228, version: 1 };
  return { ownerId, job, asset };
}

function harness(initial: UploadJob, initialAsset: ProviderAsset | null) {
  let job = initial;
  let file: VaultFile | null = null;
  const assets = new Map<string, ProviderAsset>();
  if (initialAsset) assets.set(initialAsset.publicId, initialAsset);
  let networkFailure = false;
  let commitFailure = false;
  let ambiguousCommit = false;
  let badHeader = false;
  let deleteFailure = false;
  let failAfterFirstDestroy = false;
  let crashOnRecordState = false;
  let destroys = 0;
  const store: UploadStore = {
    async getJob(owner, id) { return owner.equals(job.ownerId) && id.equals(job._id) ? job : null; },
    async getReadyFile(owner, id) { return file && owner.equals(file.ownerId) && id.equals(file._id) ? file : null; },
    async acquire(owner, id, operation, token, expiry, time, details) {
      if (!owner.equals(job.ownerId) || !id.equals(job._id)
        || !(["pending", "failed", "retrying"].includes(job.status)
          || (job.status === "running" && !!job.leaseExpiresAt && job.leaseExpiresAt <= time))) return null;
      job = { ...job, status: "running", operation, leaseToken: token, leaseExpiresAt: expiry,
        completionMetadata: details ?? job.completionMetadata, updatedAt: time };
      return job;
    },
    async commitReady(current, token, ready, time) {
      if (commitFailure) throw new Error("synthetic transaction failure");
      if (job.leaseToken !== token || current._id.toHexString() !== job._id.toHexString()) throw new Error("Lost lease");
      file = ready;
      job = { ...job, status: "completed", operation: undefined, leaseToken: undefined, leaseExpiresAt: undefined, updatedAt: time };
      if (ambiguousCommit) throw new Error("synthetic lost commit response");
    },
    async recordState(_current, token, status, code, time) {
      if (crashOnRecordState) throw new Error("synthetic process exit before state commit");
      if (job.leaseToken !== token) throw new Error("Lost lease");
      job = { ...job, status, operation: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
        lastErrorCode: code, attempts: job.attempts + 1, updatedAt: time,
        cloudAssets: status === "cancelled" ? job.cloudAssets.map((entry) => ({ ...entry, cleanupCompleted: true })) : job.cloudAssets };
    },
    async recordAsset(_current, token, recorded, time, index = 0) {
      if (job.leaseToken !== token) throw new Error("Lost lease");
      job = { ...job, status: "pending", operation: undefined, leaseToken: undefined, leaseExpiresAt: undefined,
        cloudAssets: job.cloudAssets.map((entry, position) => position === index
          ? { ...entry, assetId: recorded.assetId, version: recorded.version } : entry), updatedAt: time };
    },
    async requestCancel(owner, id, time) {
      if (!owner.equals(job.ownerId) || !id.equals(job._id) || job.status !== "running" || job.operation !== "transfer") return false;
      job = { ...job, cancelRequestedAt: time };
      return true;
    },
  };
  const provider: UploadProvider = {
    async lookup(planned) { if (networkFailure) throw new Error("synthetic outage");
      if (failAfterFirstDestroy && destroys === 1 && assets.size > 0) throw new Error("synthetic process crash");
      return assets.get(planned.publicId) ?? null; },
    async readHeader(planned) { if (networkFailure) throw new Error("synthetic outage");
      const header = Buffer.from((planned.publicId === job.cloudAssets[0].publicId
        ? job.manifest : job.thumbnailManifest)!.header, "base64url");
      if (badHeader) header[16] ^= 1;
      return header; },
    async destroy(planned) { if (networkFailure || deleteFailure) throw new Error("synthetic outage");
      assets.delete(planned.publicId); destroys++; },
  };
  return { store, provider, state: () => ({ job, file, destroys }),
    addAsset: (asset: ProviderAsset) => { assets.set(asset.publicId, asset); },
    crashAfterFirstDestroy: (value: boolean) => { failAfterFirstDestroy = value; },
    crashBeforeStateCommit: (value: boolean) => { crashOnRecordState = value; },
    outage: (value: boolean) => { networkFailure = value; }, failCommit: (value: boolean) => { commitFailure = value; },
    ambiguousCommit: (value: boolean) => { ambiguousCommit = value; },
    corruptHeader: (value: boolean) => { badHeader = value; }, failDelete: (value: boolean) => { deleteFailure = value; } };
}

test("completion/status/cancel routes are explicitly scoped and methods are limited", () => {
  assert.equal(isEnabledPrivateApiPath("/api/uploads/complete"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/complete", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/complete", "GET"), false);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/abc", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/abc", "DELETE"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/uploads/abc", "POST"), false);
  assert.equal(completeInputSchema.safeParse({ id: new ObjectId().toHexString(), ...metadata, storedSizeBytes: 1 }).success, false);
  assert.equal(completeInputSchema.safeParse({ id: new ObjectId().toHexString(), ...metadata, publicId: "forged" }).success, false);
});

test("crash after deleting main ciphertext resumes and also removes encrypted thumbnail", async () => {
  const { ownerId, job, asset } = fixture();
  const thumbnail = { publicId: `vaultx/thumbnails/${"b".repeat(48)}.dat`, assetId: "asset-thumb",
    resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false };
  const twoAssets = uploadJobSchema.parse({ ...job,
    thumbnailManifest: { ...job.manifest!, kind: "thumbnail" }, cloudAssets: [...job.cloudAssets, thumbnail] });
  const app = harness(twoAssets, asset);
  app.addAsset({ ...asset, publicId: thumbnail.publicId, assetId: thumbnail.assetId });
  app.crashAfterFirstDestroy(true);
  await assert.rejects(() => cancelUpload(app.store, app.provider, ownerId, job._id, now));
  assert.equal(app.state().job.status, "retrying");
  assert.equal(app.state().destroys, 1);
  app.crashAfterFirstDestroy(false);
  assert.equal((await cancelUpload(app.store, app.provider, ownerId, job._id, now)).status, "cancelled");
  assert.equal(app.state().destroys, 2);
  assert.equal(app.state().job.cloudAssets.every((entry) => entry.cleanupCompleted), true);
});

test("a reserved thumbnail cannot be silently omitted when completing a file", async () => {
  const { ownerId, job, asset } = fixture();
  const thumbnail = { publicId: `vaultx/thumbnails/${"b".repeat(48)}.dat`,
    resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false };
  const pending = uploadJobSchema.parse({ ...job,
    thumbnailManifest: { ...job.manifest!, kind: "thumbnail" }, cloudAssets: [...job.cloudAssets, thumbnail] });
  const app = harness(pending, asset);
  await assert.rejects(() => completeUpload(app.store, app.provider, ownerId, pending._id, metadata, now),
    { code: "conflict" });
  assert.equal(app.state().file, null);
  assert.equal(app.state().job.status, "pending");
});

test("ready media requires both restricted provider objects and retains encrypted preview inventory", async () => {
  const { ownerId, job, asset } = fixture();
  const thumbAsset = { ...asset, publicId: `vaultx/thumbnails/${"b".repeat(48)}.dat`, assetId: "asset-thumb" };
  const paired = uploadJobSchema.parse({ ...job,
    thumbnailManifest: { ...job.manifest!, kind: "thumbnail" },
    cloudAssets: [...job.cloudAssets, { publicId: thumbAsset.publicId, assetId: thumbAsset.assetId,
      resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false }] });
  const app = harness(paired, asset);
  app.addAsset(thumbAsset);
  assert.equal((await completeUpload(app.store, app.provider, ownerId, job._id, metadata, now)).status, "completed");
  assert.equal(app.state().file?.thumbnail?.cloudinary.assetId, thumbAsset.assetId);
  assert.equal(app.state().file?.thumbnail?.storedSizeBytes, 228);
});

test("foreign provider identity is terminal until an owner retries manually", async () => {
  const { ownerId, job, asset } = fixture();
  const app = harness(job, { ...asset, assetId: "foreign" });
  await assert.rejects(() => cancelUpload(app.store, app.provider, ownerId, job._id, now));
  assert.equal(app.state().job.status, "failed");
  assert.equal(app.state().job.lastErrorCode, "provider_mismatch");
  assert.equal(app.state().destroys, 0);
});

test("an expired lease resumes after remote removal but before status commit", async () => {
  const { ownerId, job, asset } = fixture();
  const app = harness(job, asset);
  app.crashBeforeStateCommit(true);
  await assert.rejects(() => cancelUpload(app.store, app.provider, ownerId, job._id, now));
  assert.equal(app.state().job.status, "running");
  assert.equal(app.state().destroys, 1);
  app.crashBeforeStateCommit(false);
  const afterLease = new Date(now.getTime() + 2 * 60_000 + 1);
  assert.equal((await cancelUpload(app.store, app.provider, ownerId, job._id, afterLease)).status, "cancelled");
  assert.equal(app.state().destroys, 1);
});

test("verified provider object commits wrapped key, manifest, encrypted name and exact stored bytes once", async () => {
  const { ownerId, job, asset } = fixture();
  const app = harness(job, asset);
  const result = await completeUpload(app.store, app.provider, ownerId, job._id, metadata, now);
  assert.equal(result.status, "completed");
  assert.equal(app.state().file?.storedSizeBytes, 228);
  assert.equal(app.state().file?.encryptedFileKey, job.manifest?.wrappedKey.ciphertext);
  assert.deepEqual(app.state().file?.encryptionManifest, job.manifest);
  assert.deepEqual(app.state().file?.nameEncrypted, metadata.nameEncrypted);
  assert.equal(app.state().file?.extension, "webp");
  assert.equal((await completeUpload(app.store, app.provider, ownerId, job._id, metadata, now)).status, "completed");
  assert.equal(app.state().destroys, 0);
  const status = await uploadStatus(app.store, ownerId, job._id);
  assert.equal(JSON.stringify(status).includes("publicId"), false);
  assert.equal(JSON.stringify(status).includes("wrappedKey"), false);
  await assert.rejects(() => cancelUpload(app.store, app.provider, ownerId, job._id, now));
});

test("false client metadata and foreign owner never create a ready file", async () => {
  const { ownerId, job, asset } = fixture();
  const app = harness(job, asset);
  await assert.rejects(() => completeUpload(app.store, app.provider, ownerId, job._id,
    { ...metadata, extension: "jpg" }, now));
  await assert.rejects(() => completeUpload(app.store, app.provider, new ObjectId(), job._id, metadata, now));
  assert.equal(app.state().file, null);
  assert.equal(app.state().job.status, "pending");
});

test("oversize, mismatched identity and missing object fail closed", async () => {
  for (const candidate of [
    (asset: ProviderAsset) => ({ ...asset, bytes: 1_000_000 }),
    (asset: ProviderAsset) => ({ ...asset, bytes: 227 }),
    (asset: ProviderAsset) => ({ ...asset, deliveryType: "upload" }),
    (asset: ProviderAsset) => ({ ...asset, assetId: "foreign" }),
    () => null,
  ]) {
    const { ownerId, job, asset } = fixture();
    const app = harness(job, candidate(asset));
    await assert.rejects(() => completeUpload(app.store, app.provider, ownerId, job._id, metadata, now));
    assert.equal(app.state().file, null);
    assert.equal(app.state().job.status, "failed");
  }
});

test("provider outage and uncertain DB commit retain a durable job for retry or cleanup", async () => {
  const { ownerId, job, asset } = fixture();
  const app = harness(job, asset);
  app.outage(true);
  await assert.rejects(() => completeUpload(app.store, app.provider, ownerId, job._id, metadata, now));
  assert.equal(app.state().job.status, "retrying");
  app.outage(false); app.failCommit(true);
  await assert.rejects(() => completeUpload(app.store, app.provider, ownerId, job._id, metadata, now));
  assert.equal(app.state().job.lastErrorCode, "db_commit_failed");
  assert.equal(app.state().file, null);
  app.failCommit(false);
  assert.equal((await cancelUpload(app.store, app.provider, ownerId, job._id, now)).status, "cancelled");
  assert.equal(app.state().destroys, 1);
  assert.equal((await cancelUpload(app.store, app.provider, ownerId, job._id, now)).status, "cancelled");
  assert.equal(app.state().destroys, 1);
});

test("cancel after a missing object confirms absence and remains idempotent", async () => {
  const { ownerId, job } = fixture();
  const app = harness(job, null);
  assert.equal((await cancelUpload(app.store, app.provider, ownerId, job._id, now)).status, "cancelled");
  assert.equal(app.state().job.cloudAssets[0].cleanupCompleted, true);
  assert.equal(app.state().destroys, 0);
});

test("cancel during a running ciphertext transfer records a durable cancellation request", async () => {
  const { ownerId, job, asset } = fixture();
  const running = uploadJobSchema.parse({ ...job, status: "running", operation: "transfer",
    leaseToken: "a".repeat(32), leaseExpiresAt: new Date("2026-01-01T00:10:00.000Z") });
  const app = harness(running, asset);
  const result = await cancelUpload(app.store, app.provider, ownerId, job._id, now);
  assert.equal(result.status, "running");
  assert.equal(result.cancelRequested, true);
  assert.equal(app.state().job.cancelRequestedAt?.getTime(), now.getTime());
  assert.equal(app.state().file, null);
});

test("a different ciphertext header or failed remote deletion never reports success", async () => {
  const first = fixture();
  const mismatch = harness(first.job, first.asset);
  mismatch.corruptHeader(true);
  await assert.rejects(() => completeUpload(mismatch.store, mismatch.provider, first.ownerId, first.job._id, metadata, now));
  assert.equal(mismatch.state().file, null);
  assert.equal(mismatch.state().job.status, "failed");

  const second = fixture();
  const failedDelete = harness(second.job, second.asset);
  failedDelete.failDelete(true);
  await assert.rejects(() => cancelUpload(failedDelete.store, failedDelete.provider, second.ownerId, second.job._id, now));
  assert.equal(failedDelete.state().job.status, "retrying");
  assert.equal(failedDelete.state().job.cloudAssets[0].cleanupCompleted, false);
  failedDelete.failDelete(false);
  assert.equal((await cancelUpload(failedDelete.store, failedDelete.provider, second.ownerId, second.job._id, now)).status, "cancelled");
});

test("video requires actual stored bytes below the decimal 100 MB ceiling", async () => {
  const initial = fixture();
  const videoJob = uploadJobSchema.parse({ ...initial.job, category: "video", ciphertextBytes: 100_000_000,
    manifest: { ...initial.job.manifest!, objectBytes: "100000000" } });
  const provider = { ...initial.asset, bytes: 100_000_000 };
  const app = harness(videoJob, provider);
  await assert.rejects(() => completeUpload(app.store, app.provider, initial.ownerId, videoJob._id,
    { ...metadata, extension: "mp4", mimeType: "video/mp4", durationSeconds: 4 }, now));
  assert.equal(app.state().file, null);
});

test("an uncertain successful transaction is observed, never cleaned up as an orphan", async () => {
  const { ownerId, job, asset } = fixture();
  const app = harness(job, asset);
  app.ambiguousCommit(true);
  const result = await completeUpload(app.store, app.provider, ownerId, job._id, metadata, now);
  assert.equal(result.status, "completed");
  assert.equal(app.state().file?.cloudinary?.assetId, asset.assetId);
  assert.equal(app.state().destroys, 0);
});
