import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId } from "@/lib/auth/request-validation";
import { fileCategorySchema, listReadyFiles, parseFileCursor } from "@/lib/database/files";
import { FolderOperationError } from "@/lib/database/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const query = request.nextUrl.searchParams;
  const allowed = new Set(["folderId", "scope", "category", "after"]);
  if ([...query.keys()].some((key) => !allowed.has(key) || query.getAll(key).length !== 1)) return apiError(400, "invalid_request");
  const rawFolder = query.get("folderId"), scope = query.get("scope"), rawCategory = query.get("category"), rawAfter = query.get("after");
  if ((scope !== null && scope !== "all") || (scope === "all" && rawFolder !== null)) return apiError(400, "invalid_request");
  const folderId = rawFolder === null ? null : parseObjectId(rawFolder);
  const category = rawCategory === null ? undefined : fileCategorySchema.safeParse(rawCategory);
  const after = rawAfter === null ? undefined : parseFileCursor(rawAfter);
  if ((rawFolder !== null && !folderId) || (category && !category.success) || (rawAfter !== null && !after)) return apiError(400, "invalid_request");
  try {
    return apiOk(await listReadyFiles(auth.context.db, auth.context.ownerId,
      { folderId, allFolders: scope === "all", ...(category?.success ? { category: category.data } : {}), ...(after ? { after } : {}) }));
  } catch (error) {
    return error instanceof FolderOperationError && error.code === "not_found" ? apiError(404, "not_found") : apiError(503, "unavailable");
  }
}
