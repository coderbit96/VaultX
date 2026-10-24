import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { challengeCookieName, challengeCookieOptions, finishPasskeyRegistration, webauthnSite } from "@/lib/auth/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.strictObject({ credential: z.object({ id: z.string().min(16).max(2048) }).passthrough() });

export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const site = webauthnSite(request);
  if (!site) return apiError(503, "unavailable");
  const parsed = await readJsonRequest(request, input, 24_576);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const production = process.env.NODE_ENV === "production";
    const { db, ownerId, token } = authorized.context;
    const done = await finishPasskeyRegistration(db, ownerId, token,
      request.cookies.get(challengeCookieName(production))?.value, site, parsed.data.credential as unknown as RegistrationResponseJSON);
    if (!done) return apiError(401, "invalid_credentials");
    const response = NextResponse.json({ ok: true }, { headers: privateApiHeaders });
    response.cookies.set(challengeCookieName(production), "", challengeCookieOptions(production, 0));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
