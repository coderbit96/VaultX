import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryDeletionProvider } from "../src/lib/cloudinary/deletion-provider";
import { reconcileDeletions } from "../src/lib/deletions/reconcile";

async function main() {
  if (!process.argv.includes("--run")) {
    console.error("This retries due file and folder deletion jobs. Run with --run to proceed.");
    process.exitCode = 1;
    return;
  }
  loadEnvConfig(process.cwd());
  try {
    const { cloudName, apiKey, apiSecret } = readCloudinaryConfig();
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    const result = await reconcileDeletions(await getDatabase(), cloudinaryDeletionProvider(cloudinary));
    console.log(`Deletion jobs scanned: ${result.scanned}; completed: ${result.completed}; deferred: ${result.deferred}.`);
    if (result.deferred) process.exitCode = 1;
  } catch {
    console.error("Deletion reconciliation could not complete. Jobs remain for retry; check service access.");
    process.exitCode = 1;
  } finally { await closeDatabaseConnection(); }
}

void main();
