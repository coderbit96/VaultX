import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDatabase } from "@/lib/database";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { isSameOriginMutation, sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";
import { loginWithPin, pinCookieName } from "@/lib/auth/pin";
import { readJsonRequest } from "@/lib/auth/request-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.strictObject({ pin: z.string().regex(/^\d{6}$/) });

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError(403, "forbidden");
  const parsed = await readJsonRequest(request, input, 128);
  if (!parsed.ok) return apiError(401, "invalid_credentials");
  try {
    const production = process.env.NODE_ENV === "production";
    const result = await loginWithPin(await getDatabase(), request.cookies.get(pinCookieName(production))?.value,
      parsed.data.pin, new Date(), request.cookies.get(sessionCookieName(production))?.value);
    if (result.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "1800" });
    if (result.kind === "invalid") return apiError(401, "invalid_credentials");
    const response = NextResponse.json({ ok: true, vaultKeyRequired: true }, { headers: privateApiHeaders });
    response.cookies.set(sessionCookieName(production), result.token,
      sessionCookieOptions(production, Math.max(0, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000))));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
