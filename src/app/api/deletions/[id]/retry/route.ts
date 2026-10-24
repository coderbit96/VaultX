import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId, readJsonRequest } from "@/lib/auth/request-validation";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryDeletionProvider } from "@/lib/cloudinary/deletion-provider";
import { mongoDeletionStore } from "@/lib/database/file-deletions";
import { mongoFolderDeletionStore } from "@/lib/database/folder-deletions";
import { DeletionFailure, processFileDeletion, publicDeletionStatus } from "@/lib/deletions/file-deletion";
import { processFolderDeletion } from "@/lib/deletions/folder-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  const body = await readJsonRequest(request, z.strictObject({}), 16);
  if (!body.ok) return apiError(400, "invalid_request");
  try {
    const store = mongoDeletionStore(auth.context.db);
    const current = await store.get(auth.context.ownerId, id);
    if (!current) return apiError(404, "not_found");
    const provider = cloudinaryDeletionProvider(getCloudinary());
    const job = current.targetType === "folder"
      ? await processFolderDeletion(mongoFolderDeletionStore(auth.context.db), provider, auth.context.ownerId, id, new Date(), true)
      : await processFileDeletion(store, provider, auth.context.ownerId, id, new Date(), true);
    return apiOk({ deletion: publicDeletionStatus(job) });
  } catch (error) { return error instanceof DeletionFailure && error.code === "not_found"
    ? apiError(404, "not_found") : apiError(503, "unavailable"); }
}
