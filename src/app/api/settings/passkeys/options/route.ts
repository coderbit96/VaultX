import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { reauthenticateOwner } from "@/lib/auth/security-settings";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { beginPasskeyRegistration, challengeCookieName, challengeCookieOptions, webauthnSite } from "@/lib/auth/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.strictObject({ loginPassword: z.string().min(1).max(1024) });

export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const site = webauthnSite(request);
  if (!site) return apiError(503, "unavailable");
  const parsed = await readJsonRequest(request, input, 1_536);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId, token } = authorized.context;
    const reauth = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (reauth.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (reauth.kind === "invalid") return apiError(401, "invalid_credentials");
    const started = await beginPasskeyRegistration(db, ownerId, token, site.rpID);
    if (!started) return apiError(409, "settings_conflict");
    const production = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ options: started.options }, { headers: privateApiHeaders });
    response.cookies.set(challengeCookieName(production), started.browserToken, challengeCookieOptions(production, 300));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
