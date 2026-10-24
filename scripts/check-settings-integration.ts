import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { authenticateSession, createMongoAuthStore, loginWithPassword } from "../src/lib/auth/session-core";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";
import { changeOwnerLoginPassword, listOwnerSessions, reauthenticateOwner, revokeOwnedSession, saveRotatedVaultEnvelope } from "../src/lib/auth/security-settings";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { ownerSchema, vaultKeyRecordSchema } from "../src/lib/database/models";
import { createVaultKeys, rotateVaultPassphrase, unlockVaultWithPassphrase, unlockVaultWithRecovery } from "../src/lib/crypto/vault-keys";
import { deriveVaultPasswordKey } from "../src/lib/crypto/argon2-browser";

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const name = `vaultx_settings_check_${randomBytes(8).toString("hex")}`;
  let temporary: Db | undefined;
  let stage = "connection";
  try {
    const configured = await getDatabase();
    temporary = configured.client.db(name);
    for (const collection of ["owners", "sessions", "loginAttempts", "vaultKeys"] as const) {
      await temporary.collection(collection).createIndexes(modelIndexes[collection]);
    }
    stage = "synthetic owner";
    const db = temporary;
    const ownerId = new ObjectId();
    const originalLogin = randomBytes(24).toString("base64url");
    const replacementLogin = randomBytes(24).toString("base64url");
    const originalVault = randomBytes(24).toString("base64url");
    const replacementVault = randomBytes(24).toString("base64url");
    const owner = ownerSchema.parse({
      _id: ownerId, singletonKey: "vaultx-owner", username: "owner",
      passwordHash: await argon2.hash(originalLogin, ownerHashOptions), initializedAt: new Date(),
      settings: { autoLockMinutes: 15, requireLockOnOpen: true },
    });
    await db.collection("owners").insertOne(owner);
    const auth = createMongoAuthStore(db);
    stage = "two device login";
    const first = await loginWithPassword(auth, originalLogin, undefined, new Date(), "Chrome on Windows");
    const second = await loginWithPassword(auth, originalLogin, undefined, new Date(), "Browser on iPhone or iPad");
    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("Synthetic device login failed");
    stage = "device listing and revocation";
    const listed = await listOwnerSessions(db, ownerId, first.token);
    if (listed.length !== 2 || listed.filter((entry) => entry.current).length !== 1
      || listed.some((entry) => "tokenDigest" in entry)) throw new Error("Safe device listing failed");
    const wrong = await reauthenticateOwner(db, ownerId, "synthetic-wrong-password");
    if (wrong.kind !== "invalid") throw new Error("Wrong reauthentication succeeded");
    if (!await revokeOwnedSession(db, ownerId, new ObjectId(listed.find((entry) => !entry.current)!.id))) throw new Error("Session revoke failed");
    if (await authenticateSession(auth, second.token)) throw new Error("Revoked device retained access");
    if (!await authenticateSession(auth, first.token)) throw new Error("Current device lost access");

    stage = "vault key generation";
    const generated = await createVaultKeys(originalVault, deriveVaultPasswordKey);
    try {
      await db.collection("vaultKeys").insertOne(vaultKeyRecordSchema.parse({
        ...generated.envelope, _id: new ObjectId(), ownerId, createdAt: new Date(), recoveryConfirmedAt: new Date(),
      }));
      stage = "vault key rotation";
      const rotated = await rotateVaultPassphrase(generated.envelope, originalVault, replacementVault, deriveVaultPasswordKey);
      if (await saveRotatedVaultEnvelope(db, ownerId, 1, rotated) !== "changed") throw new Error("Vault rewrap failed");
      if (await saveRotatedVaultEnvelope(db, ownerId, 1, rotated) !== "conflict") throw new Error("Stale envelope was accepted");
      if (await authenticateSession(auth, first.token)) throw new Error("Vault rotation retained an old session");
      const stored = await db.collection("vaultKeys").findOne({ ownerId });
      if (!stored || JSON.stringify(stored).includes(generated.recoveryCode)) throw new Error("Recovery secret stored");
      stage = "vault key recovery";
      const storedEnvelope = { version: stored.version, vaultId: stored.vaultId, revision: stored.revision,
        password: stored.password, recovery: stored.recovery };
      const recovered = await unlockVaultWithRecovery(storedEnvelope, generated.recoveryCode);
      const newUnlock = await unlockVaultWithPassphrase(storedEnvelope, replacementVault, deriveVaultPasswordKey);
      if (!recovered.every((byte, index) => byte === generated.rootKey[index])
        || !newUnlock.every((byte, index) => byte === generated.rootKey[index])) throw new Error("Rewrapped key changed");
      recovered.fill(0); newUnlock.fill(0);
    } finally { generated.rootKey.fill(0); }

    stage = "login password change";
    const third = await loginWithPassword(auth, originalLogin, undefined);
    if (third.kind !== "ok") throw new Error("Third synthetic login failed");
    const reauth = await reauthenticateOwner(db, ownerId, originalLogin);
    if (reauth.kind !== "ok") throw new Error("Reauthentication failed");
    if (await changeOwnerLoginPassword(db, ownerId, reauth.owner.passwordHash, replacementLogin) !== "changed") throw new Error("Login password change failed");
    if (await authenticateSession(auth, third.token)) throw new Error("Password change retained an old session");
    if ((await loginWithPassword(auth, originalLogin, undefined)).kind !== "invalid") throw new Error("Old password still signs in");
    stage = "new password on another device";
    const fourth = await loginWithPassword(auth, replacementLogin, undefined);
    if (fourth.kind !== "ok" || !await authenticateSession(auth, fourth.token)) throw new Error("New password failed on another device");
    console.log("Synthetic Atlas settings check passed: two devices, revocation, vault rewrap/recovery, password change, stale-session denial.");
  } catch {
    console.error(`Synthetic settings integration check failed at ${stage}. No real owner account was changed.`);
    process.exitCode = 1;
  } finally {
    if (temporary) {
      try { await temporary.dropDatabase(); }
      catch { console.error("Temporary settings-check database cleanup failed; inspect Atlas."); process.exitCode = 1; }
    }
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
