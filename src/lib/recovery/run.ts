import type { Db } from "mongodb";
import type { DeletionProvider } from "@/lib/deletions/file-deletion";
import { reconcileDeletions } from "@/lib/deletions/reconcile";
import type { UploadProvider } from "@/lib/uploads/lifecycle";
import { reconcileExpiredUploads } from "@/lib/uploads/reconcile";

/** One bounded pass. MongoDB job leases coordinate overlapping runners. */
export async function runRecoveryPass(db: Db, providers: { uploads: UploadProvider; deletions: DeletionProvider },
  now = new Date(), perKindLimit = 2) {
  const limit = Math.min(Math.max(Math.trunc(perKindLimit), 1), 4);
  const [uploads, deletions] = await Promise.all([
    reconcileExpiredUploads(db, providers.uploads, now, limit),
    reconcileDeletions(db, providers.deletions, now, limit),
  ]);
  return { uploads, deletions };
}
