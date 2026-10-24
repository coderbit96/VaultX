import { MongoServerError, ObjectId, type ClientSession, type Db } from "mongodb";
import { activeAncestry } from "./folders";
import { getModelCollections, deletionJobSchema, type DeletionJob, type Folder, type UploadJob, type VaultFile } from "./models";
import { inventoryFileAssets, mongoDeletionStore } from "./file-deletions";
import { DeletionFailure, type DeletionAsset, type DeletionStore } from "@/lib/deletions/file-deletion";

// A single MongoDB job must stay comfortably below the 16 MiB document limit.
// Oversized trees fail before any fence or remote mutation; they need a sharded
// inventory design, not a partial deletion.
const MAX_FOLDERS = 10_000;
const MAX_FILES = 10_000;
const MAX_ASSETS = 20_000;
const BATCH = 100;

function batches<T>(values: T[], size = 500): T[][] {
  const result: T[][] = [];
  for (let at = 0; at < values.length; at += size) result.push(values.slice(at, at + size));
  return result;
}

export async function inspectFolderSubtree(db: Db, ownerId: ObjectId, rootId: ObjectId, session?: ClientSession) {
  const { folders, files, uploadJobs } = getModelCollections(db);
  const ancestry = await activeAncestry(db, ownerId, rootId, session);
  if (!ancestry.length) throw new DeletionFailure("not_found");
  const ordered: Folder[] = [ancestry[0]];
  const seen = new Set([rootId.toHexString()]);
  let frontier = [rootId];
  for (let depth = 0; frontier.length; depth++) {
    if (depth >= 128) throw new DeletionFailure("invalid_inventory");
    const children = await folders.find({ ownerId, parentFolderId: { $in: frontier } }, { session }).toArray();
    if (ordered.length + children.length > MAX_FOLDERS || children.some((item) => item.status !== "active")) {
      throw new DeletionFailure("state_conflict");
    }
    for (const child of children) {
      if (seen.has(child._id.toHexString())) throw new DeletionFailure("invalid_inventory");
      seen.add(child._id.toHexString());
    }
    ordered.push(...children);
    frontier = children.map((item) => item._id);
  }
  const folderIds = ordered.map((item) => item._id);
  const containedFiles: VaultFile[] = [];
  const pendingUploads: UploadJob[] = [];
  for (const slice of batches(folderIds)) {
    containedFiles.push(...await files.find({ ownerId, folderId: { $in: slice } }, { session }).toArray());
    pendingUploads.push(...await uploadJobs.find({ ownerId, folderId: { $in: slice },
      status: { $nin: ["completed", "cancelled"] } }, { session }).toArray());
    if (containedFiles.length > MAX_FILES || pendingUploads.length > MAX_FILES) throw new DeletionFailure("invalid_inventory");
  }
  if (containedFiles.some((file) => file.status !== "ready")) throw new DeletionFailure("state_conflict");
  if (pendingUploads.length) throw new DeletionFailure("state_conflict");
  const uploads: UploadJob[] = [];
  for (const slice of batches(containedFiles.map((file) => file._id))) {
    uploads.push(...await uploadJobs.find({ ownerId, fileId: { $in: slice } }, { session }).toArray());
    if (uploads.length > MAX_FILES) throw new DeletionFailure("invalid_inventory");
  }
  const fileMap = new Map(containedFiles.map((file) => [file._id.toHexString(), file]));
  const uploadAssets = new Map<string, typeof uploads[number]["cloudAssets"]>();
  for (const upload of uploads) {
    if (upload.status === "cancelled") continue;
    if (upload.status !== "completed") throw new DeletionFailure("state_conflict");
    const key = upload.fileId.toHexString();
    if (!fileMap.has(key)) throw new DeletionFailure("invalid_inventory");
    uploadAssets.set(key, [...(uploadAssets.get(key) ?? []), ...upload.cloudAssets]);
  }
  const cloudAssets: DeletionAsset[] = containedFiles.flatMap((file) =>
    inventoryFileAssets(file, uploadAssets.get(file._id.toHexString()) ?? []));
  if (cloudAssets.length > MAX_ASSETS || new Set(cloudAssets.map((asset) => asset.publicId)).size !== cloudAssets.length) {
    throw new DeletionFailure("invalid_inventory");
  }
  return { folderIds, fileIds: containedFiles.map((file) => file._id), cloudAssets,
    folderCount: folderIds.length, fileCount: containedFiles.length, objectCount: cloudAssets.length };
}

export type FolderDeletionCounts = { folderCount: number; fileCount: number; objectCount: number };

