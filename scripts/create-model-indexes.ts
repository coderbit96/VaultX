import { loadEnvConfig } from "@next/env";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { ensureModelIndexes, modelIndexes } from "../src/lib/database/model-indexes";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  try {
    const db = await getDatabase();
    await ensureModelIndexes(db);
    for (const [collectionName, indexes] of Object.entries(modelIndexes)) {
      const actual = new Set((await db.collection(collectionName).listIndexes().toArray()).map((index) => index.name));
      if (indexes.some((index) => !actual.has(index.name))) throw new Error("Missing model index");
    }
    console.log("VaultX model indexes were created and verified in Atlas.");
  } catch {
    console.error("Index setup failed. Check Atlas access, permissions, and existing index conflicts.");
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
  }
}

void main();
