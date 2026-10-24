import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { readJsonRequest, parseObjectId, objectIdText } from "@/lib/auth/request-validation";
import { reauthenticateOwner, revokeOwnedSession } from "@/lib/auth/security-settings";
import { digestSessionToken, sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";
import { getModelCollections } from "@/lib/database/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z.strictObject({ sessionId: objectIdText, loginPassword: z.string().min(1).max(1024) });

export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, input, 1_536);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId, token } = authorized.context;
    const verified = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (verified.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (verified.kind === "invalid") return apiError(401, "invalid_credentials");
    const sessionId = parseObjectId(parsed.data.sessionId)!;
    const target = await getModelCollections(db).sessions.findOne({ _id: sessionId, ownerId }, { projection: { tokenDigest: 1 } });
    if (!target) return apiError(404, "not_found");
    await revokeOwnedSession(db, ownerId, sessionId);
    const current = target.tokenDigest === digestSessionToken(token);
    const response = NextResponse.json({ ok: true, current }, { headers: privateApiHeaders });
    if (current) {
      const production = process.env.NODE_ENV === "production";
      response.cookies.set(sessionCookieName(production), "", sessionCookieOptions(production, 0));
    }
    return response;
  } catch { return apiError(503, "unavailable"); }
}
