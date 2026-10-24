import { NextResponse } from "next/server";
import { getDatabase } from "@/lib/database";
import { createMongoAuthStore, isSameOriginMutation, logoutSession, sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) return apiError(403, "forbidden");

  const production = process.env.NODE_ENV === "production";
  const cookieName = sessionCookieName(production);
  const token = request.headers.get("cookie")
    ?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  try {
    await logoutSession(createMongoAuthStore(await getDatabase()), token);
    const response = NextResponse.json({ ok: true }, { headers: privateApiHeaders });
    response.cookies.set(cookieName, "", sessionCookieOptions(production, 0));
    return response;
  } catch {
    return apiError(503, "unavailable");
  }
}
