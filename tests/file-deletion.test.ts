import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import type { v2 as Cloudinary } from "cloudinary";
import { deletionJobSchema, type DeletionJob, type VaultFile } from "../src/lib/database/models";
import { inventoryFileAssets, queueFileDeletion } from "../src/lib/database/file-deletions";
import { cloudinaryDeletionProvider } from "../src/lib/cloudinary/deletion-provider";
import { DeletionFailure, processFileDeletion, publicDeletionStatus, type DeletionAsset, type DeletionStore } from "../src/lib/deletions/file-deletion";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath } from "../src/lib/auth/api-policy";

const owner = new ObjectId();
const foreign = new ObjectId();
const fileId = new ObjectId();
const now = new Date("2026-10-15T12:00:00.000Z");
const opaque = (prefix: "ciphertext" | "thumbnails", letter: string) => `vaultx/${prefix}/${letter.repeat(48)}.dat`;
const main = { publicId: opaque("ciphertext", "a"), assetId: "main-asset", resourceType: "raw" as const,
  deliveryType: "authenticated" as const, format: "dat" };
const thumb = { publicId: opaque("thumbnails", "b"), assetId: "thumbnail-asset", resourceType: "raw" as const,
  deliveryType: "authenticated" as const, format: "dat" };

function readyFile(): VaultFile {
  return { _id: fileId, ownerId: owner, folderId: null, cloudinary: main, storedSizeBytes: 500,
    encryptionManifest: { kind: "file", objectBytes: "500" }, status: "ready",
    thumbnail: { cloudinary: thumb, storedSizeBytes: 100, encryptionManifest: { kind: "thumbnail", objectBytes: "100" } } } as VaultFile;
}

function queuedJob(): DeletionJob {
  return deletionJobSchema.parse({ _id: new ObjectId(), ownerId: owner, targetType: "file", targetId: fileId,
    fileIds: [fileId], folderIds: [], inventoryComplete: true,
    cloudAssets: inventoryFileAssets(readyFile()), phase: "deleting", status: "pending", attempts: 0,
    createdAt: now, updatedAt: now });
}

function memoryStore(initial: DeletionJob, inject: { metadataFailures?: number } = {}) {
  const job = { ...initial, cloudAssets: initial.cloudAssets.map((asset) => ({ ...asset })) };
  const snapshot = () => ({ ...job, cloudAssets: job.cloudAssets.map((asset) => ({ ...asset })) });
  let fileExists = true;
  const store: DeletionStore = {
    get: async (requested, id) => requested.equals(owner) && id.equals(job._id) ? snapshot() : null,
    acquire: async (requested, id, token, at, force) => {
      if (!requested.equals(owner) || !id.equals(job._id) || job.status === "completed" || job.status === "running"
        || (job.status === "failed" && !force) || (job.status === "retrying" && !force && job.nextAttemptAt && job.nextAttemptAt > at)) return null;
      job.status = "running"; job.attempts++; job.leaseToken = token; job.leaseExpiresAt = new Date(at.getTime() + 600_000);
      return snapshot();
    },
    markAsset: async (_job, token, asset) => {
      assert.equal(job.leaseToken, token);
      const found = job.cloudAssets.find((entry) => entry.publicId === asset.publicId)!;
      found.completed = true;
    },
    setPhase: async (_job, token) => {
      assert.equal(job.leaseToken, token);
      assert.ok(job.cloudAssets.every((asset) => asset.completed));
      job.phase = "remote-delete-confirmed";
    },
    removeMetadata: async (_job, token) => {
      assert.equal(job.leaseToken, token);
      assert.equal(job.phase, "remote-delete-confirmed");
      if (inject.metadataFailures) { inject.metadataFailures--; throw new Error("injected database outage"); }
      fileExists = false; job.phase = "metadata-removed";
    },
    finish: async (_job, token) => {
      assert.equal(job.leaseToken, token);
      assert.equal(fileExists, false);
      assert.equal(job.phase, "metadata-removed");
      job.phase = "completed"; job.status = "completed"; delete job.leaseToken; delete job.leaseExpiresAt;
    },
    fail: async (_job, token, code, next) => {
      assert.equal(job.leaseToken, token);
      job.status = next ? "retrying" : "failed"; job.lastErrorCode = code;
      if (next) job.nextAttemptAt = next; else delete job.nextAttemptAt;
      delete job.leaseToken; delete job.leaseExpiresAt;
    },
  };
  return { store, fileExists: () => fileExists, job: () => job };
}

