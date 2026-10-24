import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId } from "@/lib/auth/request-validation";
import { FolderOperationError } from "@/lib/database/folders";
import { getStorageSummary } from "@/lib/database/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const query = request.nextUrl.searchParams;
  if ([...query.keys()].some((key) => key !== "folderId") || query.getAll("folderId").length > 1) return apiError(400, "invalid_request");
  const raw = query.get("folderId");
  const folderId = raw === null ? null : parseObjectId(raw);
  if (raw !== null && !folderId) return apiError(400, "invalid_request");
  try { return apiOk(await getStorageSummary(auth.context.db, auth.context.ownerId, folderId)); }
  catch (error) { return error instanceof FolderOperationError && error.code === "not_found"
    ? apiError(404, "not_found") : apiError(503, "unavailable"); }
}
