import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { reconcileExpiredUploads } from "../src/lib/uploads/reconcile";

async function main() {
  if (!process.argv.includes("--run")) {
    console.error("This checks and deletes expired unfinished Cloudinary objects. Run with --run to proceed.");
    process.exitCode = 1;
    return;
  }
  loadEnvConfig(process.cwd());
  const { cloudName, apiKey, apiSecret } = readCloudinaryConfig();
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  try {
    const result = await reconcileExpiredUploads(await getDatabase(), cloudinaryUploadProvider(cloudinary));
    console.log(`Expired upload jobs scanned: ${result.scanned}; cleaned: ${result.cleaned}; deferred: ${result.deferred}.`);
    if (result.deferred) process.exitCode = 1;
  } catch {
    console.error("Upload reconciliation could not complete. Jobs remain for retry; check service access.");
    process.exitCode = 1;
  } finally { await closeDatabaseConnection(); }
}

void main();
