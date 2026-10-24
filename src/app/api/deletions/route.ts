import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { getModelCollections } from "@/lib/database/models";
import { publicDeletionStatus } from "@/lib/deletions/file-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  if ([...request.nextUrl.searchParams.keys()].length) return apiError(400, "invalid_request");
  try {
    const jobs = await getModelCollections(auth.context.db).deletionJobs.find({ ownerId: auth.context.ownerId })
      .sort({ createdAt: -1, _id: -1 }).limit(101).toArray();
    return apiOk({ deletions: jobs.slice(0, 100).map(publicDeletionStatus), more: jobs.length > 100 });
  } catch { return apiError(503, "unavailable"); }
}
