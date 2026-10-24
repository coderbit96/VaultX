import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { getModelCollections, sessionSchema, type Owner, type Session } from "../database/models";
import { ownerHashOptions } from "./owner-bootstrap";

export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_ATTEMPTS_PER_WINDOW = 8;

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const loginPasswordSchema = z.string().min(1).max(1024);
let dummyHash: Promise<string> | undefined;

export function digestSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeDeviceLabel(userAgent: string | null): NonNullable<Session["deviceLabel"]> {
  const agent = (userAgent ?? "").slice(0, 512);
  if (/Edg\//i.test(agent) && /Windows/i.test(agent)) return "Edge on Windows";
  if (/Android/i.test(agent) && /(?:Chrome|CriOS)\//i.test(agent)) return "Chrome on Android";
  if (/(?:iPhone|iPad)/i.test(agent) && /(?:Safari|CriOS|FxiOS)/i.test(agent)) return "Browser on iPhone or iPad";
  if (/Windows/i.test(agent) && /Chrome\//i.test(agent)) return "Chrome on Windows";
  if (/Macintosh/i.test(agent) && /Safari\//i.test(agent) && !/Chrome\//i.test(agent)) return "Safari on Mac";
  if (/Chrome\//i.test(agent)) return "Chrome on desktop";
  if (/Firefox\//i.test(agent)) return "Firefox";
  return "Other browser";
}

export function sessionCookieName(production: boolean): string {
  return production ? "__Host-vaultx_session" : "vaultx_session";
}

export function sessionCookieOptions(production: boolean, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: "strict" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin")) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function idleExpiry(now: Date, minutes: number, absolute: Date): Date {
  return new Date(Math.min(now.getTime() + minutes * 60_000, absolute.getTime()));
}

export type LoginResult =
  | { kind: "ok"; token: string; expiresAt: Date }
  | { kind: "invalid" }
  | { kind: "limited" };

export interface AuthStore {
  reserveLoginAttempt(now: Date): Promise<boolean>;
  findOwner(): Promise<Owner | null>;
  insertSession(session: Session): Promise<void>;
  revokeToken(tokenDigest: string): Promise<void>;
  lockToken(tokenDigest: string, now: Date): Promise<void>;
  touchSession(tokenDigest: string, ownerId: ObjectId, now: Date, idleExpiresAt: Date, idleCutoff: Date): Promise<Session | null>;
}

export function createMongoAuthStore(db: Db): AuthStore {
  const { owners, sessions } = getModelCollections(db);
  const attempts = db.collection<{ _id: string; count: number; expiresAt: Date }>("loginAttempts");
  return {
    async reserveLoginAttempt(now) {
      const window = Math.floor(now.getTime() / LOGIN_WINDOW_MS);
      const expiresAt = new Date((window + 1) * LOGIN_WINDOW_MS);
      try {
        const result = await attempts.findOneAndUpdate(
          { _id: `owner-login:${window}`, count: { $lt: LOGIN_ATTEMPTS_PER_WINDOW } },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
          { upsert: true, returnDocument: "after" },
        );
        return result !== null;
      } catch (error) {
        // A concurrent upsert or a full bucket conflicts with the unique _id.
        if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) return false;
        throw error;
      }
    },
    findOwner() {
      return owners.findOne({ singletonKey: "vaultx-owner" });
    },
    async insertSession(session) {
      await sessions.insertOne(session);
    },
    async revokeToken(tokenDigest) {
      await sessions.deleteOne({ tokenDigest });
    },
    async lockToken(tokenDigest, now) {
      await sessions.updateOne({ tokenDigest, lockedAt: { $exists: false } }, { $set: { lockedAt: now } });
    },
    touchSession(tokenDigest, ownerId, now, idleExpiresAt, idleCutoff) {
      return sessions.findOneAndUpdate(
        { tokenDigest, ownerId, expiresAt: { $gt: now }, idleExpiresAt: { $gt: now },
          lastSeenAt: { $gt: idleCutoff }, lockedAt: { $exists: false }, revokedAt: { $exists: false } },
        [{ $set: { lastSeenAt: now, idleExpiresAt: { $min: [idleExpiresAt, "$expiresAt"] } } }],
        { returnDocument: "after" },
      );
    },
  };
}

export async function loginWithPassword(
  store: AuthStore,
  password: unknown,
  previousToken: string | undefined,
  now = new Date(),
  deviceLabel: Session["deviceLabel"] = "Other browser",
  identityAllowed = true,
): Promise<LoginResult> {
  if (!(await store.reserveLoginAttempt(now))) return { kind: "limited" };
  const supplied = loginPasswordSchema.safeParse(password);
  const owner = await store.findOwner();
  if (!owner) dummyHash ??= argon2.hash("synthetic-missing-owner-verifier", ownerHashOptions);
  const verifier = owner?.passwordHash ?? await dummyHash!;
  const valid = await argon2.verify(verifier, supplied.success ? supplied.data : "invalid-input");
  if (!supplied.success || !owner || !valid || !identityAllowed) return { kind: "invalid" };

  return createOwnerSession(store, owner, previousToken, now, deviceLabel);
}

export async function createOwnerSession(
  store: AuthStore, owner: Owner, previousToken: string | undefined, now = new Date(),
  deviceLabel: Session["deviceLabel"] = "Other browser",
): Promise<LoginResult> {
  if (previousToken && tokenSchema.safeParse(previousToken).success) {
    await store.revokeToken(digestSessionToken(previousToken));
  }

  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await store.insertSession(sessionSchema.parse({
    _id: new ObjectId(), ownerId: owner._id, tokenDigest: digestSessionToken(token),
    createdAt: now, lastSeenAt: now,
    deviceLabel,
    idleExpiresAt: idleExpiry(now, owner.settings.autoLockMinutes, expiresAt), expiresAt,
  }));
  return { kind: "ok", token, expiresAt };
}

export async function authenticateSession(store: AuthStore, token: string | undefined, now = new Date()): Promise<ObjectId | null> {
  if (!tokenSchema.safeParse(token).success) return null;
  const owner = await store.findOwner();
  if (!owner) return null;
  const digest = digestSessionToken(token as string);
  const idleDuration = owner.settings.autoLockMinutes * 60_000;
  const session = await store.touchSession(digest, owner._id, now, new Date(now.getTime() + idleDuration), new Date(now.getTime() - idleDuration));
  if (!session || session.expiresAt <= now || session.idleExpiresAt <= now) return null;
  // The write must never extend the idle timeout beyond the absolute limit.
  if (session.idleExpiresAt > session.expiresAt) {
    await store.revokeToken(digest);
    return null;
  }
  return owner._id;
}

export async function lockSession(store: AuthStore, token: string | undefined, now = new Date()): Promise<void> {
  if (tokenSchema.safeParse(token).success) await store.lockToken(digestSessionToken(token as string), now);
}

export function isDocumentOpening(headers: Headers): boolean {
  // Browser fetches used by client navigation have an empty destination.
  // Document requests, including refreshes, must go through the password screen.
  // Missing fetch metadata fails closed.
  return headers.get("sec-fetch-dest") !== "empty";
}

export async function logoutSession(store: AuthStore, token: string | undefined): Promise<void> {
  if (tokenSchema.safeParse(token).success) await store.revokeToken(digestSessionToken(token as string));
}
