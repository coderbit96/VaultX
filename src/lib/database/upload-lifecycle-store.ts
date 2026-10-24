import { type Db, type Filter, type ObjectId } from "mongodb";
import { findOwnedUploadJob } from "@/lib/auth/owned-resources";
import { activeAncestry } from "./folders";
import { getModelCollections, type UploadJob } from "./models";
import { UploadLifecycleError, type CompletionMetadata, type UploadOperation, type UploadStore } from "@/lib/uploads/lifecycle";

export function mongoUploadStore(db: Db): UploadStore {
  const { uploadJobs, files, owners } = getModelCollections(db);
  return {
    getJob: (ownerId, id) => findOwnedUploadJob(db, ownerId, id.toHexString()),
    getReadyFile: (ownerId, fileId) => files.findOne({ _id: fileId, ownerId, status: "ready" }),
    async acquire(ownerId: ObjectId, id: ObjectId, operation: UploadOperation, token: string,
      expiry: Date, now: Date, metadata?: CompletionMetadata) {
      const current = await findOwnedUploadJob(db, ownerId, id.toHexString());
      if (!current || current.status === "completed" || current.status === "cancelled") return null;
      const filter: Filter<UploadJob> = { _id: id, ownerId,
        ...(operation !== "cancel" ? { cancelRequestedAt: { $exists: false } } : {}),
        $or: [{ status: { $in: ["pending", "retrying", "failed"] } },
          { status: "running", leaseExpiresAt: { $lte: now } }],
        ...(metadata ? current.completionMetadata
          ? { completionMetadata: current.completionMetadata }
          : { completionMetadata: { $exists: false } } : {}),
      };
      return uploadJobs.findOneAndUpdate(filter, { $set: { status: "running", operation,
        leaseToken: token, leaseExpiresAt: expiry, updatedAt: now,
        ...(operation === "cancel" ? { cancelRequestedAt: now } : {}),
        ...(metadata && !current.completionMetadata ? { completionMetadata: metadata } : {}) } },
      { returnDocument: "after" });
    },
    async commitReady(job, token, file, now) {
      await db.client.withSession((session) => session.withTransaction(async () => {
        const lock = await owners.updateOne({ _id: job.ownerId, singletonKey: "vaultx-owner" },
          { $inc: { folderTreeRevision: 1 } }, { session });
        if (lock.matchedCount !== 1) throw new UploadLifecycleError("unavailable");
        const active = await uploadJobs.findOne({ _id: job._id, ownerId: job.ownerId,
          status: "running", operation: "complete", leaseToken: token }, { session });
        if (!active || !active.manifest || !active.cloudAssets[0]?.assetId) throw new UploadLifecycleError("conflict");
        await activeAncestry(db, job.ownerId, active.folderId ?? null, session);
        await files.insertOne(file, { session });
        const result = await uploadJobs.updateOne({ _id: job._id, ownerId: job.ownerId,
          status: "running", operation: "complete", leaseToken: token },
        { $set: { status: "completed", updatedAt: now },
          $unset: { leaseToken: "", leaseExpiresAt: "", operation: "", nextAttemptAt: "", lastErrorCode: "" } }, { session });
        if (result.matchedCount !== 1) throw new UploadLifecycleError("conflict");
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
    },
    async recordState(job, token, status, code, now) {
      const attempt = job.attempts + 1;
      // Provider outages eventually require an explicit owner/admin retry.
      const effectiveStatus = status === "retrying" && attempt >= 8 ? "failed" : status;
      const nextAttemptAt = effectiveStatus === "retrying" ? new Date(now.getTime() + Math.min(60 * 60_000, 2 ** Math.min(attempt, 10) * 1000)) : undefined;
      const result = await uploadJobs.updateOne({ _id: job._id, ownerId: job.ownerId,
        status: "running", leaseToken: token },
      { $set: { status: effectiveStatus, attempts: attempt, updatedAt: now,
        ...(code ? { lastErrorCode: code } : {}), ...(nextAttemptAt ? { nextAttemptAt } : {}),
        ...(status === "cancelled" ? { "cloudAssets.$[].cleanupCompleted": true } : {}) },
        $unset: { leaseToken: "", leaseExpiresAt: "", operation: "",
          ...(!code ? { lastErrorCode: "" } : {}), ...(!nextAttemptAt ? { nextAttemptAt: "" } : {}) } });
      if (result.matchedCount !== 1) throw new UploadLifecycleError("conflict");
    },
    async recordAsset(job, token, asset, now, index = 0) {
      if (index !== 0 && index !== 1) throw new UploadLifecycleError("invalid_request");
      const result = await uploadJobs.updateOne({ _id: job._id, ownerId: job.ownerId,
        status: "running", operation: "transfer", leaseToken: token,
        [`cloudAssets.${index}.publicId`]: asset.publicId },
      { $set: { status: "pending", updatedAt: now,
        [`cloudAssets.${index}.assetId`]: asset.assetId, [`cloudAssets.${index}.version`]: asset.version },
        $unset: { leaseToken: "", leaseExpiresAt: "", operation: "", lastErrorCode: "", nextAttemptAt: "" } });
      if (result.matchedCount !== 1) throw new UploadLifecycleError("conflict");
    },
    async requestCancel(ownerId, id, now) {
      const result = await uploadJobs.updateOne({ _id: id, ownerId, status: "running", operation: "transfer" },
        { $set: { cancelRequestedAt: now, updatedAt: now } });
      return result.matchedCount === 1;
    },
  };
}
