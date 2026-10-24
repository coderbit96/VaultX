import type { Db } from "mongodb";
import { getModelCollections } from "@/lib/database/models";
import { mongoUploadStore } from "@/lib/database/upload-lifecycle-store";
import { cancelUpload, type UploadProvider } from "./lifecycle";

// Run from a scheduled worker or the guarded CLI. Keep failed jobs in MongoDB
// so every planned Cloudinary ID remains available for a later retry.
export async function reconcileExpiredUploads(db: Db, provider: UploadProvider, now = new Date(), limit = 4) {
  const { uploadJobs, files } = getModelCollections(db);
  const jobs = await uploadJobs.find({ manifest: { $exists: true }, intentExpiresAt: { $lte: now },
    $or: [{ status: "pending" }, { status: "failed", attempts: { $lt: 8 }, cancelRequestedAt: { $exists: false } },
      { status: "failed", attempts: { $lt: 8 }, lastErrorCode: { $nin: ["provider_mismatch", "invalid_request"] } },
      { status: "retrying", nextAttemptAt: { $lte: now } },
      { status: "running", leaseExpiresAt: { $lte: now } }] })
    .sort({ intentExpiresAt: 1, _id: 1 }).limit(Math.min(Math.max(limit, 1), 4)).toArray();
  let cleaned = 0, deferred = 0;
  const store = mongoUploadStore(db);
  for (const job of jobs) {
    try {
      // An uncertain commit must never cause deletion of a ready object.
      // A committed file may already be deleting. Its deletion job owns the inventory.
      const committed = await files.findOne({ _id: job.fileId, ownerId: job.ownerId });
      if (committed) { deferred++; continue; }
      const result = await cancelUpload(store, provider, job.ownerId, job._id, now);
      if (result.status === "cancelled") cleaned++;
      else deferred++;
    } catch { deferred++; }
  }
  return { scanned: jobs.length, cleaned, deferred };
}
