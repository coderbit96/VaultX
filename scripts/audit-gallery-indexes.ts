import { loadEnvConfig } from "@next/env";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";

async function main() {
  loadEnvConfig(process.cwd());
  try {
    const db = await getDatabase();
    let expected = 0;
    let present = 0;
    for (const collection of ["files", "folders", "uploadJobs", "deletionJobs"] as const) {
      const names = new Set((await db.collection(collection).listIndexes().toArray()).map((index) => index.name));
      const missing = modelIndexes[collection].filter((index) => !names.has(index.name)).map((index) => index.name);
      expected += modelIndexes[collection].length;
      present += modelIndexes[collection].length - missing.length;
      console.log(`${collection}: ${modelIndexes[collection].length - missing.length}/${modelIndexes[collection].length} expected indexes present${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`);
    }
    console.log(`Read-only index audit: ${present}/${expected} expected indexes present.`);
    if (present !== expected) process.exitCode = 1;
  } catch {
    console.error("Read-only index audit unavailable. Check Atlas access and existing collection permissions.");
    process.exitCode = 1;
  } finally { await closeDatabaseConnection().catch(() => undefined); }
}

void main();
