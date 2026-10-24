import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { signedCiphertextUrl, proxyCiphertextRange } from "../src/lib/cloudinary/ciphertext-access-core";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { prepareEncryptedFile } from "../src/lib/crypto/file-container";
import type { VaultFile } from "../src/lib/database/models";

async function read(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function main() {
  if (!process.argv.includes("--live")) {
    console.error("Run with --live to create and delete one synthetic encrypted ciphertext object.");
    process.exitCode = 2;
    return;
  }
  loadEnvConfig(process.cwd());
  let created = false;
  let planned: { publicId: string; resourceType: "raw"; deliveryType: "authenticated"; format: "dat"; cleanupCompleted: boolean } | undefined;
  try {
    const config = readCloudinaryConfig();
    cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true });
    const provider = cloudinaryUploadProvider(cloudinary);
    installVaultRootKey(new Uint8Array(randomBytes(32)), randomBytes(16).toString("base64url"));
    const prepared = await prepareEncryptedFile(new Blob([randomBytes(1_024)]),
      { storedName: "synthetic.dat", extension: "dat", mimeType: "application/octet-stream" }, "other");
    const chunks: Uint8Array[] = [];
    for await (const part of prepared.chunks()) chunks.push(part);
    const ciphertext = Uint8Array.from(Buffer.concat(chunks));
    planned = { publicId: `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`, resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false };
    const uploaded = await provider.upload(planned, ciphertext);
    created = true;
    const file = { storedSizeBytes: ciphertext.byteLength, cloudinary: { ...planned, assetId: uploaded.assetId, version: uploaded.version } } as unknown as VaultFile;

    const anonymousUrl = cloudinary.url(planned.publicId, { resource_type: "raw", type: "authenticated", secure: true });
    const anonymous = await fetch(anonymousUrl, { cache: "no-store", redirect: "error" });
    await anonymous.body?.cancel();
    assert.ok([401, 403, 404].includes(anonymous.status));

    const first = await proxyCiphertextRange({ file, range: "bytes=0-79", makeUrl: () => signedCiphertextUrl(cloudinary, file) });
    assert.equal(first.status, 206);
    assert.equal(first.headers.get("content-range"), `bytes 0-79/${ciphertext.byteLength}`);
    assert.deepEqual([...await read(first)], [...ciphertext.subarray(0, 80)]);
    const start = Math.floor(ciphertext.byteLength / 2);
    const end = Math.min(ciphertext.byteLength - 1, start + 63);
    const middle = await proxyCiphertextRange({ file, range: `bytes=${start}-${end}`, makeUrl: () => signedCiphertextUrl(cloudinary, file) });
    assert.equal(middle.status, 206);
    assert.deepEqual([...await read(middle)], [...ciphertext.subarray(start, end + 1)]);
    console.log("Cloudinary anonymous denial and two authenticated ciphertext gateway ranges PASS.");
  } catch {
    console.error("Live ciphertext gateway check failed. No credentials, URLs, object IDs, or bytes are printed.");
    process.exitCode = 1;
  } finally {
    clearVaultKeyMaterial();
    if (created && planned) {
      try {
        const config = readCloudinaryConfig();
        cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true });
        const provider = cloudinaryUploadProvider(cloudinary);
        await provider.destroy(planned);
        if (await provider.lookup(planned)) throw new Error("Synthetic cleanup not confirmed");
        console.log("Synthetic ciphertext object removed.");
      } catch {
        console.error("Synthetic cleanup could not be confirmed. Run the guarded upload reconciliation after checking Cloudinary.");
        process.exitCode = 1;
      }
    }
  }
}

void main();
