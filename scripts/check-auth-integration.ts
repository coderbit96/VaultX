import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { createMongoAuthStore, authenticateSession, digestSessionToken, loginWithPassword, lockSession, logoutSession } from "../src/lib/auth/session-core";
import { privateAssetStatus } from "../src/lib/auth/private-asset";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { ownerSchema } from "../src/lib/database/models";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const name = `vaultx_auth_check_${randomBytes(8).toString("hex")}`;
  let temporaryDatabase: Db | undefined;
  try {
    const configured = await getDatabase();
    temporaryDatabase = configured.client.db(name);
    for (const collection of ["owners", "sessions", "loginAttempts"] as const) {
      await temporaryDatabase.collection(collection).createIndexes(modelIndexes[collection]);
    }
    const password = randomBytes(24).toString("base64url");
    const now = new Date();
    const owner = ownerSchema.parse({
      _id: new ObjectId(), singletonKey: "vaultx-owner", username: "owner",
      passwordHash: await argon2.hash(password, ownerHashOptions), initializedAt: now,
      settings: { autoLockMinutes: 15, requireLockOnOpen: true },
    });
    await temporaryDatabase.collection("owners").insertOne(owner);
    const store = createMongoAuthStore(temporaryDatabase);
    const wrong = await loginWithPassword(store, "synthetic-wrong-password", undefined, now);
    if (wrong.kind !== "invalid") throw new Error("Wrong password was accepted");
    const first = await loginWithPassword(store, password, undefined, now);
    if (first.kind !== "ok") throw new Error("Synthetic login failed");
    if (!(await authenticateSession(store, first.token, now))?.equals(owner._id)) throw new Error("Session authorization failed");
    const stored = await temporaryDatabase.collection("sessions").findOne({ tokenDigest: digestSessionToken(first.token) });
    if (!stored || "token" in stored || JSON.stringify(stored).includes(first.token)) throw new Error("Raw token persisted");
    await lockSession(store, first.token, now);
    if (await authenticateSession(store, first.token, now)) throw new Error("Lock did not deny session");
    if (await privateAssetStatus(store, first.token) !== 401) throw new Error("Locked media access was permitted");
    const second = await loginWithPassword(store, password, first.token, now);
    if (second.kind !== "ok" || await authenticateSession(store, first.token, now)) throw new Error("Session rotation failed");
    await temporaryDatabase.collection("sessions").updateOne(
      { tokenDigest: digestSessionToken(second.token) }, { $set: { idleExpiresAt: new Date(now.getTime() - 1) } },
    );
    if (await authenticateSession(store, second.token, now)) throw new Error("Idle expiry failed");
    await logoutSession(store, second.token);
    if (await authenticateSession(store, second.token, now)) throw new Error("Logout revocation failed");
    const count = await temporaryDatabase.collection("sessions").countDocuments({});
    if (count !== 0) throw new Error("Session cleanup failed");
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await loginWithPassword(store, "synthetic-wrong-password", undefined, now);
      if (result.kind !== "invalid") throw new Error("Unexpected rate counter result");
    }
    if ((await loginWithPassword(store, password, undefined, now)).kind !== "limited") throw new Error("Rate limit failed");
    console.log("Synthetic Atlas login, lock, media denial, token storage, expiry, rate limit, rotation, and logout checks passed.");
  } catch {
    console.error("Synthetic auth integration check failed. No real owner account was changed.");
    process.exitCode = 1;
  } finally {
    if (temporaryDatabase) {
      try {
        await temporaryDatabase.dropDatabase();
      } catch {
        console.error("Temporary auth-check database cleanup failed; inspect Atlas.");
        process.exitCode = 1;
      }
    }
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
