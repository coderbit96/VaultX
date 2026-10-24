import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { bulkDeletionInput, queueBulkFileDeletions } from "@/lib/deletions/bulk-file-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const input = await readJsonRequest(request, bulkDeletionInput, 512);
  if (!input.ok) return apiError(400, "invalid_request");
  const results = await queueBulkFileDeletions(auth.context.db, auth.context.ownerId, input.data.ids);
  return Response.json({ results }, { status: 202, headers: privateApiHeaders });
}
