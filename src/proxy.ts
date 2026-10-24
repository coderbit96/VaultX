import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, isEnabledPrivateApiMethod, isEnabledPrivateApiPath, privateApiHeaders } from "@/lib/auth/api-policy";
import { documentContentSecurityPolicy } from "@/lib/auth/security-headers";

export async function proxy(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith("/api/")) {
    const nonce = randomBytes(16).toString("base64");
    const policy = documentContentSecurityPolicy(nonce, process.env.NODE_ENV !== "production");
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("Content-Security-Policy", policy);
    requestHeaders.set("x-nonce", nonce);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", policy);
    return response;
  }
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  if (!isEnabledPrivateApiPath(request.nextUrl.pathname)) return apiError(404, "not_found");
  if (!isEnabledPrivateApiMethod(request.nextUrl.pathname, request.method)) return apiError(405, "method_not_allowed");
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(privateApiHeaders)) response.headers.set(key, value);
  return response;
}

export const config = {
  matcher: [
    "/", "/unlock", "/install", "/design-system", "/vault/:path*",
    "/api/vault/:path*", "/api/files/:path*", "/api/folders/:path*", "/api/albums/:path*",
    "/api/uploads/:path*", "/api/deletions/:path*", "/api/settings/:path*",
  ],
};
