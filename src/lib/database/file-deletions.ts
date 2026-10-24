import { MongoServerError, ObjectId, type Db } from "mongodb";
import { activeAncestry } from "./folders";
import { deletionJobSchema, getModelCollections, type DeletionJob, type VaultFile } from "./models";
import { hasVerifiedCiphertext } from "./files";
import { DeletionFailure, type DeletionAsset, type DeletionStore } from "@/lib/deletions/file-deletion";

const opaqueId = /^vaultx\/(?:ciphertext|thumbnails)\/[a-f0-9]{48}\.dat$/;
type Identity = NonNullable<VaultFile["cloudinary"]>;

export function inventoryFileAssets(file: VaultFile, extra: Identity[] = []): DeletionAsset[] {
  if (!hasVerifiedCiphertext(file) || !file.cloudinary) throw new DeletionFailure("invalid_inventory");
  const entries = [file.cloudinary, ...(file.thumbnail ? [file.thumbnail.cloudinary] : []), ...extra];
  const unique = new Map<string, DeletionAsset>();
  for (const asset of entries) {
    if (!opaqueId.test(asset.publicId) || asset.resourceType !== "raw" || asset.deliveryType !== "authenticated" || asset.format !== "dat") {
      throw new DeletionFailure("invalid_inventory");
    }
    const existing = unique.get(asset.publicId);
    if (existing && existing.assetId && asset.assetId && existing.assetId !== asset.assetId) throw new DeletionFailure("identity_mismatch");
    unique.set(asset.publicId, { fileId: file._id, publicId: asset.publicId,
      ...(asset.assetId || existing?.assetId ? { assetId: asset.assetId ?? existing?.assetId } : {}),
      resourceType: "raw", deliveryType: "authenticated", format: "dat",
      ...(asset.version ? { version: asset.version } : {}), completed: false });
  }
  if (unique.size < 1 || unique.size > 100_000) throw new DeletionFailure("invalid_inventory");
  return [...unique.values()];
}