test("inventory includes main, encrypted thumbnail, and upload-job references exactly once", () => {
  const records = inventoryFileAssets(readyFile(), [main, thumb]);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((entry) => entry.publicId), [main.publicId, thumb.publicId]);
  assert.ok(records.every((entry) => entry.fileId.equals(fileId) && !entry.completed));
  assert.throws(() => inventoryFileAssets(readyFile(), [{ ...thumb, assetId: "different" }]), DeletionFailure);
  assert.throws(() => inventoryFileAssets(readyFile(), [{ ...thumb, publicId: "public/other" }]), DeletionFailure);
  assert.equal(isEnabledPrivateApiPath("/api/deletions/abc/retry"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/files/abc", "DELETE"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/deletions/abc/retry", "GET"), false);
});

test("queue persists the complete job and fences the file in one transaction; repeats return one job", async () => {
  const file = readyFile();
  let job: DeletionJob | null = null;
  const order: string[] = [];
  const db = { client: { withSession: async (fn: (session: { withTransaction: (callback: () => Promise<unknown>) => Promise<unknown> }) => Promise<unknown>) =>
    fn({ withTransaction: async (callback) => callback() }) },
  collection(name: string) {
    if (name === "owners") return { updateOne: async (query: { _id: ObjectId }) => ({ matchedCount: query._id.equals(owner) ? 1 : 0 }) };
    if (name === "deletionJobs") return { findOne: async (query: { ownerId: ObjectId }) => query.ownerId.equals(owner) ? job : null,
      insertOne: async (record: DeletionJob) => { order.push("inventory"); job = record; } };
    if (name === "files") return { findOne: async (query: { status: string }) => file.status === query.status ? file : null,
      updateOne: async () => { order.push("fence"); file.status = "deleting"; return { matchedCount: 1 }; } };
    if (name === "uploadJobs") return { find: () => ({ toArray: async () => [{ cloudAssets: [main, thumb] }] }) };
    return {};
  } } as unknown as Db;
  const first = await queueFileDeletion(db, owner, fileId, now);
  assert.deepEqual(order, ["inventory", "fence"]);
  assert.equal(file.status, "deleting");
  assert.equal(first.cloudAssets.length, 2);
  const repeated = await queueFileDeletion(db, owner, fileId, now);
  assert.equal(repeated._id.toHexString(), first._id.toHexString());
  assert.deepEqual(order, ["inventory", "fence"]);
  await assert.rejects(queueFileDeletion(db, foreign, fileId, now), DeletionFailure);
});

test("provider failure preserves inventory and file, then backoff retry removes both", async () => {
  const job = queuedJob();
  const { store, fileExists } = memoryStore(job);
  const called: string[] = [];
  let failThumbnail = true;
  const provider = { remove: async (asset: DeletionAsset) => {
    called.push(asset.publicId);
    if (asset.publicId === thumb.publicId && failThumbnail) { failThumbnail = false; throw new Error("injected outage"); }
  } };
  let state = await processFileDeletion(store, provider, owner, job._id, now);
  assert.equal(state.status, "retrying");
  assert.equal(state.phase, "deleting");
  assert.equal(fileExists(), true);
  assert.deepEqual(state.cloudAssets.map((asset) => asset.completed), [true, false]);
  assert.equal(publicDeletionStatus(state).remainingObjects, 1);
  const before = called.length;
  state = await processFileDeletion(store, provider, owner, state._id, now);
  assert.equal(called.length, before);
  state = await processFileDeletion(store, provider, owner, state._id, new Date(state.nextAttemptAt!.getTime() + 1));
  assert.equal(state.status, "completed");
  assert.equal(fileExists(), false);
  assert.deepEqual(called, [main.publicId, thumb.publicId, thumb.publicId]);
});

