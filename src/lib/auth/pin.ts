import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { getModelCollections, pinCredentialSchema } from "../database/models";
import { ownerHashOptions } from "./owner-bootstrap";
import { createMongoAuthStore, createOwnerSession, type LoginResult } from "./session-core";

export const PIN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const PIN_LOCK_MS = 30 * 60 * 1000;
export const PIN_MAX_ATTEMPTS = 5;
export const pinPattern = /^\d{6}$/;

export function pinCookieName(production: boolean): string {
  return production ? "__Host-vaultx_pin_device" : "vaultx_pin_device";
}

export function pinCookieOptions(production: boolean, maxAgeSeconds: number) {
  return { httpOnly: true, secure: production, sameSite: "strict" as const, path: "/", maxAge: maxAgeSeconds };
}

export function deviceDigest(token: string): string | null {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

export async function enrollPin(db: Db, ownerId: ObjectId, pin: string, now = new Date(), priorToken?: string): Promise<string> {
  if (!pinPattern.test(pin)) throw new Error("Invalid PIN");
  const token = randomBytes(32).toString("base64url");
  const { pinCredentials } = getModelCollections(db);
  await pinCredentials.createIndex({ deviceDigest: 1 }, { unique: true, name: "pin_device_unique" });
  const verifier = await argon2.hash(`${pin}:${token}`, ownerHashOptions);
  const record = pinCredentialSchema.parse({
    _id: new ObjectId(), ownerId, deviceDigest: deviceDigest(token), verifier,
    failedAttempts: 0, createdAt: now, expiresAt: new Date(now.getTime() + PIN_LIFETIME_MS),
  });
  await db.client.withSession((session) => session.withTransaction(async () => {
    await pinCredentials.insertOne(record, { session });
    const oldDigest = priorToken && deviceDigest(priorToken);
    if (oldDigest) await pinCredentials.deleteOne({ ownerId, deviceDigest: oldDigest }, { session });
  }));
  return token;
}

export async function disablePin(db: Db, ownerId: ObjectId, token: string | undefined): Promise<void> {
  const digest = token && deviceDigest(token);
  if (digest) await getModelCollections(db).pinCredentials.deleteOne({ ownerId, deviceDigest: digest });
}

export async function loginWithPin(db: Db, token: string | undefined, pin: unknown, now = new Date(), previousSession?: string): Promise<LoginResult> {
  const digest = token && deviceDigest(token);
  if (!digest || typeof pin !== "string" || !pinPattern.test(pin)) return { kind: "invalid" };
  const { pinCredentials, owners } = getModelCollections(db);
  await pinCredentials.updateOne({ deviceDigest: digest, lockedUntil: { $lte: now } },
    { $set: { failedAttempts: 0 }, $unset: { lockedUntil: "" } });
  // Reserve an attempt before verification; concurrent callers cannot exceed five.
  const credential = await pinCredentials.findOneAndUpdate({ deviceDigest: digest, expiresAt: { $gt: now },
    failedAttempts: { $lt: PIN_MAX_ATTEMPTS }, lockedUntil: { $exists: false } },
  { $inc: { failedAttempts: 1 } }, { returnDocument: "after" });
  if (!credential) return { kind: "limited" };
  const valid = await argon2.verify(credential.verifier, `${pin}:${token}`);
  if (!valid) {
    if (credential.failedAttempts >= PIN_MAX_ATTEMPTS) await pinCredentials.updateOne(
      { _id: credential._id, ownerId: credential.ownerId, failedAttempts: { $gte: PIN_MAX_ATTEMPTS } },
      { $set: { lockedUntil: new Date(now.getTime() + PIN_LOCK_MS) } });
    return { kind: "invalid" };
  }
  const owner = await owners.findOne({ _id: credential.ownerId, singletonKey: "vaultx-owner" });
  if (!owner) return { kind: "invalid" };
  const result = await pinCredentials.updateOne({ _id: credential._id, ownerId: owner._id, verifier: credential.verifier,
    expiresAt: { $gt: now }, lockedUntil: { $exists: false } },
  { $set: { failedAttempts: 0, lastUsedAt: now } });
  if (result.matchedCount !== 1) return { kind: "limited" };
  return createOwnerSession(createMongoAuthStore(db), owner, previousSession, now);
}
