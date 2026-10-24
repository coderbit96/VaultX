import type { Db } from "mongodb";
import { getModelCollections } from "@/lib/database/models";
import { mongoDeletionStore } from "@/lib/database/file-deletions";
import { mongoFolderDeletionStore } from "@/lib/database/folder-deletions";
import { processFileDeletion, type DeletionProvider } from "./file-deletion";
import { processFolderDeletion } from "./folder-deletion";

export async function reconcileDeletions(db: Db, provider: DeletionProvider, now = new Date(), limit = 4) {
  const jobs = await getModelCollections(db).deletionJobs.find({
    $or: [{ status: "pending" }, { status: "retrying", nextAttemptAt: { $lte: now } },
      { status: "running", leaseExpiresAt: { $lte: now } }] })
    .sort({ updatedAt: 1, _id: 1 }).limit(Math.min(Math.max(limit, 1), 4)).toArray();
  const store = mongoDeletionStore(db);
  const folderStore = mongoFolderDeletionStore(db);
  let completed = 0, deferred = 0;
  for (const job of jobs) {
    try {
      const updated = job.targetType === "folder"
        ? await processFolderDeletion(folderStore, provider, job.ownerId, job._id, now)
        : await processFileDeletion(store, provider, job.ownerId, job._id, now);
      if (updated.status === "completed") completed++;
      else deferred++;
    } catch { deferred++; }
  }
  return { scanned: jobs.length, completed, deferred };
}
