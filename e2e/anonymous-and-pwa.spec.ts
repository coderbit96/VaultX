import { expect, test } from "@playwright/test";

test("unknown page shows a public-safe 404", async ({ page }) => {
  const response = await page.goto("/not-a-vault-route");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open unlock" })).toHaveAttribute("href", "/unlock");
  await expect(page.getByText("Private library / Files")).toHaveCount(0);
});

test("owner password can be shown and hidden without submitting the form", async ({ page }) => {
  await page.goto("/unlock");
  const password = page.getByLabel("Owner password");
  await password.fill("synthetic-test-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveValue("synthetic-test-password");
  await page.getByRole("button", { name: "Hide password" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(page).toHaveURL(/\/unlock$/);
});

test("anonymous browser cannot discover private pages or asset APIs", async ({ page, request }) => {
  await page.goto("/unlock");
  await expect(page.getByRole("heading", { name: "Unlock your vault." })).toBeVisible();
  const document = await request.get("/unlock");
  const policy = document.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("'strict-dynamic'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(document.headers()["cache-control"]).toContain("no-store");

  for (const path of [
    "/api/vault/keys", "/api/vault/summary", "/api/vault/gallery?category=image&counts=1", "/api/files", "/api/folders",
    "/api/uploads/init", "/api/deletions", "/api/settings",
    "/api/files/507f1f77bcf86cd799439011/access",
    "/api/files/507f1f77bcf86cd799439011/thumbnail",
    "/api/files/507f1f77bcf86cd799439011/download",
    "/api/uploads/507f1f77bcf86cd799439011/ciphertext",
  ]) {
    const response = await request.get(path);
    expect(response.status(), `${path} must deny anonymous access`).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect((await response.json()).error.code).toBe("unauthorized");
  }
  const bulkDelete = await request.post("/api/deletions/bulk", { data: { ids: ["507f1f77bcf86cd799439011"] } });
  expect(bulkDelete.status()).toBe(401);
  expect(bulkDelete.headers()["cache-control"]).toContain("no-store");
  for (const path of ["/signup", "/register", "/share", "/invite", "/api/share", "/api/invites"]) {
    expect((await request.get(path)).status(), `${path} must not exist`).toBe(404);
  }
  // Auth.js owns this dynamic path and rejects unsupported actions with 400.
  expect((await request.get("/api/auth/signup")).status()).toBe(400);
  await page.goto("/vault/files");
  await page.waitForURL("**/unlock");
  await expect(page.getByText("Private library / Files")).toHaveCount(0);
  await page.goto("/vault/gallery");
  await page.waitForURL("**/unlock");
  await expect(page.getByRole("heading", { name: "Your gallery" })).toHaveCount(0);
});

test.describe("mobile public PWA shell", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test("manifest, service worker and offline fallback contain no private response", async ({ page, request }) => {
    await page.goto("/install");
    await expect(page.getByRole("heading", { name: "Install VaultX" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const manifest = await (await request.get("/manifest.webmanifest")).json() as { display: string; start_url: string };
    expect(manifest).toMatchObject({ display: "standalone", start_url: "/" });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const cachePaths = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (key) =>
      (await (await caches.open(key)).keys()).map((entry) => new URL(entry.url).pathname)))).flat());
    expect(cachePaths.length).toBeGreaterThan(0);
    const allowed = new Set(["/offline.html", "/offline-vault.html", "/offline-vault.js", "/offline-kdf.js",
      "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]);
    expect(cachePaths.every((path) => allowed.has(path))).toBe(true);
    await page.context().setOffline(true);
    await page.goto("/vault/files");
    await expect(page.getByRole("link", { name: "Open selected offline copies" })).toBeVisible();
  });
});
