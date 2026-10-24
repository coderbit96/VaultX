import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadEnvConfig } from "@next/env";
import argon2 from "argon2";
import { ObjectId, type Db } from "mongodb";
import { chromium, type Browser } from "playwright-core";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { getModelCollections, ownerSchema } from "../src/lib/database/models";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";

const origin = "http://localhost:3160";
const syntheticOwnerEmail = "synthetic-owner@vaultx.invalid";

async function main() {
  loadEnvConfig(process.cwd(), false);
  let temporary: Db | undefined;
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let stage = "database setup";
  let detail = "";
  try {
    const configured = await getDatabase();
    temporary = configured.client.db(`vaultx_passkey_check_${randomBytes(8).toString("hex")}`);
    for (const name of ["owners", "sessions", "loginAttempts", "deviceCredentials", "webauthnChallenges"] as const) {
      await temporary.collection(name).createIndexes(modelIndexes[name]);
    }
    const password = randomBytes(24).toString("base64url");
    await getModelCollections(temporary).owners.insertOne(ownerSchema.parse({
      _id: new ObjectId(), singletonKey: "vaultx-owner", username: "owner",
      passwordHash: await argon2.hash(password, ownerHashOptions), initializedAt: new Date(),
      settings: { autoLockMinutes: 15, requireLockOnOpen: true },
    }));
    stage = "isolated server startup";
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3160"], {
      cwd: process.cwd(), windowsHide: true, stdio: "ignore",
      env: { ...process.env, NODE_ENV: "production", MONGODB_DB_NAME: temporary.databaseName,
        AUTH_OWNER_EMAIL: syntheticOwnerEmail, AUTH_SECRET: randomBytes(48).toString("base64url"), NEXTAUTH_URL: origin,
        WEBAUTHN_ORIGIN: origin, WEBAUTHN_RP_ID: "localhost" },
    });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (server.exitCode !== null) break;
      try { if ((await fetch(`${origin}/unlock`)).ok) { ready = true; break; } } catch { /* starting */ }
      await delay(200);
    }
    if (!ready) throw new Error("Server did not start");
    stage = "virtual authenticator";
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.goto(`${origin}/unlock`);
    stage = "password login";
    await page.getByLabel("Owner email").fill(syntheticOwnerEmail);
    await page.locator("#owner-password").fill(password);
    await page.getByRole("button", { name: "Unlock VaultX" }).click();
    await page.waitForURL(`${origin}/vault`, { timeout: 15000 });
    await page.locator('nav[aria-label="Desktop navigation"] a[href="/vault/settings"]').click();
    await page.waitForURL(`${origin}/vault/settings`, { timeout: 15000 });
    stage = "passkey registration";
    await page.locator("#device-login-password").fill(password);
    await page.getByRole("button", { name: "Add platform passkey" }).click();
    await page.getByText("Passkey added.", { exact: false }).waitFor({ timeout: 15000 });
    if (await getModelCollections(temporary).deviceCredentials.countDocuments({}) !== 1) throw new Error("Passkey was not persisted");
    stage = "passkey sign-in";
    await page.getByRole("button", { name: "Lock vault now" }).click();
    await page.waitForURL(`${origin}/unlock`, { timeout: 15000 });
    await page.getByLabel("Owner email").fill(syntheticOwnerEmail);
    stage = "passkey user-verification rejection";
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await page.getByRole("alert").waitFor({ timeout: 15000 });
    if (new URL(page.url()).pathname !== "/unlock") throw new Error("Passkey without user verification signed in");
    if (await page.evaluate(async () => (await fetch("/api/auth/verify", { method: "POST", cache: "no-store" })).status) !== 401) {
      throw new Error("Passkey without user verification created a session");
    }
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
    await page.reload();
    await page.getByLabel("Owner email").fill(syntheticOwnerEmail);
    stage = "passkey sign-in";
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await delay(2000);
    detail = (await page.getByRole("alert").textContent().catch(() => null)) ?? "";
    await page.waitForURL(`${origin}/vault/settings`, { timeout: 15000 });
    const status = await page.locator("#keys-heading").textContent();
    if (!status?.includes("Vault encryption keys")) throw new Error("Vault key step was skipped");
    stage = "PIN enrollment and sign-in";
    const pin = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
    await page.locator("#device-login-password").fill(password);
    await page.locator("#device-pin").fill(pin);
    await page.getByRole("button", { name: "Enable PIN" }).click();
    await page.getByText("PIN saved for this browser profile.", { exact: false }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Lock vault now" }).click();
    await page.waitForURL(`${origin}/unlock`, { timeout: 15000 });
    await page.getByLabel("Owner email").fill(syntheticOwnerEmail);
    await page.locator("#device-signin-pin").fill(pin);
    await page.getByRole("button", { name: "Sign in with PIN" }).click();
    await page.waitForURL(`${origin}/vault/settings`, { timeout: 15000 });
    stage = "unsupported browser fallback";
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() => { Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }); });
    await unsupported.goto(`${origin}/unlock`);
    // Next.js may first stream the route's loading boundary; wait for the form.
    await unsupported.locator("#owner-password").waitFor({ state: "visible", timeout: 15_000 });
    const passkeyButtonCount = await unsupported.getByRole("button", { name: "Sign in with passkey" }).count();
    if (passkeyButtonCount !== 0) throw new Error("Unsupported browser offered a passkey button");
    console.log("Disposable Chrome virtual passkey registration/sign-in, user-verification rejection, PIN sign-in, and unsupported fallback passed. Vault key remains a separate unlock.");
  } catch {
    console.error(`Disposable passkey browser check failed at ${stage}${detail ? ` (${detail.slice(0, 120)})` : ""}; the real owner was not changed.`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill();
    if (temporary) {
      try { await temporary.dropDatabase(); } catch { console.error("Temporary passkey database cleanup failed; inspect Atlas."); process.exitCode = 1; }
    }
    await closeDatabaseConnection().catch(() => undefined);
  }
}
void main();
