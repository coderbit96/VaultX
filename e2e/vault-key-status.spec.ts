import { build } from "esbuild";
import { expect, test } from "@playwright/test";

test("a memory-only key cannot enable uploads before its backup is stored", async ({ page }) => {
  const output = await build({ entryPoints: ["tests/browser-vault-key-status-entry.tsx"],
    tsconfig: "tsconfig.json", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
  const vaultId = "B".repeat(22);
  let stored: "uninitialized" | "ready" = "uninitialized";
  let storedId = vaultId;
  await page.route("**/api/vault/keys", async (route) => route.fulfill({ status: 200,
    contentType: "application/json", body: JSON.stringify(stored === "ready"
      ? { status: "ready", envelope: { vaultId: storedId } } : { status: "uninitialized" }) }));
  await page.goto("/unlock");
  await page.evaluate(() => { document.body.insertAdjacentHTML("beforeend", '<div id="vault-key-status-probe"></div>'); });
  await page.addScriptTag({ content: output.outputFiles[0].text });
  const probe = page.getByTestId("stored-key-ready");
  await expect(probe).toHaveText("blocked");

  await page.evaluate((id) => (window as unknown as { vaultKeyStatusProbe: { install(id: string): void } }).vaultKeyStatusProbe.install(id), vaultId);
  await expect.poll(() => page.evaluate(() => (window as unknown as { vaultKeyStatusProbe: { hasKey(): boolean } }).vaultKeyStatusProbe.hasKey())).toBe(false);
  await expect(probe).toHaveText("blocked");

  stored = "ready";
  await page.evaluate((id) => (window as unknown as { vaultKeyStatusProbe: { install(id: string): void } }).vaultKeyStatusProbe.install(id), vaultId);
  await expect(probe).toHaveText("ready");

  storedId = "C".repeat(22);
  await page.evaluate((id) => (window as unknown as { vaultKeyStatusProbe: { install(id: string): void } }).vaultKeyStatusProbe.install(id), vaultId);
  await expect(probe).toHaveText("blocked");
  await expect.poll(() => page.evaluate(() => (window as unknown as { vaultKeyStatusProbe: { hasKey(): boolean } }).vaultKeyStatusProbe.hasKey())).toBe(false);
});
