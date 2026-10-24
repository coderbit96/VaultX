import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk, privateApiHeaders } from "@/lib/auth/api-policy";
import { objectIdText, parseObjectId, readJsonRequest } from "@/lib/auth/request-validation";
import { encryptedNameSchema } from "@/lib/crypto/folder-name-schema";
import { changeFile, FileOperationError, findReadyFileAccessMetadata } from "@/lib/database/files";
import { FolderOperationError } from "@/lib/database/folders";
import { queueFileDeletion, mongoDeletionStore } from "@/lib/database/file-deletions";
import { DeletionFailure, processFileDeletion, publicDeletionStatus } from "@/lib/deletions/file-deletion";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryDeletionProvider } from "@/lib/cloudinary/deletion-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchInput = z.strictObject({ nameEncrypted: encryptedNameSchema.optional(), folderId: objectIdText.nullable().optional(),
  favorite: z.boolean().optional(), tagsEncrypted: z.array(encryptedNameSchema).max(20).optional() })
  .refine((value) => value.nameEncrypted !== undefined || value.folderId !== undefined
    || value.favorite !== undefined || value.tagsEncrypted !== undefined);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  try {
    const file = await findReadyFileAccessMetadata(auth.context.db, auth.context.ownerId, id);
    return file ? apiOk({ file }) : apiError(404, "not_found");
  } catch { return apiError(503, "unavailable"); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  const input = await readJsonRequest(request, patchInput, 16_384);
  if (!input.ok) return apiError(400, "invalid_request");
  try {
    const file = await changeFile(auth.context.db, auth.context.ownerId, id, {
      ...(input.data.nameEncrypted ? { nameEncrypted: input.data.nameEncrypted } : {}),
      ...(input.data.tagsEncrypted ? { tagsEncrypted: input.data.tagsEncrypted } : {}),
      ...(input.data.favorite !== undefined ? { favorite: input.data.favorite } : {}),
      ...(input.data.folderId !== undefined ? { folderId: input.data.folderId ? parseObjectId(input.data.folderId)! : null } : {}),
    });
    return apiOk({ file });
  } catch (error) {
    if (error instanceof FileOperationError || error instanceof FolderOperationError) {
      return apiError(error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : 503, error.code);
    }
    return apiError(503, "unavailable");
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await params).id);
  if (!id) return apiError(404, "not_found");
  try {
    const queued = await queueFileDeletion(auth.context.db, auth.context.ownerId, id);
    let job = queued;
    const store = mongoDeletionStore(auth.context.db);
    try { job = await processFileDeletion(store,
      cloudinaryDeletionProvider(getCloudinary()), auth.context.ownerId, queued._id); }
    catch { job = await store.get(auth.context.ownerId, queued._id) ?? queued; }
    return Response.json({ deletion: publicDeletionStatus(job) }, { status: job.status === "completed" ? 200 : 202,
      headers: privateApiHeaders });
  } catch (error) {
    if (error instanceof DeletionFailure) return error.code === "not_found" ? apiError(404, "not_found")
      : ["invalid_inventory", "identity_mismatch", "state_conflict"].includes(error.code) ? apiError(409, "deletion_conflict")
        : apiError(503, "unavailable");
    if (error instanceof FolderOperationError && error.code === "not_found") return apiError(404, "not_found");
    return apiError(503, "unavailable");
  }
}