export async function queueFileDeletion(db: Db, ownerId: ObjectId, fileId: ObjectId, now = new Date()): Promise<DeletionJob> {
  const { owners, files, uploadJobs, deletionJobs } = getModelCollections(db);
  try {
    const queued = await db.client.withSession((session) => session.withTransaction(async () => {
      // This write serializes with folder moves, uploads, and file renames.
      const owner = await owners.updateOne({ _id: ownerId, singletonKey: "vaultx-owner" },
        { $inc: { folderTreeRevision: 1 } }, { session });
      if (owner.matchedCount !== 1) throw new DeletionFailure("not_found");
      const existing = await deletionJobs.findOne({ ownerId, targetType: "file", targetId: fileId }, { session });
      if (existing) return existing;
      const file = await files.findOne({ _id: fileId, ownerId, status: "ready" }, { session });
      if (!file) throw new DeletionFailure("not_found");
      await activeAncestry(db, ownerId, file.folderId, session);
      const uploads = await uploadJobs.find({ ownerId, fileId }, { session, projection: { cloudAssets: 1 } }).toArray();
      const cloudAssets = inventoryFileAssets(file, uploads.flatMap((upload) => upload.cloudAssets));
      const job = deletionJobSchema.parse({ _id: new ObjectId(), ownerId, targetType: "file", targetId: fileId,
        fileIds: [fileId], folderIds: [], inventoryComplete: true, cloudAssets,
        phase: "deleting", status: "pending", attempts: 0, createdAt: now, updatedAt: now });
      await deletionJobs.insertOne(job, { session });
      const marked = await files.updateOne({ _id: fileId, ownerId, status: "ready" },
        { $set: { status: "deleting", updatedAt: now } }, { session });
      if (marked.matchedCount !== 1) throw new DeletionFailure("state_conflict");
      return job;
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
    if (!queued) throw new DeletionFailure("metadata_unavailable");
    return queued;
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      const existing = await deletionJobs.findOne({ ownerId, targetType: "file", targetId: fileId });
      if (existing) return existing;
    }
    throw error;
  }
}

function assertMatched(count: number) { if (count !== 1) throw new DeletionFailure("state_conflict"); }

export function mongoDeletionStore(db: Db, targetType: "file" | "folder" = "file"): DeletionStore {
  const { deletionJobs, files } = getModelCollections(db);
  return {
    get: (ownerId, id) => deletionJobs.findOne({ _id: id, ownerId }),
    acquire: async (ownerId, id, token, now, force) => deletionJobs.findOneAndUpdate({ _id: id, ownerId, targetType,
      $or: [{ status: "pending" }, { status: "retrying", ...(!force ? { nextAttemptAt: { $lte: now } } : {}) },
        { status: "running", leaseExpiresAt: { $lte: now } }, ...(force ? [{ status: "failed" as const }] : [])] },
    { $set: { status: "running", leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 10 * 60_000), updatedAt: now },
      $inc: { attempts: 1 }, $unset: { nextAttemptAt: "", lastErrorCode: "" } }, { returnDocument: "after" }),
    async markAsset(job, token, asset, now) {
      const result = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId, status: "running", phase: "deleting",
        leaseToken: token, cloudAssets: { $elemMatch: { publicId: asset.publicId, fileId: asset.fileId, completed: false } } },
      { $set: { "cloudAssets.$[asset].completed": true, updatedAt: now } },
      { arrayFilters: [{ "asset.publicId": asset.publicId, "asset.fileId": asset.fileId, "asset.completed": false }] });
      assertMatched(result.matchedCount);
    },
    async setPhase(job, token, phase, now) {
      const current = await deletionJobs.findOne({ _id: job._id, ownerId: job.ownerId, status: "running", leaseToken: token });
      if (!current || current.phase !== "deleting" || current.cloudAssets.some((asset) => !asset.completed)) throw new DeletionFailure("state_conflict");
      const result = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId, status: "running", phase: "deleting", leaseToken: token },
        { $set: { phase, updatedAt: now } });
      assertMatched(result.matchedCount);
    },
    async removeMetadata(job, token, now) {
      await db.client.withSession((session) => session.withTransaction(async () => {
        const current = await deletionJobs.findOne({ _id: job._id, ownerId: job.ownerId, status: "running", leaseToken: token }, { session });
        if (!current || current.phase !== "remote-delete-confirmed" || current.cloudAssets.some((asset) => !asset.completed)) {
          throw new DeletionFailure("state_conflict");
        }
        const file = await files.findOne({ _id: job.targetId, ownerId: job.ownerId }, { session });
        if (file && file.status !== "deleting") throw new DeletionFailure("state_conflict");
        if (file) await files.deleteOne({ _id: job.targetId, ownerId: job.ownerId, status: "deleting" }, { session });
        const result = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId, status: "running",
          phase: "remote-delete-confirmed", leaseToken: token }, { $set: { phase: "metadata-removed", updatedAt: now } }, { session });
        assertMatched(result.matchedCount);
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
    },
    async finish(job, token, now) {
      if (job.targetType === "file") {
        if (await files.findOne({ _id: job.targetId, ownerId: job.ownerId })) throw new DeletionFailure("state_conflict");
      } else {
        if (await files.findOne({ _id: { $in: job.fileIds }, ownerId: job.ownerId })
          || await getModelCollections(db).folders.findOne({ _id: { $in: job.folderIds }, ownerId: job.ownerId })) {
          throw new DeletionFailure("state_conflict");
        }
      }
      const result = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId, status: "running",
        phase: "metadata-removed", leaseToken: token, cloudAssets: { $not: { $elemMatch: { completed: false } } } },
      { $set: { phase: "completed", status: "completed", updatedAt: now },
        $unset: { leaseToken: "", leaseExpiresAt: "", nextAttemptAt: "", lastErrorCode: "" } });
      assertMatched(result.matchedCount);
    },
    async fail(job, token, code, nextAttemptAt, now) {
      const result = await deletionJobs.updateOne({ _id: job._id, ownerId: job.ownerId, status: "running", leaseToken: token },
        { $set: { status: nextAttemptAt ? "retrying" : "failed", lastErrorCode: code, updatedAt: now,
          ...(nextAttemptAt ? { nextAttemptAt } : {}) },
          $unset: { leaseToken: "", leaseExpiresAt: "", ...(!nextAttemptAt ? { nextAttemptAt: "" } : {}) } });
      assertMatched(result.matchedCount);
    },
  };
}
