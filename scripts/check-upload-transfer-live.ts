import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { ObjectId } from "mongodb";
import { v2 as cloudinary } from "cloudinary";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { prepareEncryptedFile, type MediaCategory } from "../src/lib/crypto/file-container";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { uploadJobSchema } from "../src/lib/database/models";
import { verifyProviderAsset, verifyStoredHeader } from "../src/lib/uploads/lifecycle";

async function main() {
if (!process.argv.includes("--live")) {
  console.error("Run with --live to create and delete three small synthetic ciphertext objects.");
  process.exitCode = 2;
} else {
  loadEnvConfig(process.cwd());
  let stage = "configuration";
  try {
    const config = readCloudinaryConfig();
    cloudinary.config({ cloud_name: config.cloudName, api_key: config.apiKey, api_secret: config.apiSecret, secure: true });
    const provider = cloudinaryUploadProvider(cloudinary);
    for (const category of ["image", "video", "other"] as MediaCategory[]) {
      stage = `${category} preparation`;
      const vaultId = randomBytes(16).toString("base64url");
      installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
      const metadata = { storedName: "synthetic.dat", extension: "dat", mimeType: "application/octet-stream" };
      const prepared = await prepareEncryptedFile(new Blob([randomBytes(2_048)]), metadata, category);
      const chunks: Uint8Array[] = [];
      for await (const chunk of prepared.chunks()) chunks.push(chunk);
      const cipher = Uint8Array.from(Buffer.concat(chunks));
      const publicId = `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`;
      const planned = { publicId, resourceType: "raw" as const, deliveryType: "authenticated" as const,
        format: "dat", cleanupCompleted: false };
      const job = uploadJobSchema.parse({ _id: new ObjectId(), ownerId: new ObjectId(), fileId: new ObjectId(),
        folderId: null, category, manifest: prepared.manifest, ciphertextBytes: cipher.length,
        intentExpiresAt: new Date(Date.now() + 600_000), status: "pending", attempts: 0,
        cloudAssets: [planned], createdAt: new Date(), updatedAt: new Date() });
      let created = false;
      try {
        stage = `${category} upload`;
        const uploaded = await provider.upload(planned, cipher);
        created = true;
        stage = `${category} upload response`;
        stage = `${category} Admin lookup`;
        const found = await provider.lookup({ ...planned, assetId: uploaded.assetId });
        verifyProviderAsset({ ...job, cloudAssets: [{ ...planned, assetId: uploaded.assetId }] }, uploaded);
        verifyProviderAsset({ ...job, cloudAssets: [{ ...planned, assetId: uploaded.assetId }] }, found);
        stage = `${category} anonymous delivery`;
        const unsigned = cloudinary.url(planned.publicId, { resource_type: "raw", type: "authenticated", secure: true });
        const anonymous = await fetch(unsigned, { cache: "no-store", redirect: "error" });
        await anonymous.body?.cancel();
        if (![401, 403, 404].includes(anonymous.status)) throw new Error("Anonymous delivery was not denied");
        stage = `${category} restricted range`;
        verifyStoredHeader(job, await provider.readHeader(planned, cipher.length));
        console.log(`${category}: ciphertext upload, metadata, anonymous denial and signed range PASS`);
      } finally {
        const previous = stage;
        try {
          if (created || await provider.lookup(planned).catch(() => null)) {
            await provider.destroy(planned);
            if (await provider.lookup(planned)) throw new Error("Synthetic object cleanup not confirmed");
          }
        } catch { stage = `${category} cleanup`; throw new Error("Synthetic cleanup failed"); }
        finally { clearVaultKeyMaterial(); }
        stage = previous;
      }
    }
    console.log("Synthetic upload objects removed.");
  } catch {
    console.error(`Live synthetic transfer check failed at ${stage}. No secrets or object IDs are printed.`);
    process.exitCode = 1;
  }
}
}

void main();
