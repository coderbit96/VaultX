import { ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { queueFileDeletion } from "@/lib/database/file-deletions";
import { FolderOperationError } from "@/lib/database/folders";
import { DeletionFailure } from "./file-deletion";

// Each entry creates its own durable, idempotent job. Keep requests small enough
// for Atlas M0 and serverless time limits; the recovery worker does remote work.
export const bulkDeletionInput = z.strictObject({
  ids: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(10)
    .refine((ids) => new Set(ids).size === ids.length),
});

export type BulkDeletionResult = { id: string; status: "queued" | "not_found" | "conflict" | "uncertain"; jobId?: string };

export async function queueBulkFileDeletions(db: Db, ownerId: ObjectId, ids: string[],
  queue: typeof queueFileDeletion = queueFileDeletion): Promise<BulkDeletionResult[]> {
  const results: BulkDeletionResult[] = [];
  for (const id of ids) {
    try {
      const job = await queue(db, ownerId, new ObjectId(id));
      results.push({ id, status: "queued", jobId: job._id.toHexString() });
    } catch (error) {
      if ((error instanceof DeletionFailure || error instanceof FolderOperationError) && error.code === "not_found") {
        results.push({ id, status: "not_found" });
      } else if (error instanceof DeletionFailure && ["invalid_inventory", "identity_mismatch", "state_conflict"].includes(error.code)) {
        results.push({ id, status: "conflict" });
      } else {
        // A database timeout can occur after commit. Do not call it failed or
        // complete: the owner must inspect Deletions and retry idempotently.
        results.push({ id, status: "uncertain" });
      }
    }
  }
  return results;
}
