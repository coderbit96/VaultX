import "server-only";
import { getToken } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { authCookieName, authSecretIsReady } from "./authjs";
import { sessionCookieName } from "./session-core";
import { isBoundAuthToken } from "./auth-binding";

export async function authOwnerClaimForSession(request: NextRequest, mongoToken: string): Promise<string | null> {
  const production = process.env.NODE_ENV === "production";
  const secret = process.env.AUTH_SECRET;
  if (!authSecretIsReady() || !secret || !request.cookies.get(authCookieName(production))?.value ||
      request.cookies.get(sessionCookieName(production))?.value !== mongoToken) return null;
  try {
    const jwt = await getToken({ req: request, secret, cookieName: authCookieName(production), secureCookie: production });
    if (!jwt || typeof jwt.ownerId !== "string" || !/^[a-f0-9]{24}$/.test(jwt.ownerId)) return null;
    return isBoundAuthToken(jwt, mongoToken, jwt.ownerId) ? jwt.ownerId : null;
  } catch {
    return null;
  }
}

export function authRequestFromHeaders(headers: Headers): NextRequest {
  // getToken only needs request headers and cookies; no attacker-controlled URL is used.
  return new NextRequest("http://localhost/", { headers });
}
