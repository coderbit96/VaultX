import { NextRequest } from "next/server";
import { type Db, type ObjectId } from "mongodb";
import { getDatabase } from "@/lib/database";
import { authenticateSession, createMongoAuthStore, isSameOriginMutation, sessionCookieName } from "./session-core";
import { apiError } from "./api-policy";
import { authOwnerClaimForSession } from "./dual-session";

export type OwnerApiContext = { db: Db; ownerId: ObjectId; token: string };

export async function authorizeOwnerApi(
  request: NextRequest,
): Promise<{ ok: true; context: OwnerApiContext } | { ok: false; response: Response }> {
  const token = request.cookies.get(sessionCookieName(process.env.NODE_ENV === "production"))?.value;
  if (!token) return { ok: false, response: apiError(401, "unauthorized") };
  const authOwnerId = await authOwnerClaimForSession(request, token);
  if (!authOwnerId) return { ok: false, response: apiError(401, "unauthorized") };
  try {
    const db = await getDatabase();
    const ownerId = await authenticateSession(createMongoAuthStore(db), token);
    if (!ownerId || ownerId.toHexString() !== authOwnerId) {
      return { ok: false, response: apiError(401, "unauthorized") };
    }
    // Authentication precedes CSRF and all path/body validation, so anonymous
    // callers cannot use errors to probe private resource existence.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isSameOriginMutation(request)) {
      return { ok: false, response: apiError(403, "forbidden") };
    }
    return { ok: true, context: { db, ownerId, token } };
  } catch {
    return { ok: false, response: apiError(503, "unavailable") };
  }
}
