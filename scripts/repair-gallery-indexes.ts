import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";

const targetNames = new Set([
  "owner_folder_ready_category",
  "cloudinary_public_id_unique",
  "owner_ready_favorite_date",
  "owner_category_ready_date",
]);

async function main(): Promise<void> {
  const mode = process.argv[2];
  if ((mode !== "--check" && mode !== "--apply") || process.argv.length !== 3) {
    console.error("Use --check for a read-only preflight or --apply to create only the four gallery file indexes.");
    process.exitCode = 1;
    return;
  }

  loadEnvConfig(process.cwd());
  try {
    const files = (await getDatabase()).collection("files");
    const expected = modelIndexes.files.filter((index) => targetNames.has(index.name as string));
    assert.equal(expected.length, targetNames.size);
    const actual = await files.listIndexes().toArray();
    const missing = expected.filter((index) => {
      const existing = actual.find((item) => item.name === index.name);
      if (!existing) return true;
      assert.deepEqual(existing.key, index.key);
      assert.equal(Boolean(existing.unique), Boolean(index.unique));
      assert.equal(Boolean(existing.sparse), Boolean(index.sparse));
      return false;
    });

    if (missing.some((index) => index.name === "cloudinary_public_id_unique")) {
      // A sparse unique index still indexes an explicitly present null value.
      // Return only a boolean; object IDs and values never enter diagnostics.
      const duplicate = await files.aggregate([
        { $match: { "cloudinary.publicId": { $exists: true } } },
        { $group: { _id: "$cloudinary.publicId", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
        { $project: { _id: 0 } },
      ], { allowDiskUse: false }).hasNext();
      if (duplicate) throw new Error("duplicate_provider_identity");
    }

    console.log(`Gallery index preflight passed; ${missing.length} of four indexes need creation.`);
    if (mode === "--apply" && missing.length) {
      await files.createIndexes(missing);
      const names = new Set((await files.listIndexes().toArray()).map((index) => index.name));
      if (expected.some((index) => !names.has(index.name))) throw new Error("index_verification_failed");
      console.log("Four gallery file indexes are present in Atlas.");
    }
  } catch {
    console.error("Gallery index repair stopped. Existing records and indexes were not removed; check for duplicate IDs or an index definition conflict.");
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