export async function queueFolderDeletion(db: Db, ownerId: ObjectId, rootId: ObjectId,
  now = new Date(), expected?: FolderDeletionCounts): Promise<DeletionJob> {
  const { owners, folders, files, deletionJobs } = getModelCollections(db);
  try {
    const queued = await db.client.withSession((session) => session.withTransaction(async () => {
      // The same owner write serializes all tree/file moves and upload commits.
      const owner = await owners.updateOne({ _id: ownerId, singletonKey: "vaultx-owner" },
        { $inc: { folderTreeRevision: 1 } }, { session });
      if (owner.matchedCount !== 1) throw new DeletionFailure("not_found");
      const existing = await deletionJobs.findOne({ ownerId, targetType: "folder", targetId: rootId }, { session });
      if (existing) return existing;
      const snapshot = await inspectFolderSubtree(db, ownerId, rootId, session);
      if (expected && (snapshot.folderCount !== expected.folderCount || snapshot.fileCount !== expected.fileCount
        || snapshot.objectCount !== expected.objectCount)) throw new DeletionFailure("state_conflict");
      const job = deletionJobSchema.parse({ _id: new ObjectId(), ownerId, targetType: "folder", targetId: rootId,
        fileIds: snapshot.fileIds, folderIds: snapshot.folderIds, cloudAssets: snapshot.cloudAssets,
        inventoryComplete: true, phase: "deleting", status: "pending", attempts: 0,
        createdAt: now, updatedAt: now });
      await deletionJobs.insertOne(job, { session });
      const fencedFolders = await folders.updateMany({ _id: { $in: snapshot.folderIds }, ownerId, status: "active" },
        { $set: { status: "deleting", updatedAt: now } }, { session });
      if (fencedFolders.matchedCount !== snapshot.folderCount) throw new DeletionFailure("state_conflict");
      if (snapshot.fileCount) {
        const fencedFiles = await files.updateMany({ _id: { $in: snapshot.fileIds }, ownerId, status: "ready" },
          { $set: { status: "deleting", updatedAt: now } }, { session });
        if (fencedFiles.matchedCount !== snapshot.fileCount) throw new DeletionFailure("state_conflict");
      }
      return job;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
    if (!queued) throw new DeletionFailure("metadata_unavailable");
    return queued;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const existing = await deletionJobs.findOne({ ownerId, targetType: "folder", targetId: rootId });
      if (existing) return existing;
    }
    throw error;
  }
}

export interface FolderDeletionStore extends DeletionStore {
  removeFolderMetadata(job: DeletionJob, token: string, now: Date): Promise<boolean>;
  defer(job: DeletionJob, token: string, now: Date): Promise<void>;
}

export function mongoFolderDeletionStore(db: Db): FolderDeletionStore {
  const base = mongoDeletionStore(db, "folder");
  const { files, folders, deletionJobs } = getModelCollections(db);
  return { ...base,
    async defer(job, token, now) {
      const result = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId, targetType: "folder",
        status: "running", leaseToken: token },
      { $set: { status: "pending", updatedAt: now }, $unset: { leaseToken: "", leaseExpiresAt: "" } });
      if (result.matchedCount !== 1) throw new DeletionFailure("state_conflict");
    },
    async removeFolderMetadata(job, token, now) {
      const done = await db.client.withSession((session) => session.withTransaction(async () => {
        const current = await deletionJobs.findOne({ _id: job._id, ownerId: job.ownerId,
          targetType: "folder", status: "running", leaseToken: token, phase: "remote-delete-confirmed" }, { session });
        if (!current || current.cloudAssets.some((asset) => !asset.completed)) throw new DeletionFailure("state_conflict");
        const remainingFiles = await files.find({ _id: { $in: job.fileIds }, ownerId: job.ownerId }, { session,
          projection: { _id: 1, folderId: 1, status: 1 } }).limit(BATCH).toArray();
        if (remainingFiles.length) {
          const allowed = new Set(job.folderIds.map((id) => id.toHexString()));
          if (remainingFiles.some((file) => file.status !== "deleting" || !file.folderId || !allowed.has(file.folderId.toHexString()))) {
            throw new DeletionFailure("state_conflict");
          }
          const result = await files.deleteMany({ _id: { $in: remainingFiles.map((file) => file._id) },
            ownerId: job.ownerId, status: "deleting" }, { session });
          if (result.deletedCount !== remainingFiles.length) throw new DeletionFailure("state_conflict");
          return false;
        }
        // BFS inventory reversed is bottom-up. Each batch is committed before
        // its ancestors can be removed in a later pass.
        const remainingFolders = await folders.find({ _id: { $in: job.folderIds }, ownerId: job.ownerId },
          { session, projection: { _id: 1, status: 1 } }).toArray();
        if (remainingFolders.length) {
          const present = new Set(remainingFolders.map((folder) => folder._id.toHexString()));
          if (remainingFolders.some((folder) => folder.status !== "deleting")) throw new DeletionFailure("state_conflict");
          const batch = job.folderIds.slice().reverse().filter((id) => present.has(id.toHexString())).slice(0, BATCH);
          for (const id of batch) {
            if (await folders.findOne({ ownerId: job.ownerId, parentFolderId: id }, { session, projection: { _id: 1 } })) {
              throw new DeletionFailure("state_conflict");
            }
            const result = await folders.deleteOne({ _id: id, ownerId: job.ownerId, status: "deleting" }, { session });
            if (result.deletedCount !== 1) throw new DeletionFailure("state_conflict");
          }
          return false;
        }
        const updated = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId,
          targetType: "folder", status: "running", leaseToken: token, phase: "remote-delete-confirmed" },
        { $set: { phase: "metadata-removed", updatedAt: now } }, { session });
        if (updated.matchedCount !== 1) throw new DeletionFailure("state_conflict");
        return true;
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
      if (done === undefined) throw new DeletionFailure("metadata_unavailable");
      return done;
    },
  };
}
