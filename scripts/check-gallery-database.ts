import { loadEnvConfig } from "@next/env";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { getGalleryConnection } from "../src/lib/database/gallery-connection";
import { countGalleryMedia, listGalleryAlbums, listGalleryMedia } from "../src/lib/database/gallery-metadata";

async function main() {
  loadEnvConfig(process.cwd());
  try {
    const db = await getDatabase();
    const connection = await getGalleryConnection();
    if (connection.getClient() !== db.client || connection.name !== db.databaseName) throw new Error("Pool mismatch");
    const owner = await db.collection("owners").findOne({ singletonKey: "vaultx-owner" }, { projection: { _id: 1 } });
    if (!owner) { console.log("Gallery database connection OK; no owner initialized."); return; }
    await listGalleryMedia(db, owner._id, { limit: 1 });
    await listGalleryMedia(db, owner._id, { limit: 1, sort: "oldest" });
    await listGalleryMedia(db, owner._id, { limit: 1, sort: "size" });
    await countGalleryMedia(db, owner._id);
    await listGalleryAlbums(db, owner._id, { parentId: null, limit: 1 });
    console.log("Gallery database connection and read-only queries OK; existing MongoDB pool reused.");
  } catch {
    console.error("Gallery database check failed. Check Atlas access, model compatibility, and indexes.");
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
