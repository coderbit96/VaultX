import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { listOwnerSessions } from "@/lib/auth/security-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  try {
    const { db, ownerId, token } = authorized.context;
    return apiOk({ sessions: await listOwnerSessions(db, ownerId, token) });
  } catch { return apiError(503, "unavailable"); }
}
