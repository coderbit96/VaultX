import { NextResponse } from "next/server";
import { z } from "zod";
import { getDatabase } from "@/lib/database";
import { createMongoAuthStore, isSameOriginMutation, loginWithPassword, safeDeviceLabel, sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { authSecretIsReady, configuredOwnerEmail, matchesOwnerEmail } from "@/lib/auth/authjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginInput = z.strictObject({ email: z.email(), password: z.string().min(1).max(1024) });

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) {
    return apiError(403, "forbidden");
  }

  try {
    if (!configuredOwnerEmail() || !authSecretIsReady()) return apiError(503, "unavailable");
    const parsed = await readJsonRequest(request, loginInput, 2048);
    const production = process.env.NODE_ENV === "production";
    const cookieName = sessionCookieName(production);
    const previous = request.headers.get("cookie")
      ?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const result = await loginWithPassword(createMongoAuthStore(await getDatabase()), parsed.ok ? parsed.data.password : undefined,
      previous, new Date(), safeDeviceLabel(request.headers.get("user-agent")), parsed.ok && matchesOwnerEmail(parsed.data.email));
    if (result.kind === "limited") {
      return apiError(429, "rate_limited", { "Retry-After": "900" });
    }
    if (result.kind === "invalid") return apiError(401, "invalid_credentials");
    const response = NextResponse.json({ ok: true }, { headers: privateApiHeaders });
    response.cookies.set(cookieName, result.token, sessionCookieOptions(production, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000)));
    return response;
  } catch {
    return apiError(503, "unavailable");
  }
}
