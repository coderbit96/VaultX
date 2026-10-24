import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { createVaultKeys, unlockVaultWithPassphrase } from "../src/lib/crypto/vault-keys";
import { encryptFileName, newFileId } from "../src/lib/crypto/file-names";
import { openEncryptedContainer, prepareEncryptedFile } from "../src/lib/crypto/file-container";
import { clearOfflineCopies, getOfflineEnvelope, listOfflineCopies, offlineCiphertextSource, openOfflineDb, openOfflineDetails, removeOfflineCopy, saveOfflineCopy } from "../src/lib/offline/copies";
import type { FileAccessMetadata } from "../src/lib/files/types";

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  onLine: true, storage: { estimate: async () => ({ usage: 0, quota: 1_000_000_000 }), persist: async () => false },
} });

const derive = async (password: Uint8Array, salt: Uint8Array) => {
  const combined = new Uint8Array(password.length + salt.length);
  combined.set(password); combined.set(salt, password.length);
  try { return new Uint8Array(await crypto.subtle.digest("SHA-256", combined)); }
  finally { combined.fill(0); }
};

test("selected ciphertext authenticates offline; lock, eviction, deletion and concurrent clearing fail closed", async () => {
  const passphrase = "Lighthouse orbit maple constellation 84!";
  const generated = await createVaultKeys(passphrase, derive);
  installVaultRootKey(generated.rootKey, generated.envelope.vaultId);
  const id = newFileId();
  const plaintext = new Uint8Array(1_048_601);
  crypto.getRandomValues(plaintext.subarray(0, 65_536));
  plaintext.fill(42, 65_536);
  const prepared = await prepareEncryptedFile(new Blob([plaintext as Uint8Array<ArrayBuffer>]), {
    storedName: "test-note.txt", extension: "txt", mimeType: "text/plain",
  }, "other");
  const encrypted: Uint8Array[] = [];
  for await (const chunk of prepared.chunks()) encrypted.push(chunk);
  const ciphertext = new Uint8Array(encrypted.reduce((total, item) => total + item.length, 0));
  let cursor = 0;
  for (const chunk of encrypted) { ciphertext.set(chunk, cursor); cursor += chunk.length; }
  const file: FileAccessMetadata = {
    id, folderId: null, nameEncrypted: await encryptFileName(id, "test-note.txt"),
    extension: "txt", category: "document", mimeType: "text/plain", storedSizeBytes: ciphertext.length,
    encryptionManifest: prepared.manifest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const previousFetch = globalThis.fetch;
  const rangeFetch: typeof fetch = async (_input, init) => {
    const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(range);
    const start = Number(range[1]), end = Number(range[2]);
    const bytes = ciphertext.slice(start, end + 1);
    return new Response(bytes, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${ciphertext.length}`,
      "Content-Length": String(bytes.length), "Content-Type": "application/octet-stream" } });
  };
  globalThis.fetch = rangeFetch;
  try {
    await saveOfflineCopy(file, generated.envelope);
    const [copy] = await listOfflineCopies();
    assert.equal(copy.id, id);
    assert.equal(Object.hasOwn(copy, "size"), false);
    assert.deepEqual(await getOfflineEnvelope(), generated.envelope);
    const details = await openOfflineDetails(copy);
    assert.equal(details.id, id);
    assert.equal(details.storedSizeBytes, ciphertext.length);
    assert.equal(JSON.stringify(copy).includes("test-note.txt"), false);
    const tampered = { ...copy, sealed: copy.sealed.slice() };
    tampered.sealed[0] ^= 1;
    await assert.rejects(openOfflineDetails(tampered));
    clearVaultKeyMaterial();
    await assert.rejects(openOfflineDetails(copy));
    const recovered = await unlockVaultWithPassphrase(generated.envelope, passphrase, derive);
    installVaultRootKey(recovered, generated.envelope.vaultId); recovered.fill(0);
    Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: false });
    globalThis.fetch = async () => { throw new Error("Network must not be read offline"); };
    const opened = await openEncryptedContainer(await offlineCiphertextSource(copy, details.storedSizeBytes), details.encryptionManifest);
    const output = new Uint8Array(plaintext.length);
    let offset = 0;
    for await (const chunk of opened.chunks()) { output.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
    assert.deepEqual(output, plaintext);
    const db = await openOfflineDb();
    const tx = db.transaction("blocks", "readwrite");
    tx.objectStore("blocks").delete(`${copy.copyId}:${Math.ceil(details.storedSizeBytes / 1_048_576) - 1}`);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
    await assert.rejects(async () => {
      const missing = await openEncryptedContainer(await offlineCiphertextSource(copy, details.storedSizeBytes), details.encryptionManifest);
      try { for await (const chunk of missing.chunks()) chunk.fill(0); }
      finally { missing.close(); }
    });
    await removeOfflineCopy(id);
    assert.equal((await listOfflineCopies()).length, 0);
    await clearOfflineCopies();
    assert.equal(await getOfflineEnvelope(), null);
    Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, value: true });
    for (const removal of [() => removeOfflineCopy(id), () => clearOfflineCopies()]) {
      let entered!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { resume = resolve; });
      let first = true;
      globalThis.fetch = async (input, init) => {
        if (first) { first = false; entered(); await held; }
        return rangeFetch(input, init);
      };
      const pending = saveOfflineCopy(file, generated.envelope);
      await started;
      await removal();
      resume();
      await assert.rejects(pending, /cleared or removed/);
      assert.equal((await listOfflineCopies()).length, 0);
    }
  } finally {
    globalThis.fetch = previousFetch;
    clearVaultKeyMaterial(); generated.rootKey.fill(0); plaintext.fill(0); ciphertext.fill(0);
  }
});
