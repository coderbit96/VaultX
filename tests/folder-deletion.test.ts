import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import { deletionJobSchema, type DeletionJob, type Folder, type VaultFile } from "../src/lib/database/models";
import { inspectFolderSubtree, queueFolderDeletion, type FolderDeletionStore } from "../src/lib/database/folder-deletions";
import { processFolderDeletion } from "../src/lib/deletions/folder-deletion";
import { DeletionFailure, type DeletionAsset } from "../src/lib/deletions/file-deletion";
import { activeAncestry } from "../src/lib/database/folders";
import { isEnabledPrivateApiMethod } from "../src/lib/auth/api-policy";

const owner = new ObjectId();
const root = new ObjectId();
const sibling = new ObjectId();
const now = new Date("2026-10-15T12:00:00.000Z");
const opaque = (n: number) => `vaultx/ciphertext/${n.toString(16).padStart(48, "0")}.dat`;
function file(folderId: ObjectId, n: number): VaultFile {
  return { _id: new ObjectId(), ownerId: owner, folderId, status: "ready", storedSizeBytes: 500,
    cloudinary: { publicId: opaque(n), assetId: `asset-${n}`, resourceType: "raw", deliveryType: "authenticated", format: "dat" },
    encryptionManifest: { kind: "file", objectBytes: "500" } } as VaultFile;
}

function treeDb(depth: number, pendingUpload = false, movedJobs = false) {
  const folders: Folder[] = [{ _id: root, ownerId: owner, parentFolderId: null, status: "active" } as Folder,
    { _id: sibling, ownerId: owner, parentFolderId: null, status: "active" } as Folder];
  let parent = root;
  for (let n = 0; n < depth; n++) {
    const child = { _id: new ObjectId(), ownerId: owner, parentFolderId: parent, status: "active" } as Folder;
    folders.push(child); parent = child._id;
  }
  const target = file(parent, 1), untouched = file(sibling, 2);
  const files = [target, untouched];
  const uploads = [
    ...(pendingUpload ? [{ ownerId: owner, folderId: parent, fileId: new ObjectId(), status: "running", cloudAssets: [] }] : []),
    ...(movedJobs ? [
      { ownerId: owner, folderId: sibling, fileId: target._id, status: "completed", cloudAssets: [target.cloudinary!,
        { ...target.cloudinary!, publicId: `vaultx/thumbnails/${"f".repeat(48)}.dat`, assetId: "target-thumb" }] },
      { ownerId: owner, folderId: root, fileId: untouched._id, status: "completed", cloudAssets: [untouched.cloudinary!] },
    ] : []),
  ];
  let job: DeletionJob | null = null;
  const within = (id: ObjectId, choices: ObjectId[]) => choices.some((item) => item.equals(id));
  const db = { client: { withSession: async (callback: (session: unknown) => Promise<unknown>) => callback({
    withTransaction: async (action: () => Promise<unknown>) => action() }) },
  collection(name: string) {
    if (name === "owners") return { updateOne: async () => ({ matchedCount: 1 }) };
    if (name === "folders") return {
      findOne: async (query: { _id: ObjectId; ownerId: ObjectId }) => folders.find((item) => item._id.equals(query._id) && item.ownerId.equals(query.ownerId)) ?? null,
      find: (query: { parentFolderId: { $in: ObjectId[] }; ownerId: ObjectId }) => ({ toArray: async () =>
        folders.filter((item) => item.parentFolderId && within(item.parentFolderId, query.parentFolderId.$in) && item.ownerId.equals(query.ownerId)) }),
      updateMany: async (query: { _id: { $in: ObjectId[] }; ownerId: ObjectId; status: string }) => {
        const matches = folders.filter((item) => within(item._id, query._id.$in) && item.ownerId.equals(query.ownerId) && item.status === query.status);
        matches.forEach((item) => { item.status = "deleting"; }); return { matchedCount: matches.length };
      },
    };
    if (name === "files") return {
      find: (query: { folderId: { $in: ObjectId[] }; ownerId: ObjectId }) => ({ toArray: async () =>
        files.filter((item) => item.folderId && within(item.folderId, query.folderId.$in) && item.ownerId.equals(query.ownerId)) }),
      updateMany: async (query: { _id: { $in: ObjectId[] }; ownerId: ObjectId; status: string }) => {
        const matches = files.filter((item) => within(item._id, query._id.$in) && item.ownerId.equals(query.ownerId) && item.status === query.status);
        matches.forEach((item) => { item.status = "deleting"; }); return { matchedCount: matches.length };
      },
    };
    if (name === "uploadJobs") return { find: (query: { folderId?: { $in: ObjectId[] }; fileId?: { $in: ObjectId[] };
      status?: { $nin: string[] } }) => ({ toArray: async () => uploads.filter((item) =>
        (!query.folderId || within(item.folderId, query.folderId.$in))
        && (!query.fileId || within(item.fileId, query.fileId.$in))
        && (!query.status || !query.status.$nin.includes(item.status))) }) };
    if (name === "deletionJobs") return { findOne: async () => job, insertOne: async (record: DeletionJob) => { job = record; } };
    return {};
  } } as unknown as Db;
  return { db, folders, files, target, untouched, job: () => job };
}

