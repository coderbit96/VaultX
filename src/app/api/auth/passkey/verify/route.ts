import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { getDatabase } from "@/lib/database";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { isSameOriginMutation, sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { challengeCookieName, challengeCookieOptions, finishPasskeyAuthentication, webauthnSite } from "@/lib/auth/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.strictObject({ credential: z.object({ id: z.string().min(16).max(2048) }).passthrough() });

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError(403, "forbidden");
  const site = webauthnSite(request);
  if (!site) return apiError(503, "unavailable");
  const parsed = await readJsonRequest(request, input, 16_384);
  if (!parsed.ok) return apiError(401, "invalid_credentials");
  try {
    const production = process.env.NODE_ENV === "production";
    const result = await finishPasskeyAuthentication(await getDatabase(),
      request.cookies.get(challengeCookieName(production))?.value, site,
      parsed.data.credential as unknown as AuthenticationResponseJSON,
      request.cookies.get(sessionCookieName(production))?.value);
    if (result.kind !== "ok") return apiError(401, "invalid_credentials");
    const response = NextResponse.json({ ok: true, vaultKeyRequired: true }, { headers: privateApiHeaders });
    response.cookies.set(sessionCookieName(production), result.token,
      sessionCookieOptions(production, Math.max(0, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000))));
    response.cookies.set(challengeCookieName(production), "", challengeCookieOptions(production, 0));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
