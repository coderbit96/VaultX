import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadEnvConfig } from "@next/env";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { ownerSchema } from "../src/lib/database/models";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";
import { deriveVaultPasswordKey } from "../src/lib/crypto/argon2-browser";
import { createVaultKeys, unlockVaultWithRecovery } from "../src/lib/crypto/vault-keys";

const base = "http://localhost:3101";
const email = "synthetic-owner@example.test";

async function main() {
  loadEnvConfig(process.cwd(), false);
  const name = `vaultx_lock_check_${randomBytes(8).toString("hex")}`;
  let temporaryDatabase: Db | undefined;
  let server: ChildProcess | undefined;
  let stage = "database setup";
  try {
    const configured = await getDatabase();
    temporaryDatabase = configured.client.db(name);
    for (const collection of ["owners", "sessions", "loginAttempts"] as const) {
      await temporaryDatabase.collection(collection).createIndexes(modelIndexes[collection]);
    }
    const password = randomBytes(24).toString("base64url");
    const now = new Date();
    await temporaryDatabase.collection("owners").insertOne(ownerSchema.parse({
      _id: new ObjectId(), singletonKey: "vaultx-owner", username: "owner",
      passwordHash: await argon2.hash(password, ownerHashOptions), initializedAt: now,
      settings: { autoLockMinutes: 15, requireLockOnOpen: true },
    }));

    stage = "server startup";
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3101"], {
      cwd: process.cwd(), env: { ...process.env, MONGODB_DB_NAME: name, NODE_ENV: "production",
        AUTH_OWNER_EMAIL: email, AUTH_SECRET: randomBytes(32).toString("base64url"), NEXTAUTH_URL: base },
      windowsHide: true, stdio: "ignore",
    });
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (server.exitCode !== null) break;
      try { if ((await fetch(`${base}/unlock`)).ok) { ready = true; break; } } catch { /* Startup pending. */ }
      await delay(500);
    }
    if (!ready) throw new Error("Synthetic HTTP server unavailable");
    stage = "document security headers";
    const document = await fetch(`${base}/unlock`);
    const csp = document.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([A-Za-z0-9+/]{22}==)'/.exec(csp)?.[1];
    if (!nonce || !csp.includes("'strict-dynamic'") || !csp.includes("frame-ancestors 'none'")
      || csp.includes("'unsafe-eval'") || !document.headers.get("strict-transport-security")
      || document.headers.get("referrer-policy") !== "no-referrer"
      || !document.headers.get("cache-control")?.includes("no-store")) {
      throw new Error("Document security headers failed");
    }
    if (!(await document.text()).includes(`nonce="${nonce}"`)) throw new Error("Framework script nonce missing");

    const login = async (previousCookie?: string) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST", headers: { Origin: base, "Content-Type": "application/json", ...(previousCookie ? { Cookie: previousCookie } : {}) },
        body: JSON.stringify({ email, password }),
      });
      const mongoCookie = response.headers.getSetCookie().map((value) => value.split(";")[0])
        .find((value) => value.startsWith("__Host-vaultx_session="));
      if (response.status !== 200 || !mongoCookie) {
        stage = `synthetic login HTTP ${response.status}`;
        throw new Error("Synthetic HTTP login failed");
      }
      const mongoSetCookie = response.headers.getSetCookie().find((value) => value.startsWith("__Host-vaultx_session=")) ?? "";
      if (!/;\s*HttpOnly/i.test(mongoSetCookie) || !/;\s*Secure/i.test(mongoSetCookie) ||
          !/;\s*SameSite=Strict/i.test(mongoSetCookie) || !/;\s*Path=\//i.test(mongoSetCookie)) {
        throw new Error("MongoDB session cookie flags failed");
      }
      if ((await fetch(`${base}/api/settings`, { headers: { Cookie: mongoCookie } })).status !== 401) {
        throw new Error("Mongo session bypassed Auth.js gate");
      }
      const noCsrf = await fetch(`${base}/api/auth/callback/vaultx-session`, {
        method: "POST", redirect: "manual", headers: { Origin: base, Cookie: mongoCookie,
          "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email, callbackUrl: `${base}/vault`, json: "true" }),
      });
      if (noCsrf.headers.getSetCookie().some((value) => value.startsWith("__Host-vaultx_auth=") && !/Max-Age=0/i.test(value))) {
        throw new Error("Auth.js callback accepted a request without CSRF");
      }
      const csrfResponse = await fetch(`${base}/api/auth/csrf`, { headers: { Cookie: mongoCookie } });
      const csrf = (await csrfResponse.json()).csrfToken;
      const csrfCookies = csrfResponse.headers.getSetCookie().map((value) => value.split(";")[0]);
      if (csrfResponse.status !== 200 || !csrf || csrfCookies.length === 0) throw new Error("Auth.js CSRF setup failed");
      const bridge = await fetch(`${base}/api/auth/callback/vaultx-session`, {
        method: "POST", redirect: "manual",
        headers: { Origin: base, Cookie: [mongoCookie, ...csrfCookies].join("; "),
          "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrfToken: csrf, email, callbackUrl: `${base}/vault`, json: "true" }),
      });
      const authCookie = bridge.headers.getSetCookie().map((value) => value.split(";")[0])
        .find((value) => value.startsWith("__Host-vaultx_auth="));
      if (!bridge.ok || !authCookie) throw new Error("Auth.js session binding failed");
      const authSetCookie = bridge.headers.getSetCookie().find((value) => value.startsWith("__Host-vaultx_auth=")) ?? "";
      if (!/;\s*HttpOnly/i.test(authSetCookie) || !/;\s*Secure/i.test(authSetCookie) ||
          !/;\s*SameSite=Strict/i.test(authSetCookie) || !/;\s*Path=\//i.test(authSetCookie)) {
        throw new Error("Auth.js cookie flags failed");
      }
      return `${mongoCookie}; ${authCookie}`;
    };
    const media = async (cookie: string, expected: number) => {
      for (const path of ["access", "download"]) {
        const response = await fetch(`${base}/api/files/507f1f77bcf86cd799439011/${path}`, { headers: { Cookie: cookie } });
        if (response.status !== expected || !response.headers.get("cache-control")?.includes("no-store")) {
          throw new Error("Media status did not match lock state");
        }
      }
    };
    const expectError = async (response: Response, status: number, code: string) => {
      if (response.status !== status || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("Private API status or cache policy failed");
      const body = await response.json();
      if (body?.error?.code !== code || typeof body.error.message !== "string") throw new Error("Private API error envelope failed");
    };
    stage = "anonymous private prefixes";
    for (const path of [
      "/api/vault/summary", "/api/vault/keys", "/api/files", "/api/folders", "/api/uploads/init",
      "/api/deletions", "/api/settings", "/api/settings/sessions", "/api/files/not-an-id/access",
      "/api/files/507f1f77bcf86cd799439011", "/api/files/507f1f77bcf86cd799439011/access",
      "/api/files/507f1f77bcf86cd799439011/download", "/api/uploads/507f1f77bcf86cd799439011",
      "/api/uploads/507f1f77bcf86cd799439011/ciphertext", "/api/folders/507f1f77bcf86cd799439011",
    ]) {
      await expectError(await fetch(`${base}${path}`), 401, "unauthorized");
    }
    stage = "first login";
    const wrongEmail = await fetch(`${base}/api/auth/login`, { method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "different-owner@example.test", password }),
    });
    if (wrongEmail.status !== 401 || wrongEmail.headers.getSetCookie().some((value) => value.startsWith("__Host-vaultx_session="))) {
      throw new Error("A different configured email received a session");
    }
    await temporaryDatabase.collection("loginAttempts").deleteMany({});
    const first = await login();
    stage = "Auth.js owner session";
    const authSession = await fetch(`${base}/api/auth/session`, { headers: { Cookie: first } });
    const authSessionBody = await authSession.text();
    if (authSession.status !== 200 || !authSessionBody.includes('"name":"Owner"') ||
        authSessionBody.includes("sessionDigest") || !authSession.headers.get("cache-control")?.includes("no-store")) {
      throw new Error("Auth.js session was missing or exposed internal details");
    }
    stage = "active media";
    await media(first, 404);
    stage = "active API authorization";
    const settings = await fetch(`${base}/api/settings`, { headers: { Cookie: first } });
    if (settings.status !== 200 || (await settings.json()).settings?.autoLockMinutes !== 15) throw new Error("Owner settings read failed");
    stage = "vault key initial status";
    const beforeKeys = await fetch(`${base}/api/vault/keys`, { headers: { Cookie: first } });
    if (beforeKeys.status !== 200 || (await beforeKeys.json()).status !== "uninitialized") throw new Error("Vault key initial status failed");
    const syntheticOwner = await temporaryDatabase.collection("owners").findOne({ singletonKey: "vaultx-owner" });
    if (!syntheticOwner) throw new Error("Synthetic owner missing");
    const legacyFileId = new ObjectId();
    await temporaryDatabase.collection("files").insertOne({ _id: legacyFileId, ownerId: syntheticOwner._id, legacy: true });
    stage = "legacy key migration guard";
    const legacyStatus = await fetch(`${base}/api/vault/keys`, { headers: { Cookie: first } });
    if (legacyStatus.status !== 200 || (await legacyStatus.json()).status !== "migration_required") throw new Error("Legacy vault data was not blocked");
    await temporaryDatabase.collection("files").deleteOne({ _id: legacyFileId });
    stage = "synthetic vault key generation";
    const generated = await createVaultKeys(randomBytes(24).toString("base64url"), deriveVaultPasswordKey);
    try {
      stage = "vault key request validation";
      await expectError(await fetch(`${base}/api/vault/keys`, {
        method: "POST", headers: { Cookie: first, Origin: "https://attacker.example", "Content-Type": "application/json" },
        body: JSON.stringify(generated.envelope),
      }), 403, "forbidden");
      await expectError(await fetch(`${base}/api/vault/keys`, {
        method: "POST", headers: { Cookie: first, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ ...generated.envelope, rootKey: "forged" }),
      }), 400, "invalid_request");
      stage = "vault key save";
      const firstSave = await fetch(`${base}/api/vault/keys`, {
        method: "POST", headers: { Cookie: first, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(generated.envelope),
      });
      if (firstSave.status !== 200) throw new Error("Vault key save failed");
      stage = "vault key duplicate guard";
      await expectError(await fetch(`${base}/api/vault/keys`, {
        method: "POST", headers: { Cookie: first, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(generated.envelope),
      }), 409, "conflict");
      stage = "vault key read";
      const savedKeys = await fetch(`${base}/api/vault/keys`, { headers: { Cookie: first } });
      const savedBody = await savedKeys.json();
      if (savedKeys.status !== 200 || savedBody.status !== "ready" || JSON.stringify(savedBody).includes(generated.recoveryCode)) {
        throw new Error("Encrypted key envelope read failed");
      }
      stage = "synthetic vault recovery";
      const recovered = await unlockVaultWithRecovery(JSON.parse(JSON.stringify(savedBody.envelope)), generated.recoveryCode);
      if (!recovered.every((byte, index) => byte === generated.rootKey[index])) throw new Error("Cross-context recovery failed");
      recovered.fill(0);
      const storedKeys = await temporaryDatabase.collection("vaultKeys").findOne({});
      if (!storedKeys || JSON.stringify(storedKeys).includes(generated.recoveryCode)) throw new Error("Recovery material was stored");
    } finally { generated.rootKey.fill(0); }
    stage = "owner-scoped API requests";
    const forgedQuery = await fetch(`${base}/api/settings?ownerId=ffffffffffffffffffffffff&folderId=ffffffffffffffffffffffff&publicId=attacker`, { headers: { Cookie: first } });
    if (forgedQuery.status !== 200 || (await forgedQuery.json()).settings?.autoLockMinutes !== 15) throw new Error("Client identifiers influenced owner settings");
    stage = "invalid file identifier";
    await expectError(await fetch(`${base}/api/files/not-an-id/access`, { headers: { Cookie: first } }), 404, "not_found");
    for (const path of ["/api/vault/summary", "/api/files", "/api/folders", "/api/deletions"]) {
      stage = `owner-scoped API ${path}`;
      const response = await fetch(`${base}${path}`, { headers: { Cookie: first } });
      if (response.status !== 200 || !response.headers.get("cache-control")?.includes("no-store")) {
        throw new Error("Owner-scoped list unavailable");
      }
    }
    stage = "upload method policy";
    await expectError(await fetch(`${base}/api/uploads/init`, { headers: { Cookie: first } }), 405, "method_not_allowed");
    stage = "future API default deny";
    await expectError(await fetch(`${base}/api/settings/future`, { headers: { Cookie: first } }), 404, "not_found");
    stage = "file access method policy";
    await expectError(await fetch(`${base}/api/files/507f1f77bcf86cd799439011/access`, {
      method: "POST", headers: { Cookie: first, Origin: base },
    }), 405, "method_not_allowed");
    stage = "forged mutation fields";
    for (const field of ["ownerId", "folderId", "publicId"]) {
      await expectError(await fetch(`${base}/api/settings`, {
        method: "PATCH", headers: { Cookie: first, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ autoLockMinutes: 5, [field]: "attacker" }),
      }), 400, "invalid_request");
    }
    stage = "CSRF violations";
    await expectError(await fetch(`${base}/api/settings`, {
      method: "PATCH", headers: { Cookie: first, Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ autoLockMinutes: 5, loginPassword: password }),
    }), 403, "forbidden");
    await expectError(await fetch(`${base}/api/uploads/init`, {
      method: "POST", headers: { Cookie: first, Origin: "https://attacker.example" },
    }), 403, "forbidden");
    stage = "active client navigation";
    const clientHeaders = { "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", RSC: "1" };
    const active = await fetch(`${base}/vault?_rsc`, { headers: { Cookie: first, ...clientHeaders }, redirect: "manual" });
    if (active.status !== 200) stage = `active client navigation (${active.status}, ${active.headers.get("location")})`;
    if (active.status !== 200) throw new Error("Active client navigation denied");
    stage = "manual lock";
    const locked = await fetch(`${base}/api/auth/lock`, { method: "POST", headers: { Origin: base, Cookie: first } });
    if (locked.status !== 200) throw new Error("HTTP lock failed");
    stage = "locked media";
    await media(first, 401);
    const lockedAuthSession = await fetch(`${base}/api/auth/session`, { headers: { Cookie: first } });
    const lockedAuthBody = await lockedAuthSession.text();
    if (lockedAuthSession.status !== 200 || lockedAuthBody.includes('"name":"Owner"')) {
      throw new Error("Auth.js session survived lock");
    }
    await expectError(await fetch(`${base}/api/vault/keys`, { headers: { Cookie: first } }), 401, "unauthorized");
    const heartbeat = await fetch(`${base}/api/auth/verify`, { method: "POST", headers: { Origin: base, Cookie: first } });
    if (heartbeat.status !== 401) throw new Error("Locked session heartbeat was permitted");
    stage = "locked client navigation";
    const denied = await fetch(`${base}/vault?_rsc`, { headers: { Cookie: first, ...clientHeaders }, redirect: "manual" });
    if (denied.status === 200 && !(await denied.text()).includes("/unlock")) throw new Error("Locked page was accessible");

    stage = "second login";
    const second = await login(first);
    stage = "media after unlock";
    await media(second, 404);
    stage = "full reopening";
    const reopened = await fetch(`${base}/vault`, { headers: { Cookie: second }, redirect: "manual" });
    const reopenedBody = reopened.status === 200 ? await reopened.text() : "";
    const deniedDocument = (reopened.status === 307 &&
      new URL(reopened.headers.get("location") ?? "/", base).pathname === "/unlock") ||
      (reopened.status === 200 && reopenedBody.includes("/unlock") && !reopenedBody.includes("vault-shell"));
    if (!deniedDocument) {
      throw new Error("Full reopening did not require unlock");
    }
    stage = "media after reopening";
    await media(second, 401);

    stage = "third login";
    const third = await login(second);
    stage = "second-device revocation";
    const otherDevice = await login();
    const activeSessionsResponse = await fetch(`${base}/api/settings/sessions`, { headers: { Cookie: third } });
    if (activeSessionsResponse.status !== 200) throw new Error("Session listing failed");
    const activeSessions = (await activeSessionsResponse.json()).sessions as Array<{ id: string; current: boolean }>;
    const otherSessionId = activeSessions.find((entry) => !entry.current)?.id;
    if (!otherSessionId) throw new Error("Second device was absent from session listing");
    await expectError(await fetch(`${base}/api/settings/sessions/revoke`, {
      method: "POST", headers: { Origin: base, Cookie: third, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: otherSessionId, loginPassword: "synthetic-wrong-password" }),
    }), 401, "invalid_credentials");
    if ((await fetch(`${base}/api/settings`, { headers: { Cookie: otherDevice } })).status !== 200) throw new Error("Wrong reauthentication revoked a device");
    const revoked = await fetch(`${base}/api/settings/sessions/revoke`, {
      method: "POST", headers: { Origin: base, Cookie: third, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: otherSessionId, loginPassword: password }),
    });
    if (revoked.status !== 200) throw new Error("Second-device revocation failed");
    await expectError(await fetch(`${base}/api/settings`, { headers: { Cookie: otherDevice } }), 401, "unauthorized");
    stage = "timeout update";
    const setting = await fetch(`${base}/api/settings`, {
      method: "PATCH", headers: { Origin: base, Cookie: third, "Content-Type": "application/json" },
      body: JSON.stringify({ autoLockMinutes: 5, loginPassword: password }),
    });
    if (setting.status !== 200) throw new Error("Timeout setting failed");
    stage = "media after timeout update";
    await media(third, 401);
    stage = "timeout persistence";
    const saved = await temporaryDatabase.collection("owners").findOne({ singletonKey: "vaultx-owner" });
    if (saved?.settings?.autoLockMinutes !== 5) throw new Error("Timeout setting was not persisted");
    stage = "expired session";
    const fourth = await login(third);
    const token = fourth.split(";")[0].split("=")[1];
    const { digestSessionToken } = await import("../src/lib/auth/session-core");
    await temporaryDatabase.collection("sessions").updateOne({ tokenDigest: digestSessionToken(token) }, { $set: { idleExpiresAt: new Date(0) } });
    await expectError(await fetch(`${base}/api/settings`, { headers: { Cookie: fourth } }), 401, "unauthorized");
    await expectError(await fetch(`${base}/api/files/507f1f77bcf86cd799439011/download`, { headers: { Cookie: fourth } }), 401, "unauthorized");
    stage = "logout of both gates";
    await temporaryDatabase.collection("loginAttempts").deleteMany({});
    const fifth = await login();
    stage = "MongoDB logout";
    const mongoLogout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: fifth, Origin: base } });
    if (mongoLogout.status !== 200) throw new Error("MongoDB logout failed");
    await expectError(await fetch(`${base}/api/settings`, { headers: { Cookie: fifth } }), 401, "unauthorized");
    stage = "Auth.js signout CSRF";
    const signoutCsrfResponse = await fetch(`${base}/api/auth/csrf`, { headers: { Cookie: fifth } });
    const signoutCsrf = (await signoutCsrfResponse.json()).csrfToken;
    const signoutCsrfCookies = signoutCsrfResponse.headers.getSetCookie().map((value) => value.split(";")[0]);
    stage = "Auth.js signout";
    const authLogout = await fetch(`${base}/api/auth/signout`, { method: "POST", redirect: "manual",
      headers: { Cookie: [fifth, ...signoutCsrfCookies].join("; "), Origin: base,
        "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: signoutCsrf, callbackUrl: `${base}/unlock`, json: "true" }),
    });
    if (!authLogout.ok || !authLogout.headers.getSetCookie().some((value) => value.startsWith("__Host-vaultx_auth=") && /Max-Age=0/i.test(value))) {
      stage = `Auth.js signout HTTP ${authLogout.status}`;
      throw new Error("Auth.js logout did not clear its cookie");
    }
    stage = "login account-presence envelope";
    // Earlier synthetic sign-ins and reauthentication share the owner login
    // bucket. Reset only this disposable database to test the invalid path.
    await temporaryDatabase.collection("loginAttempts").deleteMany({});
    const guess = () => fetch(`${base}/api/auth/login`, { method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "wrong-synthetic-guess" }) });
    const present = await guess();
    if (present.status !== 401) throw new Error("Present-owner guess did not fail uniformly");
    const presentBody = await present.text();
    await temporaryDatabase.collection("owners").deleteOne({ singletonKey: "vaultx-owner" });
    const missing = await guess();
    if (missing.status !== 401 || await missing.text() !== presentBody) throw new Error("Login revealed owner presence");
    stage = "login guess rate limit";
    for (let attempt = 0; attempt < 6; attempt++) await expectError(await guess(), 401, "invalid_credentials");
    const limited = await guess();
    await expectError(limited, 429, "rate_limited");
    if (limited.headers.get("retry-after") !== "900") throw new Error("Login rate-limit retry hint missing");
    console.log("Synthetic HTTP owner authorization, anonymous assets, uniform login errors, rate limit, CSRF, forged IDs, lock, expiry, CSP, and no-store checks passed.");
  } catch {
    console.error(`Synthetic HTTP lock check failed at ${stage}. No real owner account was changed.`);
    process.exitCode = 1;
  } finally {
    server?.kill();
    if (temporaryDatabase) {
      try { await temporaryDatabase.dropDatabase(); } catch {
        console.error("Temporary lock-check database cleanup failed; inspect Atlas.");
        process.exitCode = 1;
      }
    }
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