test("deep subtree inventory excludes a sibling; the committed job fences descendants", async () => {
  const state = treeDb(70);
  const snapshot = await inspectFolderSubtree(state.db, owner, root);
  assert.equal(snapshot.folderCount, 71);
  assert.equal(snapshot.fileCount, 1);
  assert.equal(snapshot.objectCount, 1);
  assert.ok(snapshot.cloudAssets[0].fileId.equals(state.target._id));
  assert.equal(snapshot.cloudAssets[0].publicId, state.target.cloudinary!.publicId);
  assert.ok(!snapshot.folderIds.some((id) => id.equals(sibling)));
  const queued = await queueFolderDeletion(state.db, owner, root, now);
  assert.equal(queued.cloudAssets.length, 1);
  assert.equal(queued.inventoryComplete, true);
  assert.ok(state.folders.filter((folder) => !folder._id.equals(sibling)).every((folder) => folder.status === "deleting"));
  assert.equal(state.target.status, "deleting");
  assert.equal(state.untouched.status, "ready");
  await assert.rejects(activeAncestry(state.db, owner, state.target.folderId));
  assert.equal((await activeAncestry(state.db, owner, sibling)).length, 1);
  assert.equal((await queueFolderDeletion(state.db, owner, root))._id.toHexString(), queued._id.toHexString());
  assert.equal(isEnabledPrivateApiMethod(`/api/folders/${root}`, "DELETE"), true);
});

test("an active upload blocks the snapshot before any job or folder fence", async () => {
  const state = treeDb(2, true);
  await assert.rejects(queueFolderDeletion(state.db, owner, root),
    (error: unknown) => error instanceof DeletionFailure && error.code === "state_conflict");
  assert.equal(state.job(), null);
  assert.ok(state.folders.every((folder) => folder.status === "active"));
  assert.equal(state.target.status, "ready");
});

test("stale confirmation counts cannot delete newly added contents", async () => {
  const state = treeDb(1);
  await assert.rejects(queueFolderDeletion(state.db, owner, root, now,
    { folderCount: 2, fileCount: 0, objectCount: 0 }),
  (error: unknown) => error instanceof DeletionFailure && error.code === "state_conflict");
  assert.equal(state.job(), null);
  assert.equal(state.target.status, "ready");
});

test("moved files use upload references by current file ID, not stale upload folder", async () => {
  const state = treeDb(4, false, true);
  const snapshot = await inspectFolderSubtree(state.db, owner, root);
  assert.equal(snapshot.fileCount, 1);
  assert.equal(snapshot.cloudAssets.length, 2);
  assert.ok(snapshot.cloudAssets.every((asset) => asset.fileId.equals(state.target._id)));
  assert.ok(!snapshot.cloudAssets.some((asset) => asset.publicId === state.untouched.cloudinary!.publicId));
});

function memoryStore(initial: DeletionJob, metadataFailures = 0) {
  const job = { ...initial, cloudAssets: initial.cloudAssets.map((asset) => ({ ...asset })) };
  const snapshot = () => ({ ...job, cloudAssets: job.cloudAssets.map((asset) => ({ ...asset })) });
  let metadataSteps = 0;
  const store: FolderDeletionStore = {
    get: async () => snapshot(),
    acquire: async (_owner, _id, token, at, force) => {
      if (job.status === "completed" || job.status === "running" || (job.status === "failed" && !force)
        || (job.status === "retrying" && job.nextAttemptAt && job.nextAttemptAt > at)) return null;
      job.status = "running"; job.attempts++; job.leaseToken = token; job.leaseExpiresAt = new Date(at.getTime() + 600_000);
      return snapshot();
    },
    markAsset: async (_job, token, asset) => {
      assert.equal(job.leaseToken, token);
      job.cloudAssets.find((item) => item.publicId === asset.publicId)!.completed = true;
    },
    setPhase: async (_job, token) => { assert.equal(job.leaseToken, token);
      assert.ok(job.cloudAssets.every((asset) => asset.completed)); job.phase = "remote-delete-confirmed"; },
    removeMetadata: async () => { throw new Error("file metadata path must not run"); },
    removeFolderMetadata: async (_job, token) => {
      assert.equal(job.leaseToken, token); assert.equal(job.phase, "remote-delete-confirmed");
      if (metadataFailures) { metadataFailures--; throw new Error("injected database outage"); }
      metadataSteps++;
      if (metadataSteps < 3) return false;
      job.phase = "metadata-removed"; return true;
    },
    defer: async (_job, token) => { assert.equal(job.leaseToken, token); job.status = "pending"; delete job.leaseToken; delete job.leaseExpiresAt; },
    finish: async (_job, token) => { assert.equal(job.leaseToken, token); assert.equal(job.phase, "metadata-removed");
      job.phase = "completed"; job.status = "completed"; delete job.leaseToken; delete job.leaseExpiresAt; },
    fail: async (_job, token, code, next) => { assert.equal(job.leaseToken, token);
      job.status = next ? "retrying" : "failed"; job.lastErrorCode = code;
      if (next) job.nextAttemptAt = next; delete job.leaseToken; delete job.leaseExpiresAt; },
  };
  return { store, job, metadataSteps: () => metadataSteps };
}

