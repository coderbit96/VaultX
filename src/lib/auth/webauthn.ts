import { createHash, randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getModelCollections, deviceCredentialSchema, webauthnChallengeSchema } from "../database/models";
import { createMongoAuthStore, createOwnerSession, digestSessionToken, type LoginResult } from "./session-core";

export const CHALLENGE_MS = 5 * 60_000;
export async function reservePasskeyCeremony(db: Db, now = new Date()): Promise<boolean> {
  const window = Math.floor(now.getTime() / (15 * 60_000));
  const expiresAt = new Date((window + 1) * 15 * 60_000);
  try {
    const reserved = await db.collection<{ _id: string; count: number; expiresAt: Date }>("loginAttempts")
      .findOneAndUpdate({ _id: `passkey-ceremony:${window}`, count: { $lt: 30 } },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } }, { upsert: true, returnDocument: "after" });
    return reserved !== null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) return false;
    throw error;
  }
}
export function challengeCookieName(production: boolean): string {
  return production ? "__Host-vaultx_webauthn" : "vaultx_webauthn";
}
export function challengeCookieOptions(production: boolean, maxAgeSeconds: number) {
  return { httpOnly: true, secure: production, sameSite: "strict" as const, path: "/", maxAge: maxAgeSeconds };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function encode(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(Buffer.from(value, "base64url")); }

export function webauthnSite(request: Request): { origin: string; rpID: string } | null {
  const configured = process.env.WEBAUTHN_ORIGIN || (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
  try {
    const url = new URL(configured);
    if (url.origin !== configured || url.origin !== new URL(request.url).origin) return null;
    // localhost is a secure-context WebAuthn exception for explicit local testing.
    if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
    const rpID = process.env.WEBAUTHN_RP_ID || url.hostname;
    if (rpID !== url.hostname) return null;
    return { origin: url.origin, rpID };
  } catch { return null; }
}

async function saveChallenge(db: Db, kind: "register" | "authenticate", challenge: string,
  ownerId?: ObjectId, sessionToken?: string): Promise<string> {
  const browserToken = randomBytes(32).toString("base64url");
  await getModelCollections(db).webauthnChallenges.insertOne(webauthnChallengeSchema.parse({
    _id: new ObjectId(), kind, challenge, browserDigest: digest(browserToken), ownerId,
    sessionDigest: sessionToken ? digestSessionToken(sessionToken) : undefined,
    expiresAt: new Date(Date.now() + CHALLENGE_MS),
  }));
  return browserToken;
}

async function takeChallenge(db: Db, kind: "register" | "authenticate", browserToken: string | undefined,
  ownerId?: ObjectId, sessionToken?: string): Promise<string | null> {
  if (!browserToken || !/^[A-Za-z0-9_-]{43}$/.test(browserToken)) return null;
  const record = await getModelCollections(db).webauthnChallenges.findOneAndDelete({
    kind, browserDigest: digest(browserToken), expiresAt: { $gt: new Date() },
    ...(ownerId ? { ownerId } : {}), ...(sessionToken ? { sessionDigest: digestSessionToken(sessionToken) } : {}),
  });
  return record?.challenge ?? null;
}

export async function beginPasskeyRegistration(db: Db, ownerId: ObjectId, sessionToken: string, rpID: string) {
  const { deviceCredentials } = getModelCollections(db);
  const credentials = await deviceCredentials.find({ ownerId, rpId: rpID }).limit(20).toArray();
  if (credentials.length >= 10) return null;
  const options = await generateRegistrationOptions({ rpName: "VaultX", rpID, userName: "owner",
    userDisplayName: "owner", userID: new Uint8Array(ownerId.id),
    attestationType: "none", timeout: 60_000,
    excludeCredentials: credentials.map((item) => ({ id: item.credentialId, transports: item.transports })),
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" },
  });
  return { options, browserToken: await saveChallenge(db, "register", options.challenge, ownerId, sessionToken) };
}

export async function finishPasskeyRegistration(db: Db, ownerId: ObjectId, sessionToken: string, browserToken: string | undefined,
  site: { origin: string; rpID: string }, response: RegistrationResponseJSON): Promise<boolean> {
  const challenge = await takeChallenge(db, "register", browserToken, ownerId, sessionToken);
  if (!challenge) return false;
  try {
    const verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge,
      expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: true });
    if (!verified.verified || !verified.registrationInfo.userVerified) return false;
    const credential = verified.registrationInfo.credential;
    await getModelCollections(db).deviceCredentials.createIndex({ credentialId: 1 }, { unique: true, name: "credential_id_unique" });
    await getModelCollections(db).deviceCredentials.insertOne(deviceCredentialSchema.parse({
      _id: new ObjectId(), ownerId, credentialId: credential.id, publicKey: encode(credential.publicKey),
      signCount: credential.counter, rpId: site.rpID,
      transports: (response.response.transports ?? []).filter((item) => ["usb", "nfc", "ble", "internal", "hybrid"].includes(item)).slice(0, 5),
      createdAt: new Date(),
    }));
    return true;
  } catch { return false; }
}

export async function beginPasskeyAuthentication(db: Db, rpID: string) {
  const options = await generateAuthenticationOptions({ rpID, timeout: 60_000, userVerification: "required" });
  return { options, browserToken: await saveChallenge(db, "authenticate", options.challenge) };
}

export async function finishPasskeyAuthentication(db: Db, browserToken: string | undefined,
  site: { origin: string; rpID: string }, response: AuthenticationResponseJSON,
  previousSession?: string): Promise<LoginResult> {
  const challenge = await takeChallenge(db, "authenticate", browserToken);
  if (!challenge) return { kind: "invalid" };
  const { deviceCredentials, owners } = getModelCollections(db);
  const stored = await deviceCredentials.findOne({ credentialId: response.id, rpId: site.rpID });
  if (!stored) return { kind: "invalid" };
  try {
    const verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge,
      expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: true,
      credential: { id: stored.credentialId, publicKey: decode(stored.publicKey), counter: stored.signCount, transports: stored.transports },
    });
    if (!verified.verified || !verified.authenticationInfo.userVerified) return { kind: "invalid" };
    const owner = await owners.findOne({ _id: stored.ownerId, singletonKey: "vaultx-owner" });
    if (!owner) return { kind: "invalid" };
    const updated = await deviceCredentials.updateOne({ _id: stored._id, ownerId: owner._id, signCount: stored.signCount },
      { $set: { signCount: verified.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    if (updated.matchedCount !== 1) return { kind: "invalid" };
    return createOwnerSession(createMongoAuthStore(db), owner, previousSession);
  } catch { return { kind: "invalid" }; }
}
