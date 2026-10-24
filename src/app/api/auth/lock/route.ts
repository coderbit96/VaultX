import type { NextRequest } from "next/server";
import { getDatabase } from "@/lib/database";
import { createMongoAuthStore, isSameOriginMutation, lockSession, sessionCookieName } from "@/lib/auth/session-core";
import { apiError, apiOk } from "@/lib/auth/api-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError(403, "forbidden");
  try {
    const token = request.cookies.get(sessionCookieName(process.env.NODE_ENV === "production"))?.value;
    if (token) await lockSession(createMongoAuthStore(await getDatabase()), token);
    return apiOk({ ok: true });
  } catch {
    return apiError(503, "unavailable");
  }
}
