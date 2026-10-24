import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { changeOwnerLoginPassword, reauthenticateOwner } from "@/lib/auth/security-settings";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z.strictObject({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(16).max(1024) });

export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, input, 2_560);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId } = authorized.context;
    const verified = await reauthenticateOwner(db, ownerId, parsed.data.currentPassword);
    if (verified.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (verified.kind === "invalid") return apiError(401, "invalid_credentials");
    const result = await changeOwnerLoginPassword(db, ownerId, verified.owner.passwordHash, parsed.data.newPassword);
    if (result === "weak") return apiError(400, "weak_password");
    if (result === "conflict") return apiError(409, "settings_conflict");
    const production = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ ok: true, reunlock: true }, { headers: privateApiHeaders });
    response.cookies.set(sessionCookieName(production), "", sessionCookieOptions(production, 0));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
