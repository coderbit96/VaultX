import { randomBytes } from "node:crypto";
import type { ObjectId } from "mongodb";
import type { DeletionJob } from "@/lib/database/models";

export type DeletionAsset = DeletionJob["cloudAssets"][number];

export class DeletionFailure extends Error {
  constructor(readonly code: "not_found" | "invalid_inventory" | "identity_mismatch" | "provider_unavailable" | "metadata_unavailable" | "state_conflict") {
    super(code);
  }
}

export interface DeletionProvider {
  // Must verify the exact recorded asset identity is absent before returning.
  remove(asset: DeletionAsset): Promise<void>;
}

export interface DeletionStore {
  get(ownerId: ObjectId, id: ObjectId): Promise<DeletionJob | null>;
  acquire(ownerId: ObjectId, id: ObjectId, token: string, now: Date, force: boolean): Promise<DeletionJob | null>;
  markAsset(job: DeletionJob, token: string, asset: DeletionAsset, now: Date): Promise<void>;
  setPhase(job: DeletionJob, token: string, phase: "remote-delete-confirmed", now: Date): Promise<void>;
  removeMetadata(job: DeletionJob, token: string, now: Date): Promise<void>;
  finish(job: DeletionJob, token: string, now: Date): Promise<void>;
  fail(job: DeletionJob, token: string, code: DeletionFailure["code"], nextAttemptAt: Date | null, now: Date): Promise<void>;
}

export function nextDeletionAttempt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(3_600_000, 2 ** Math.min(attempts, 11) * 1_000));
}

export function publicDeletionStatus(job: DeletionJob) {
  const safeCodes = new Set(["invalid_inventory", "identity_mismatch", "provider_unavailable", "metadata_unavailable", "state_conflict"]);
  return { id: job._id.toHexString(), targetType: job.targetType, targetId: job.targetId.toHexString(),
    status: job.status, phase: job.phase, attempts: job.attempts,
    folderCount: job.folderIds.length, fileCount: job.fileIds.length,
    remainingObjects: job.cloudAssets.filter((asset) => !asset.completed).length,
    nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
    lastErrorCode: job.lastErrorCode && safeCodes.has(job.lastErrorCode) ? job.lastErrorCode : null,
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString() };
}

export async function processFileDeletion(store: DeletionStore, provider: DeletionProvider,
  ownerId: ObjectId, id: ObjectId, now = new Date(), force = false) {
  const current = await store.get(ownerId, id);
  if (!current || current.targetType !== "file") throw new DeletionFailure("not_found");
  if (current.status === "completed") return current;
  const token = randomBytes(16).toString("hex");
  const job = await store.acquire(ownerId, id, token, now, force);
  if (!job) return (await store.get(ownerId, id)) ?? current;
  try {
    if (!job.inventoryComplete || job.fileIds.length !== 1 || !job.fileIds[0].equals(job.targetId)
      || job.cloudAssets.length < 1 || job.cloudAssets.some((asset) => !asset.fileId.equals(job.targetId))) {
      throw new DeletionFailure("invalid_inventory");
    }
    if (job.phase === "deleting") {
      for (const asset of job.cloudAssets) {
        if (asset.completed) continue;
        try { await provider.remove(asset); }
        catch (error) { throw error instanceof DeletionFailure ? error : new DeletionFailure("provider_unavailable"); }
        await store.markAsset(job, token, asset, new Date());
      }
      await store.setPhase(job, token, "remote-delete-confirmed", new Date());
    }
    if (job.phase === "deleting" || job.phase === "remote-delete-confirmed") {
      await store.removeMetadata(job, token, new Date());
    }
    if (["deleting", "remote-delete-confirmed", "metadata-removed"].includes(job.phase)) {
      await store.finish(job, token, new Date());
    } else throw new DeletionFailure("invalid_inventory");
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