test("database failure after remote confirmation never reports completion and resumes without remote calls", async () => {
  const job = queuedJob();
  const { store, fileExists } = memoryStore(job, { metadataFailures: 1 });
  let calls = 0;
  const provider = { remove: async () => { calls++; } };
  let state = await processFileDeletion(store, provider, owner, job._id, now);
  assert.equal(state.status, "retrying");
  assert.equal(state.phase, "remote-delete-confirmed");
  assert.equal(fileExists(), true);
  assert.equal(calls, 2);
  state = await processFileDeletion(store, provider, owner, job._id, new Date(state.nextAttemptAt!.getTime() + 1));
  assert.equal(state.status, "completed");
  assert.equal(fileExists(), false);
  assert.equal(calls, 2);
  assert.equal((await processFileDeletion(store, provider, owner, job._id)).status, "completed");
  assert.equal(calls, 2);
});

test("repeated provider outages stop automatic retries and preserve a manual retry path", async () => {
  const initial = deletionJobSchema.parse({ ...queuedJob(), attempts: 7 });
  const { store } = memoryStore(initial);
  let available = false;
  const provider = { remove: async () => { if (!available) throw new Error("injected outage"); } };
  const terminal = await processFileDeletion(store, provider, owner, initial._id, now);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.lastErrorCode, "provider_unavailable");
  assert.equal(terminal.cloudAssets.every((asset) => !asset.completed), true);
  assert.equal((await processFileDeletion(store, provider, owner, initial._id, now)).status, "failed");
  available = true;
  assert.equal((await processFileDeletion(store, provider, owner, initial._id, now, true)).status, "completed");
});

test("Cloudinary destroy uses exact restricted identity, invalidates, and verifies absence", async () => {
  const asset = queuedJob().cloudAssets[0];
  let present = true;
  const destroyOptions: unknown[] = [];
  const client = { api: { resource_by_asset_id: async () => {
    if (!present) throw { http_code: 404 };
    return { asset_id: asset.assetId, public_id: asset.publicId, resource_type: "raw", type: "authenticated" };
  } }, uploader: { destroy: async (_id: string, options: unknown) => { destroyOptions.push(options); present = false; return { result: "ok" }; } } } as unknown as typeof Cloudinary;
  const provider = cloudinaryDeletionProvider(client);
  await provider.remove(asset);
  await provider.remove(asset);
  assert.equal(destroyOptions.length, 1);
  assert.deepEqual(destroyOptions[0], { resource_type: "raw", type: "authenticated", invalidate: true });
  const mismatched = { api: { resource_by_asset_id: async () => ({ asset_id: asset.assetId,
    public_id: opaque("ciphertext", "f"), resource_type: "raw", type: "authenticated" }) },
  uploader: { destroy: async () => { throw new Error("must not delete"); } } } as unknown as typeof Cloudinary;
  await assert.rejects(cloudinaryDeletionProvider(mismatched).remove(asset), (error: unknown) => error instanceof DeletionFailure && error.code === "identity_mismatch");

  const stillPresent = { api: { resource_by_asset_id: async () => ({ asset_id: asset.assetId,
    public_id: asset.publicId, resource_type: "raw", type: "authenticated" }) },
  uploader: { destroy: async () => ({ result: "ok" }) } } as unknown as typeof Cloudinary;
  await assert.rejects(cloudinaryDeletionProvider(stillPresent).remove(asset),
    (error: unknown) => error instanceof DeletionFailure && error.code === "provider_unavailable");
});
