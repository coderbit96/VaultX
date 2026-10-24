import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk, privateApiHeaders } from "@/lib/auth/api-policy";
import { parseObjectId, objectIdText, readJsonRequest } from "@/lib/auth/request-validation";
import { encryptedNameSchema } from "@/lib/crypto/folder-name-schema";
import { changeFolder, FolderOperationError } from "@/lib/database/folders";
import { inspectFolderSubtree, mongoFolderDeletionStore, queueFolderDeletion } from "@/lib/database/folder-deletions";
import { DeletionFailure, publicDeletionStatus } from "@/lib/deletions/file-deletion";
import { processFolderDeletion } from "@/lib/deletions/folder-deletion";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryDeletionProvider } from "@/lib/cloudinary/deletion-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchInput = z.strictObject({ nameEncrypted: encryptedNameSchema.optional(), parentFolderId: objectIdText.nullable().optional() })
  .refine((value) => value.nameEncrypted !== undefined || value.parentFolderId !== undefined);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  try {
    const snapshot = await inspectFolderSubtree(auth.context.db, auth.context.ownerId, id);
    return apiOk({ folderCount: snapshot.folderCount, fileCount: snapshot.fileCount,
      objectCount: snapshot.objectCount });
  } catch (error) {
    if (error instanceof FolderOperationError || error instanceof DeletionFailure) {
      return apiError(error.code === "not_found" ? 404 : error.code === "invalid_inventory" || error.code === "state_conflict" ? 409 : 503,
        error.code === "not_found" ? "not_found" : "deletion_conflict");
    }
    return apiError(503, "unavailable");
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  const input = await readJsonRequest(request, patchInput, 1_024);
  if (!input.ok) return apiError(400, "invalid_request");
  try {
    const folder = await changeFolder(auth.context.db, auth.context.ownerId, id, {
      ...(input.data.nameEncrypted ? { nameEncrypted: input.data.nameEncrypted } : {}),
      ...(input.data.parentFolderId !== undefined ? { parentFolderId: input.data.parentFolderId ? parseObjectId(input.data.parentFolderId)! : null } : {}),
    });
    return apiOk({ folder: { id: folder._id.toHexString(), parentFolderId: folder.parentFolderId?.toHexString() ?? null,
      nameEncrypted: folder.nameEncrypted } });
  } catch (error) {
    if (error instanceof FolderOperationError) return apiError(error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : 503, error.code);
    return apiError(503, "unavailable");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  const input = await readJsonRequest(request, z.strictObject({
    folderCount: z.number().int().min(1).max(10_000), fileCount: z.number().int().min(0).max(10_000),
    objectCount: z.number().int().min(0).max(20_000),
  }), 128);
  if (!input.ok) return apiError(400, "invalid_request");
  try {
    const queued = await queueFolderDeletion(auth.context.db, auth.context.ownerId, id, new Date(), input.data);
    const store = mongoFolderDeletionStore(auth.context.db);
    let job = queued;
    try { job = await processFolderDeletion(store, cloudinaryDeletionProvider(getCloudinary()), auth.context.ownerId, queued._id); }
    catch { job = await store.get(auth.context.ownerId, queued._id) ?? queued; }
    return Response.json({ deletion: publicDeletionStatus(job) }, { status: job.status === "completed" ? 200 : 202,
      headers: privateApiHeaders });
  } catch (error) {
    if (error instanceof FolderOperationError || error instanceof DeletionFailure) {
      return apiError(error.code === "not_found" ? 404 : ["invalid_inventory", "state_conflict", "identity_mismatch"].includes(error.code) ? 409 : 503,
        error.code === "not_found" ? "not_found" : "deletion_conflict");
    }
    return apiError(503, "unavailable");
  }
}