test("bounded remote batches, partial failure, retry, and metadata batches never touch siblings", async () => {
  const targetFile = new ObjectId();
  const assets: DeletionAsset[] = Array.from({ length: 10 }, (_, n) => ({ fileId: targetFile, publicId: opaque(n + 20),
    assetId: `asset-${n}`, resourceType: "raw", deliveryType: "authenticated", format: "dat", completed: false }));
  const initial = deletionJobSchema.parse({ _id: new ObjectId(), ownerId: owner, targetType: "folder", targetId: root,
    folderIds: [root, new ObjectId()], fileIds: [targetFile], inventoryComplete: true, cloudAssets: assets,
    phase: "deleting", status: "pending", attempts: 0, createdAt: now, updatedAt: now });
  const state = memoryStore(initial);
  const calls: string[] = [];
  let fail = true;
  const provider = { remove: async (asset: DeletionAsset) => {
    calls.push(asset.publicId);
    assert.notEqual(asset.publicId, opaque(2));
    if (asset.publicId === assets[8].publicId && fail) { fail = false; throw new Error("injected provider outage"); }
  } };
  let result = await processFolderDeletion(state.store, provider, owner, initial._id, now);
  assert.equal(result.status, "pending");
  assert.equal(result.cloudAssets.filter((asset) => asset.completed).length, 8);
  assert.equal(state.metadataSteps(), 0);
  result = await processFolderDeletion(state.store, provider, owner, initial._id, now);
  assert.equal(result.status, "retrying");
  assert.equal(result.cloudAssets.filter((asset) => asset.completed).length, 8);
  assert.equal(state.metadataSteps(), 0);
  result = await processFolderDeletion(state.store, provider, owner, initial._id, new Date(result.nextAttemptAt!.getTime() + 1));
  assert.equal(result.status, "pending");
  assert.equal(result.phase, "remote-delete-confirmed");
  assert.equal(state.metadataSteps(), 1);
  result = await processFolderDeletion(state.store, provider, owner, initial._id);
  assert.equal(result.status, "pending");
  result = await processFolderDeletion(state.store, provider, owner, initial._id);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 11);
  assert.equal((await processFolderDeletion(state.store, provider, owner, initial._id)).status, "completed");
  assert.equal(calls.length, 11);
});

test("database failure after remote confirmation remains retryable without repeating remote deletion", async () => {
  const asset: DeletionAsset = { fileId: new ObjectId(), publicId: opaque(99), assetId: "synthetic-99",
    resourceType: "raw", deliveryType: "authenticated", format: "dat", completed: false };
  const initial = deletionJobSchema.parse({ _id: new ObjectId(), ownerId: owner, targetType: "folder", targetId: root,
    folderIds: [root], fileIds: [asset.fileId], inventoryComplete: true, cloudAssets: [asset],
    phase: "deleting", status: "pending", attempts: 0, createdAt: now, updatedAt: now });
  const state = memoryStore(initial, 1);
  let remoteCalls = 0;
  const provider = { remove: async () => { remoteCalls++; } };
  let result = await processFolderDeletion(state.store, provider, owner, initial._id, now);
  assert.equal(result.status, "retrying");
  assert.equal(result.phase, "remote-delete-confirmed");
  assert.equal(remoteCalls, 1);
  result = await processFolderDeletion(state.store, provider, owner, initial._id, new Date(result.nextAttemptAt!.getTime() + 1));
  assert.equal(result.status, "pending");
  result = await processFolderDeletion(state.store, provider, owner, initial._id);
  assert.equal(result.status, "pending");
  result = await processFolderDeletion(state.store, provider, owner, initial._id);
  assert.equal(result.status, "completed");
  assert.equal(remoteCalls, 1);
});
