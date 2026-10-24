import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { createVaultKeys } from "../src/lib/crypto/vault-keys";
import { deriveVaultPasswordKey } from "../src/lib/crypto/argon2-browser";
import { encryptFileName, newFileId } from "../src/lib/crypto/file-names";
import { prepareEncryptedFile } from "../src/lib/crypto/file-container";
import type { FileAccessMetadata } from "../src/lib/files/types";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
const origin = "http://localhost:3164";

async function fixture() {
  const passphrase = randomBytes(24).toString("base64url");
  const generated = await createVaultKeys(passphrase, deriveVaultPasswordKey);
  const id = newFileId();
  installVaultRootKey(generated.rootKey, generated.envelope.vaultId);
  const payload = new TextEncoder().encode("Synthetic selected offline check.\n");
  const prepared = await prepareEncryptedFile(new Blob([payload as Uint8Array<ArrayBuffer>]), {
    storedName: "offline-check.txt", extension: "txt", mimeType: "text/plain",
  }, "other");
  const chunks: Uint8Array[] = [];
  for await (const chunk of prepared.chunks()) chunks.push(chunk);
  const ciphertext = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { ciphertext.set(chunk, offset); offset += chunk.length; }
  const file: FileAccessMetadata = { id, folderId: null, nameEncrypted: await encryptFileName(id, "offline-check.txt"),
    extension: "txt", category: "document", mimeType: "text/plain", storedSizeBytes: ciphertext.length,
    encryptionManifest: prepared.manifest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  clearVaultKeyMaterial();
  return { passphrase, envelope: generated.envelope, root: Array.from(generated.rootKey), file, ciphertext: Array.from(ciphertext), payload: Buffer.from(payload) };
}

async function main() {
  let stage = "server startup";
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3164"],
    { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
  const results = resolve("test-results"); await mkdir(results, { recursive: true });
  const profile = await mkdtemp(join(results, "offline-profile-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`${origin}/install`)).ok) { ready = true; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(ready, true, "Production server did not start");
    stage = "synthetic encryption";
    const synthetic = await fixture();
    stage = "browser startup";
    context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true,
      serviceWorkers: "allow", acceptDownloads: true, viewport: { width: 390, height: 844 } });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/install`);
    stage = "service worker install";
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.goto(`${origin}/offline-vault.html`);
    stage = "synthetic encrypted local storage";
    await page.evaluate(async ({ file, root, envelope, ciphertext }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open("vaultx-encrypted-offline-v1", 1);
        opening.onupgradeneeded = () => {
          opening.result.createObjectStore("copies", { keyPath: "id" });
          opening.result.createObjectStore("blocks"); opening.result.createObjectStore("settings");
        };
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.importKey("raw", new Uint8Array(root), "AES-GCM", false, ["encrypt"]);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
        additionalData: new TextEncoder().encode(`VaultX/offline-metadata/v1/${envelope.vaultId}/${file.id}`) }, key,
      new TextEncoder().encode(JSON.stringify(file))));
      const tx = db.transaction(["copies", "blocks", "settings"], "readwrite");
      tx.objectStore("copies").put({ id: file.id, copyId: "synthetic-check", sealed, nonce });
      tx.objectStore("blocks").put(new Uint8Array(ciphertext), "synthetic-check:0");
      tx.objectStore("settings").put(envelope, "envelope");
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      db.close();
    }, synthetic);
    await context.setOffline(true);
    stage = "offline shell navigation";
    await page.goto(`${origin}/vault/files`);
    await page.getByRole("link", { name: "Open selected offline copies" }).click();
    await page.getByLabel("Vault passphrase").fill(synthetic.passphrase);
    await page.getByRole("button", { name: "Unlock local copies" }).click();
    stage = "offline vault unlock";
    await page.getByText("offline-check.txt", { exact: false }).waitFor({ timeout: 30_000 });
    await page.evaluate(() => { Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined }); });
    const downloadPromise = page.waitForEvent("download");
    stage = "offline decrypted download";
    await page.getByRole("button", { name: "Download decrypted copy" }).click();
    const download = await downloadPromise;
    assert.deepEqual(await readFile(await download.path()), synthetic.payload);
    await page.getByRole("button", { name: "Lock now" }).click();
    stage = "lock clears visible names";
    assert.equal(await page.getByText("offline-check.txt", { exact: false }).count(), 0);
    await page.getByLabel("Vault passphrase").fill(synthetic.passphrase);
    await page.getByRole("button", { name: "Unlock local copies" }).click();
    await page.getByText("offline-check.txt", { exact: false }).waitFor();
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent("vaultx:file-deleting", { detail: id })), synthetic.file.id);
    stage = "deletion removes local copy";
    await page.getByText("No selected offline copies remain", { exact: false }).waitFor();
    assert.equal(await page.getByText("offline-check.txt", { exact: false }).count(), 0);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Clear offline copies" }).click();
    console.log("Offline viewer, encrypted local unlock, downloaded bytes, lock, and deletion event: PASS.");
  } catch (error) {
    console.error(`Offline browser check failed during ${stage}: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}.`);
    throw new Error("Offline browser check failed");
  } finally {
    await context?.close(); server.kill();
    if (resolve(profile).startsWith(`${results}\\offline-profile-`)) await rm(profile, { recursive: true, force: true });
  }
}

void main().catch(() => { process.exitCode = 1; });
