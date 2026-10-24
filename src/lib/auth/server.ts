import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDatabase } from "@/lib/database";
import { authenticateSession, createMongoAuthStore, isDocumentOpening, lockSession, sessionCookieName } from "./session-core";
import { authOwnerClaimForSession, authRequestFromHeaders } from "./dual-session";

async function requestToken() {
  return (await cookies()).get(sessionCookieName(process.env.NODE_ENV === "production"))?.value;
}

export async function lockCurrentSession() {
  const token = await requestToken();
  if (token) await lockSession(createMongoAuthStore(await getDatabase()), token);
}

export async function currentOwnerId() {
  const token = await requestToken();
  if (!token) return null;
  const authOwnerId = await authOwnerClaimForSession(authRequestFromHeaders(await headers()), token);
  if (!authOwnerId) return null;
  const ownerId = await authenticateSession(createMongoAuthStore(await getDatabase()), token);
  return ownerId?.toHexString() === authOwnerId ? ownerId : null;
}

export async function requireOwner() {
  if (isDocumentOpening(await headers())) {
    await lockCurrentSession();
    redirect("/unlock");
  }
  const ownerId = await currentOwnerId();
  if (!ownerId) redirect("/unlock");
  return ownerId;
}
