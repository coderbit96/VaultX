import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryDeletionProvider } from "../src/lib/cloudinary/deletion-provider";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { runRecoveryPass } from "../src/lib/recovery/run";

async function main() {
  if (process.argv.slice(2).join(" ") !== "--run") {
    console.error("Run npm run recovery:run -- --run from the trusted VaultX server to process one bounded pass.");
    process.exitCode = 1;
    return;
  }
  loadEnvConfig(process.cwd());
  try {
    const { cloudName, apiKey, apiSecret } = readCloudinaryConfig();
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    const result = await runRecoveryPass(await getDatabase(), {
      uploads: cloudinaryUploadProvider(cloudinary), deletions: cloudinaryDeletionProvider(cloudinary),
    });
    console.log(`Uploads scanned: ${result.uploads.scanned}; cleaned: ${result.uploads.cleaned}; deferred: ${result.uploads.deferred}.`);
    console.log(`Deletions scanned: ${result.deletions.scanned}; completed: ${result.deletions.completed}; deferred: ${result.deletions.deferred}.`);
    if (result.uploads.deferred || result.deletions.deferred) process.exitCode = 1;
  } catch {
    console.error("Recovery pass unavailable. Durable jobs remain for a later retry; check server configuration and service access.");
    process.exitCode = 1;
  } finally { await closeDatabaseConnection(); }
}

void main();
