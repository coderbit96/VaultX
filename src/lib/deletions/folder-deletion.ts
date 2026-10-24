import { randomBytes } from "node:crypto";
import type { ObjectId } from "mongodb";
import type { FolderDeletionStore } from "@/lib/database/folder-deletions";
import { DeletionFailure, nextDeletionAttempt, type DeletionProvider } from "./file-deletion";

const REMOTE_BATCH = 8;

export async function processFolderDeletion(store: FolderDeletionStore, provider: DeletionProvider,
  ownerId: ObjectId, id: ObjectId, now = new Date(), force = false) {
  const current = await store.get(ownerId, id);
  if (!current || current.targetType !== "folder") throw new DeletionFailure("not_found");
  if (current.status === "completed") return current;
  const token = randomBytes(16).toString("hex");
  const job = await store.acquire(ownerId, id, token, now, force);
  if (!job) return (await store.get(ownerId, id)) ?? current;
  try {
    const files = new Set(job.fileIds.map((fileId) => fileId.toHexString()));
    if (!job.inventoryComplete || job.folderIds.length === 0 || !job.folderIds[0].equals(job.targetId)
      || job.cloudAssets.some((asset) => !files.has(asset.fileId.toHexString()))) {
      throw new DeletionFailure("invalid_inventory");
    }
    if (job.phase === "deleting") {
      const pending = job.cloudAssets.filter((asset) => !asset.completed);
      for (const asset of pending.slice(0, REMOTE_BATCH)) {
        try { await provider.remove(asset); }
        catch (error) { throw error instanceof DeletionFailure ? error : new DeletionFailure("provider_unavailable"); }
        await store.markAsset(job, token, asset, new Date());
      }
      if (pending.length > REMOTE_BATCH) {
        await store.defer(job, token, new Date());
        return (await store.get(ownerId, id)) ?? job;
      }
      await store.setPhase(job, token, "remote-delete-confirmed", new Date());
    }
    if (job.phase === "deleting" || job.phase === "remote-delete-confirmed") {
      if (!await store.removeFolderMetadata(job, token, new Date())) {
        await store.defer(job, token, new Date());
        return (await store.get(ownerId, id)) ?? job;
      }
    }
    await store.finish(job, token, new Date());
  } catch (error) {
    const code = error instanceof DeletionFailure ? error.code : "metadata_unavailable";
    const next = job.attempts >= 8 || ["invalid_inventory", "identity_mismatch", "state_conflict"].includes(code)
      ? null : nextDeletionAttempt(job.attempts, new Date());
    await store.fail(job, token, code, next, new Date());
  }
  const updated = await store.get(ownerId, id);
  if (!updated) throw new DeletionFailure("metadata_unavailable");
  return updated;
}
