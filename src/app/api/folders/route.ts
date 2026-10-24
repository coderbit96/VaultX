import type { NextRequest } from "next/server";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { objectIdText, parseObjectId, readJsonRequest } from "@/lib/auth/request-validation";
import { encryptedNameSchema } from "@/lib/crypto/folder-name-schema";
import { createFolder, FolderOperationError, listFolders } from "@/lib/database/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createInput = z.strictObject({ id: objectIdText, parentFolderId: objectIdText.nullable(), nameEncrypted: encryptedNameSchema });

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some((key) => !["parentId", "after"].includes(key)) || params.getAll("parentId").length > 1 || params.getAll("after").length > 1) return apiError(400, "invalid_request");
  const rawParent = params.get("parentId"), rawAfter = params.get("after");
  const parentId = rawParent === null ? null : parseObjectId(rawParent);
  const after = rawAfter === null ? undefined : parseObjectId(rawAfter);
  if ((rawParent !== null && !parentId) || (rawAfter !== null && !after)) return apiError(400, "invalid_request");
  try {
    const result = await listFolders(auth.context.db, auth.context.ownerId, parentId, after ?? undefined);
    return apiOk({ path: result.path.map((folder) => ({ id: folder._id.toHexString(), nameEncrypted: folder.nameEncrypted })),
      folders: result.folders.map((folder) => ({ id: folder._id.toHexString(), parentFolderId: folder.parentFolderId?.toHexString() ?? null,
        nameEncrypted: folder.nameEncrypted, createdAt: folder.createdAt.toISOString(), updatedAt: folder.updatedAt.toISOString() })),
      nextCursor: result.nextCursor });
  } catch (error) { return error instanceof FolderOperationError && error.code === "not_found" ? apiError(404, "not_found") : apiError(503, "unavailable"); }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const input = await readJsonRequest(request, createInput, 1_024);
  if (!input.ok) return apiError(400, "invalid_request");
  try {
    const folder = await createFolder(auth.context.db, auth.context.ownerId, parseObjectId(input.data.id)!,
      input.data.parentFolderId ? parseObjectId(input.data.parentFolderId)! : null, input.data.nameEncrypted);
    return apiOk({ folder: { id: folder._id.toHexString(), parentFolderId: folder.parentFolderId?.toHexString() ?? null,
      nameEncrypted: folder.nameEncrypted } });
  } catch (error) {
    if (error instanceof FolderOperationError) return apiError(error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : 503, error.code);
    if (error instanceof MongoServerError && error.code === 11000) return apiError(400, "invalid_request");
    return apiError(503, "unavailable");
  }
}
