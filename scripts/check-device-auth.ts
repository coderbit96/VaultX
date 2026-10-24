import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { authenticateSession, createMongoAuthStore, loginWithPassword } from "../src/lib/auth/session-core";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";
import { changeOwnerLoginPassword } from "../src/lib/auth/security-settings";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { getModelCollections, ownerSchema } from "../src/lib/database/models";
import { disablePin, enrollPin, loginWithPin, PIN_LOCK_MS } from "../src/lib/auth/pin";
import { beginPasskeyAuthentication, beginPasskeyRegistration, finishPasskeyAuthentication, reservePasskeyCeremony, webauthnSite } from "../src/lib/auth/webauthn";

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  let temporary: Db | undefined;
  let stage = "connection";
  try {
    const configured = await getDatabase();
    temporary = configured.client.db(`vaultx_device_check_${randomBytes(8).toString("hex")}`);
    for (const name of ["owners", "sessions", "loginAttempts", "pinCredentials", "deviceCredentials", "webauthnChallenges"] as const) {
      await temporary.collection(name).createIndexes(modelIndexes[name]);
    }
    const db = temporary;
    const ownerId = new ObjectId();
    const password = randomBytes(24).toString("base64url");
    const replacement = randomBytes(24).toString("base64url");
    const pin = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
    await getModelCollections(db).owners.insertOne(ownerSchema.parse({
      _id: ownerId, singletonKey: "vaultx-owner", username: "owner",
      passwordHash: await argon2.hash(password, ownerHashOptions), initializedAt: new Date(),
      settings: { autoLockMinutes: 15, requireLockOnOpen: true },
    }));
    stage = "PIN device binding";
    const token = await enrollPin(db, ownerId, pin);
    if ((await loginWithPin(db, randomBytes(32).toString("base64url"), pin)).kind === "ok") throw new Error("Foreign device accepted");
    for (let i = 0; i < 5; i++) {
      if ((await loginWithPin(db, token, "999999" === pin ? "888888" : "999999")).kind !== "invalid") throw new Error("Wrong PIN accepted");
    }
    if ((await loginWithPin(db, token, pin)).kind !== "limited") throw new Error("PIN lockout failed");
    const digest = (await getModelCollections(db).pinCredentials.findOne({ ownerId }))!.deviceDigest;
    const afterLock = new Date(Date.now() + PIN_LOCK_MS + 1000);
    const resumed = await loginWithPin(db, token, pin, afterLock);
    if (resumed.kind !== "ok" || !await authenticateSession(createMongoAuthStore(db), resumed.token, afterLock)) throw new Error("PIN unlock after lockout failed");
    if (JSON.stringify(await getModelCollections(db).pinCredentials.findOne({ deviceDigest: digest })).includes(pin)) throw new Error("PIN persisted");
    const newPin = pin === "654321" ? "123456" : "654321";
    const newToken = await enrollPin(db, ownerId, newPin, new Date(), token);
    if (await getModelCollections(db).pinCredentials.countDocuments({ ownerId }) !== 1
      || (await loginWithPin(db, token, pin)).kind === "ok"
      || (await loginWithPin(db, newToken, newPin)).kind !== "ok") throw new Error("Atomic PIN reset failed");
    await disablePin(db, ownerId, newToken);
    if ((await loginWithPin(db, newToken, newPin)).kind === "ok") throw new Error("Disabled PIN accepted");

    stage = "WebAuthn challenge safety";
    const siteRequest = new Request("http://localhost:3000/api/auth/passkey/options");
    if (!webauthnSite(siteRequest) || webauthnSite(new Request("http://attacker.example/api/auth/passkey/options"))) throw new Error("Origin policy failed");
    const registeredSession = await loginWithPassword(createMongoAuthStore(db), password, undefined);
    if (registeredSession.kind !== "ok") throw new Error("Password baseline failed");
    const started = await beginPasskeyRegistration(db, ownerId, registeredSession.token, "localhost");
    if (!started || started.options.authenticatorSelection?.userVerification !== "required"
      || started.options.authenticatorSelection?.authenticatorAttachment !== "platform") throw new Error("Passkey registration options weakened");
    const authOptions = await beginPasskeyAuthentication(db, "localhost");
    if (authOptions.options.userVerification !== "required") throw new Error("Passkey authentication options weakened");
    const bucketTime = new Date();
    for (let i = 0; i < 30; i++) if (!await reservePasskeyCeremony(db, bucketTime)) throw new Error("Passkey rate bucket rejected early");
    if (await reservePasskeyCeremony(db, bucketTime)) throw new Error("Passkey rate bucket exceeded");
    const forged = { id: randomBytes(32).toString("base64url"), rawId: randomBytes(32).toString("base64url"),
      response: { authenticatorData: "fake", clientDataJSON: "fake", signature: "fake" },
      clientExtensionResults: {}, type: "public-key" as const };
    if ((await finishPasskeyAuthentication(db, authOptions.browserToken, { origin: "http://localhost:3000", rpID: "localhost" }, forged)).kind === "ok") throw new Error("Forged passkey accepted");
    if ((await finishPasskeyAuthentication(db, authOptions.browserToken, { origin: "http://localhost:3000", rpID: "localhost" }, forged)).kind === "ok") throw new Error("Replayed challenge accepted");

    stage = "password fallback and credential revocation";
    const owner = await getModelCollections(db).owners.findOne({ _id: ownerId });
    if (!owner || await changeOwnerLoginPassword(db, ownerId, owner.passwordHash, replacement) !== "changed") throw new Error("Password change failed");
    if ((await loginWithPassword(createMongoAuthStore(db), replacement, undefined)).kind !== "ok") throw new Error("Password fallback failed");
    if (await getModelCollections(db).pinCredentials.countDocuments({ ownerId }) !== 0
      || await getModelCollections(db).deviceCredentials.countDocuments({ ownerId }) !== 0) throw new Error("Device credentials survived password rotation");
    console.log("Disposable Atlas device security check passed: PIN binding, Argon2id storage, lockout, disable, WebAuthn challenge rejection, password fallback.");
  } catch {
    console.error(`Disposable device security check failed at ${stage}; the real owner was not changed.`);
    process.exitCode = 1;
  } finally {
    if (temporary) {
      try { await temporary.dropDatabase(); } catch { console.error("Temporary device-check database cleanup failed; inspect Atlas."); process.exitCode = 1; }
    }
    await closeDatabaseConnection().catch(() => undefined);
  }
}
void main();
