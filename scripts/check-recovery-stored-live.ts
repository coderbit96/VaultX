import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { signedCiphertextUrl, proxyCiphertextRange } from "../src/lib/cloudinary/ciphertext-access-core";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { deriveVaultPasswordKey } from "../src/lib/crypto/argon2-browser";
import { openEncryptedContainer, prepareEncryptedFile, type CiphertextSource } from "../src/lib/crypto/file-container";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { createVaultKeys, unlockVaultWithRecovery } from "../src/lib/crypto/vault-keys";
import type { VaultFile } from "../src/lib/database/models";

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.error("Run with --live for one disposable encrypted Cloudinary object and fresh-key recovery.");
    process.exitCode = 2;
    return;
  }
  loadEnvConfig(process.cwd());
  let stage = "configuration";
  const planned = { publicId: `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`,
    resourceType: "raw" as const, deliveryType: "authenticated" as const, format: "dat" as const, cleanupCompleted: false };
  let provider: ReturnType<typeof cloudinaryUploadProvider> | undefined;
  try {
    const config = readCloudinaryConfig();
    cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true });
    provider = cloudinaryUploadProvider(cloudinary);
    const passphrase = randomBytes(36).toString("base64url");
    const keys = await createVaultKeys(passphrase, deriveVaultPasswordKey);
    stage = "client encryption";
    installVaultRootKey(keys.rootKey, keys.envelope.vaultId);
    keys.rootKey.fill(0);
    const original = randomBytes(4_096);
    const metadata = { storedName: "synthetic.bin", extension: "bin", mimeType: "application/octet-stream" };
    const prepared = await prepareEncryptedFile(new Blob([original]), metadata, "other");
    const parts: Uint8Array[] = [];
    for await (const part of prepared.chunks()) parts.push(part);
    const ciphertext = Uint8Array.from(Buffer.concat(parts));
    stage = "restricted provider upload";
    const uploaded = await provider.upload(planned, ciphertext);
    assert.equal(uploaded.publicId, planned.publicId);
    assert.equal(uploaded.resourceType, "raw");
    assert.equal(uploaded.deliveryType, "authenticated");
    assert.equal(uploaded.bytes, ciphertext.length);

    stage = "fresh key recovery and provider range decryption";
    clearVaultKeyMaterial();
    ciphertext.fill(0);
    const serializedEnvelope = JSON.parse(JSON.stringify(keys.envelope));
    const recovered = await unlockVaultWithRecovery(serializedEnvelope, keys.recoveryCode);
    installVaultRootKey(recovered, keys.envelope.vaultId);
    recovered.fill(0);
    const file = { storedSizeBytes: uploaded.bytes,
      cloudinary: { ...planned, assetId: uploaded.assetId, version: uploaded.version } } as unknown as VaultFile;
    const source: CiphertextSource = { size: BigInt(uploaded.bytes), async read(start, endExclusive) {
      const response = await proxyCiphertextRange({ file,
        range: `bytes=${start}-${endExclusive - BigInt(1)}`,
        makeUrl: () => signedCiphertextUrl(cloudinary, file) });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), `bytes ${start}-${endExclusive - BigInt(1)}/${uploaded.bytes}`);
      return new Uint8Array(await response.arrayBuffer());
    } };
    const opened = await openEncryptedContainer(source, prepared.manifest);
    try {
      assert.equal(opened.metadata.storedName, metadata.storedName);
      assert.equal(opened.metadata.extension, metadata.extension);
      assert.equal(opened.metadata.mimeType, metadata.mimeType);
      const decoded: Uint8Array[] = [];
      for await (const chunk of opened.chunks()) decoded.push(chunk);
      assert.deepEqual(Buffer.concat(decoded), original);
      for (const chunk of decoded) chunk.fill(0);
    } finally { opened.close(); }
    original.fill(0);
    console.log("Disposable private Cloudinary ciphertext decrypted after fresh recovery-key unlock using authenticated ranges PASS.");
  } catch {
    console.error(`Stored-file recovery check failed at ${stage}; no key, ID, URL, or file bytes printed.`);
    process.exitCode = 1;
  } finally {
    clearVaultKeyMaterial();
    if (provider) {
      try {
        if (await provider.lookup(planned)) {
          await provider.destroy(planned);
          if (await provider.lookup(planned)) throw new Error("cleanup_unconfirmed");
        }
        console.log("Disposable Cloudinary object removed.");
      } catch {
        console.error("Disposable recovery-test object cleanup could not be confirmed; inspect the vaultx/ciphertext namespace.");
        process.exitCode = 1;
      }
    }
  }
}

void main();
