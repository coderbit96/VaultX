import { NextResponse, type NextRequest } from "next/server";
import { getDatabase } from "@/lib/database";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { isSameOriginMutation } from "@/lib/auth/session-core";
import { beginPasskeyAuthentication, challengeCookieName, challengeCookieOptions, reservePasskeyCeremony, webauthnSite } from "@/lib/auth/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError(403, "forbidden");
  const site = webauthnSite(request);
  if (!site) return apiError(503, "unavailable");
  try {
    const db = await getDatabase();
    if (!await reservePasskeyCeremony(db)) return apiError(429, "rate_limited", { "Retry-After": "900" });
    const started = await beginPasskeyAuthentication(db, site.rpID);
    const production = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ options: started.options }, { headers: privateApiHeaders });
    response.cookies.set(challengeCookieName(production), started.browserToken, challengeCookieOptions(production, 300));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
