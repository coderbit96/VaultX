import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { MongoClient, MongoServerError, ObjectId } from "mongodb";
import { readDatabaseConfig } from "../src/lib/database/config";
import { getModelCollections } from "../src/lib/database/models";
import { changeFolder } from "../src/lib/database/folders";
import { queueFolderDeletion, mongoFolderDeletionStore } from "../src/lib/database/folder-deletions";
import { processFolderDeletion } from "../src/lib/deletions/folder-deletion";

async function main() {
  if (!process.argv.includes("--live")) { console.error("Run with --live for an isolated synthetic Atlas folder test."); process.exitCode = 2; return; }
  loadEnvConfig(process.cwd());
  let client: MongoClient | undefined;
  let collectionPrefix = "";
  let stage = "configuration";
  try {
    const config = readDatabaseConfig();
    client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    collectionPrefix = `vaultx_folder_deletion_check_${randomBytes(8).toString("hex")}_`;
    const physical = client.db(config.name);
    const db = new Proxy(physical, { get(target, property) {
      if (property === "collection") return (name: string) => target.collection(collectionPrefix + name);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const { owners, folders, files, deletionJobs } = getModelCollections(db);
    stage = "index setup";
    await deletionJobs.createIndex({ targetType: 1, targetId: 1, ownerId: 1 }, { unique: true });
    const ownerId = new ObjectId(), root = new ObjectId(), sibling = new ObjectId();
    const now = new Date();
    const nameEncrypted = { version: 1, vaultId: "a".repeat(22), salt: "b".repeat(43),
      ciphertext: "c".repeat(24), nonce: "d".repeat(16), algorithm: "AES-256-GCM" } as const;
    stage = "synthetic seed";
    await owners.insertOne({ _id: ownerId, singletonKey: "vaultx-owner", username: "synthetic",
      passwordHash: "$argon2id$v=19$m=65536,p=1,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      initializedAt: now, folderTreeRevision: 0, settings: { autoLockMinutes: 5, requireLockOnOpen: true } });
    await folders.insertMany([{ _id: root, ownerId, parentFolderId: null, nameEncrypted, status: "active", createdAt: now, updatedAt: now },
      { _id: sibling, ownerId, parentFolderId: null, nameEncrypted, status: "active", createdAt: now, updatedAt: now }]);
    let parent = root;
    const depth = 70;
    for (let n = 0; n < depth; n++) {
      const id = new ObjectId();
      await folders.insertOne({ _id: id, ownerId, parentFolderId: parent, nameEncrypted, status: "active", createdAt: now, updatedAt: now });
      parent = id;
    }
    const targetFileId = new ObjectId(), siblingFileId = new ObjectId();
    const publicId = (letter: string, kind: "ciphertext" | "thumbnails" = "ciphertext") =>
      `vaultx/${kind}/${letter.repeat(48)}.dat`;
    const identity = (letter: string, kind?: "ciphertext" | "thumbnails") => ({ publicId: publicId(letter, kind),
      assetId: `synthetic-${letter}`, resourceType: "raw" as const, deliveryType: "authenticated" as const, format: "dat" });
    const manifest = { version: 1 as const, kind: "file" as const, vaultId: "a".repeat(22),
      header: "b".repeat(107), objectBytes: "500", wrappedKey: { version: 1 as const,
        revision: 1 as const, salt: "c".repeat(43), nonce: "d".repeat(16), ciphertext: "e".repeat(64) } };
    await files.insertMany([{ _id: targetFileId, ownerId, folderId: parent, nameEncrypted, extension: "dat",
      category: "other", mimeType: "application/octet-stream", encryptedFileKey: "a".repeat(32),
      storedSizeBytes: 500, cloudinary: identity("a"), encryptionManifest: manifest,
      thumbnail: { cloudinary: identity("b", "thumbnails"), storedSizeBytes: 100, encryptionManifest: { ...manifest, kind: "thumbnail" } },
      status: "ready", createdAt: now, updatedAt: now },
    { _id: siblingFileId, ownerId, folderId: sibling, nameEncrypted, extension: "dat",
      category: "other", mimeType: "application/octet-stream", encryptedFileKey: "a".repeat(32),
      storedSizeBytes: 500, cloudinary: identity("c"), encryptionManifest: manifest,
      status: "ready", createdAt: now, updatedAt: now }]);
    stage = "queue and fence";
    const queued = await queueFolderDeletion(db, ownerId, root);
    if (queued.folderIds.length !== depth + 1 || queued.fileIds.length !== 1 || queued.cloudAssets.length !== 2
      || queued.cloudAssets.some((asset) => asset.fileId.equals(siblingFileId))) throw new Error("Wrong inventory");
    if (await files.findOne({ _id: targetFileId, status: "ready" })) throw new Error("Target read fence missing");
    if (!await files.findOne({ _id: siblingFileId, status: "ready" })) throw new Error("Sibling was touched");
    await changeFolder(db, ownerId, sibling, { parentFolderId: root }).then(
      () => { throw new Error("Move into deleting subtree succeeded"); }, () => undefined);
    stage = "batched remote and metadata removal";
    const remote = new Set([publicId("a"), publicId("b", "thumbnails"), publicId("c")]);
    const removed: string[] = [];
    const provider = { remove: async (asset: { publicId: string }) => {
      if (!remote.has(asset.publicId)) return;
      remote.delete(asset.publicId); removed.push(asset.publicId);
    } };
    const store = mongoFolderDeletionStore(db);
    let result = queued;
    for (let n = 0; n < 10 && result.status !== "completed"; n++) {
      result = await processFolderDeletion(store, provider, ownerId, queued._id);
      if (result.status === "retrying" || result.status === "failed") throw new Error("Job paused unexpectedly");
    }
    if (result.status !== "completed" || removed.length !== 2 || !remote.has(publicId("c"))
      || await files.findOne({ _id: targetFileId }) || await folders.findOne({ _id: root })
      || !await files.findOne({ _id: siblingFileId }) || !await folders.findOne({ _id: sibling })) {
      throw new Error("Deletion or sibling verification failed");
    }
    if (!(await queueFolderDeletion(db, ownerId, root))._id.equals(queued._id)) throw new Error("Repeat request changed job");
    console.log("Isolated Atlas deep-tree fence, bottom-up deletion, retry-safe job, and sibling preservation PASS.");
  } catch (error) {
    console.error(`Folder deletion check failed at ${stage}${error instanceof MongoServerError ? ` (Mongo code ${error.code})` : error instanceof Error ? ` (${error.name})` : ""}; no personal data or object ID was printed.`);
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        if (/^vaultx_folder_deletion_check_[a-f0-9]{16}_$/.test(collectionPrefix)) {
          const physical = client.db(readDatabaseConfig().name);
          for (const name of ["owners", "folders", "files", "uploadJobs", "deletionJobs"]) {
            await physical.collection(collectionPrefix + name).drop().catch((error: unknown) => {
              if (!(error instanceof MongoServerError && error.code === 26)) throw error;
            });
          }
          console.log("Disposable Atlas collections removed.");
        }
      } catch (error) { console.error(`Disposable Atlas collection cleanup failed${error instanceof MongoServerError ? ` (Mongo code ${error.code})` : ""}; inspect isolated test collections.`); process.exitCode = 1; }
      await client.close();
    }
  }
}

void main();
