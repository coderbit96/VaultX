import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const origin = "http://localhost:3155";

async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${origin}/install`)).ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Local production server did not start");
}

async function main() {
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3155"],
    { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const resultsDirectory = resolve(process.cwd(), "test-results");
  await mkdir(resultsDirectory, { recursive: true });
  const profile = await mkdtemp(join(resultsDirectory, "pwa-profile-"));
  try {
    await ready();
    context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true,
      serviceWorkers: "allow", viewport: { width: 390, height: 844 } });
    const page = context.pages()[0] ?? await context.newPage();
    await page.addInitScript(() => {
      (window as typeof window & { vaultxInstallPromptSeen?: boolean }).vaultxInstallPromptSeen = false;
      const monitored = window as typeof window & { vaultxCspViolations?: string[] };
      monitored.vaultxCspViolations = [];
      window.addEventListener("securitypolicyviolation", (event) => {
        monitored.vaultxCspViolations?.push(event.effectiveDirective);
      });
      window.addEventListener("beforeinstallprompt", () => {
        (window as typeof window & { vaultxInstallPromptSeen?: boolean }).vaultxInstallPromptSeen = true;
      });
    });
    await page.goto(`${origin}/install`);
    assert.deepEqual(await page.evaluate(() => (window as typeof window & { vaultxCspViolations?: string[] }).vaultxCspViolations), []);
    assert.equal(await page.evaluate(() => window.isSecureContext), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: join(resultsDirectory, "pwa-install-phone.png"), fullPage: true });
    const manifestLink = await page.locator('link[rel="manifest"]').getAttribute("href");
    assert.ok(manifestLink);
    const manifestResponse = await context.request.get(new URL(manifestLink, origin).toString());
    assert.equal(manifestResponse.ok(), true);
    const manifest = await manifestResponse.json() as { start_url: string; display: string; icons: { src: string }[] };
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.display, "standalone");
    for (const icon of manifest.icons) assert.equal((await context.request.get(`${origin}${icon.src}`)).ok(), true);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    const devtools = await context.newCDPSession(page);
    const installability = await devtools.send("Page.getInstallabilityErrors").catch(() => null);
    await context.setOffline(true);
    await page.goto(`${origin}/vault/files`);
    assert.match(await page.title(), /Connection needed/);
    assert.equal(await page.getByRole("link", { name: "Open selected offline copies" }).isVisible(), true);
    await context.setOffline(false);
    await page.goto(`${origin}/install`);
    await page.evaluate(async () => { await fetch("/api/auth/verify", { method: "POST", cache: "no-store" }); });
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      return (await Promise.all(keys.map(async (key) => (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname)))).flat();
    });
    assert.deepEqual(cached.sort(), ["/offline.html", "/offline-vault.html", "/offline-vault.js", "/offline-kdf.js", "/icons/icon-192.png", "/icons/icon-512.png",
      "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"].sort());
    const prompted = await page.evaluate(() => !!(window as typeof window & { vaultxInstallPromptSeen?: boolean }).vaultxInstallPromptSeen);
    if (prompted) assert.equal(await page.getByRole("button", { name: "Install", exact: true }).isVisible(), true);
    await page.goto(origin);
    await page.waitForURL(`${origin}/unlock`);
    assert.equal(new URL(page.url()).pathname, "/unlock");
    assert.deepEqual(await page.evaluate(() => (window as typeof window & { vaultxCspViolations?: string[] }).vaultxCspViolations), []);
    console.log("Production manifest, icons, controlled service worker, offline fallback, and public-only cache: PASS.");
    console.log(`Desktop Chrome installability errors: ${installability ? JSON.stringify(installability) : "unavailable"}.`);
    console.log(`Desktop headless Chrome install prompt observed: ${prompted ? "yes" : "no (manual browser check required)"}.`);
  } finally {
    await context?.close();
    server.kill();
    if (resolve(profile).startsWith(`${resultsDirectory}\\pwa-profile-`)) {
      await rm(profile, { recursive: true, force: true });
    }
  }
}

void main().catch(() => { console.error("PWA browser check failed. Confirm the production build and Chrome installation."); process.exitCode = 1; });
