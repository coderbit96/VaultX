import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { MongoClient, MongoServerError, ObjectId } from "mongodb";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryDeletionProvider } from "../src/lib/cloudinary/deletion-provider";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { readDatabaseConfig } from "../src/lib/database/config";
import { queueFolderDeletion, mongoFolderDeletionStore } from "../src/lib/database/folder-deletions";
import { getModelCollections } from "../src/lib/database/models";
import { processFolderDeletion } from "../src/lib/deletions/folder-deletion";

type TestAsset = { publicId: string; assetId?: string; resourceType: "raw"; deliveryType: "authenticated"; format: "dat"; cleanupCompleted: false };

async function uploadSynthetic(publicId: string): Promise<TestAsset> {
  const body = randomBytes(512); // Disposable synthetic ciphertext-like bytes only.
  const result = await new Promise<{ asset_id?: string; public_id?: string; resource_type?: string; type?: string; bytes?: number }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: "raw", type: "authenticated", public_id: publicId,
      overwrite: false, use_filename: false, unique_filename: false }, (error, response) => {
      if (error || !response) reject(new Error("synthetic_upload_failed"));
      else resolve(response);
    });
    stream.on("error", () => reject(new Error("synthetic_upload_failed")));
    stream.end(body);
  });
  if (!result.asset_id || result.public_id !== publicId || result.resource_type !== "raw"
    || result.type !== "authenticated" || result.bytes !== body.length) throw new Error("synthetic_upload_identity_mismatch");
  return { publicId, assetId: result.asset_id, resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) {
    console.error("Run with --live to test three disposable restricted Cloudinary objects and an isolated Atlas database.");
    process.exitCode = 2;
    return;
  }
  loadEnvConfig(process.cwd());
  let client: MongoClient | undefined;
  let collectionPrefix = "";
  let stage = "configuration";
  let cleanupOk = true;
  let connected = false;
  let collectionsTouched = false;
  const planned: TestAsset[] = [];
  try {
    const database = readDatabaseConfig();
    const cloud = readCloudinaryConfig();
    cloudinary.config({ cloud_name: cloud.cloudName, api_key: cloud.apiKey, api_secret: cloud.apiSecret, secure: true });
    stage = "Atlas connection";
    client = new MongoClient(database.uri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    connected = true;
    collectionPrefix = `vaultx_folder_cloud_check_${randomBytes(8).toString("hex")}_`;
    const physical = client.db(database.name);
    const db = new Proxy(physical, { get(target, property) {
      if (property === "collection") return (name: string) => target.collection(collectionPrefix + name);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const { owners, folders, files, deletionJobs } = getModelCollections(db);
    stage = "isolated index setup";
    collectionsTouched = true;
    await deletionJobs.createIndex({ targetType: 1, targetId: 1, ownerId: 1 }, { unique: true });
    const ownerId = new ObjectId(), rootId = new ObjectId(), childId = new ObjectId(), siblingId = new ObjectId();
    const targetId = new ObjectId(), siblingFileId = new ObjectId(), now = new Date();
    const nameEncrypted = { version: 1, vaultId: "a".repeat(22), salt: "b".repeat(43),
      ciphertext: "c".repeat(24), nonce: "d".repeat(16), algorithm: "AES-256-GCM" } as const;
    const manifest = (kind: "file" | "thumbnail") => ({ version: 1 as const, kind, vaultId: "a".repeat(22),
      header: "b".repeat(107), objectBytes: "512", wrappedKey: { version: 1 as const,
        revision: 1 as const, salt: "c".repeat(43), nonce: "d".repeat(16), ciphertext: "e".repeat(64) } });

    stage = "synthetic upload";
    for (const prefix of ["ciphertext", "thumbnails", "ciphertext"] as const) {
      const publicId = `vaultx/${prefix}/${randomBytes(24).toString("hex")}.dat`;
      // Record the opaque ID before upload, so even an uncertain response is cleaned up.
      const asset: TestAsset = { publicId, resourceType: "raw", deliveryType: "authenticated", format: "dat", cleanupCompleted: false };
      planned.push(asset);
      Object.assign(asset, await uploadSynthetic(publicId));
    }
    const [main, thumbnail, sibling] = planned;
    stage = "synthetic Atlas seed";
    await owners.insertOne({ _id: ownerId, singletonKey: "vaultx-owner", username: "synthetic",
      passwordHash: "$argon2id$v=19$m=65536,p=1,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      initializedAt: now, folderTreeRevision: 0, settings: { autoLockMinutes: 5, requireLockOnOpen: true } });
    await folders.insertMany([
      { _id: rootId, ownerId, parentFolderId: null, nameEncrypted, status: "active", createdAt: now, updatedAt: now },
      { _id: childId, ownerId, parentFolderId: rootId, nameEncrypted, status: "active", createdAt: now, updatedAt: now },
      { _id: siblingId, ownerId, parentFolderId: null, nameEncrypted, status: "active", createdAt: now, updatedAt: now },
    ]);
    const base = { ownerId, nameEncrypted, extension: "dat", category: "other" as const,
      mimeType: "application/octet-stream", encryptedFileKey: "a".repeat(32), storedSizeBytes: 512,
      encryptionManifest: manifest("file"), status: "ready" as const, createdAt: now, updatedAt: now };
    await files.insertMany([
      { ...base, _id: targetId, folderId: childId, cloudinary: main,
        thumbnail: { cloudinary: thumbnail, storedSizeBytes: 512, encryptionManifest: manifest("thumbnail") } },
      { ...base, _id: siblingFileId, folderId: siblingId, cloudinary: sibling },
    ]);

    stage = "queue and fence";
    const job = await queueFolderDeletion(db, ownerId, rootId);
    if (job.folderIds.length !== 2 || job.fileIds.length !== 1 || job.cloudAssets.length !== 2
      || await files.findOne({ _id: targetId, status: "ready" })) throw new Error("fence_or_inventory_failed");
    stage = "Cloudinary and Atlas deletion";
    const store = mongoFolderDeletionStore(db), provider = cloudinaryDeletionProvider(cloudinary);
    let result = job;
    for (let attempt = 0; attempt < 8 && result.status !== "completed"; attempt++) {
      result = await processFolderDeletion(store, provider, ownerId, job._id, new Date(), true);
      if (result.status === "failed") throw new Error("deletion_failed");
      if (result.status !== "completed") await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const uploads = cloudinaryUploadProvider(cloudinary);
    if (result.status !== "completed" || await uploads.lookup(main) || await uploads.lookup(thumbnail)
      || !await uploads.lookup(sibling) || await files.findOne({ _id: targetId })
      || await folders.findOne({ _id: rootId }) || await folders.findOne({ _id: childId })
      || !await files.findOne({ _id: siblingFileId, status: "ready" })
      || !await folders.findOne({ _id: siblingId, status: "active" })) throw new Error("final_state_mismatch");
    if (!(await queueFolderDeletion(db, ownerId, rootId))._id.equals(job._id)) throw new Error("repeat_job_mismatch");
    console.log("Live restricted Cloudinary main/thumbnail deletion, nested Atlas removal, repeat request, and sibling preservation PASS.");
  } catch (error) {
    const category = error instanceof MongoServerError ? `Mongo code ${error.code}`
      : error instanceof Error ? error.name : "unknown";
    console.error(`Live recursive folder deletion check failed at ${stage} (${category}). No provider ID or secret was printed.`);
    process.exitCode = 1;
  } finally {
    if (client) {
      const uploads = cloudinaryUploadProvider(cloudinary);
      for (const asset of planned) {
        try {
          if (await uploads.lookup(asset)) {
            await uploads.destroy(asset);
            if (await uploads.lookup(asset)) throw new Error("cleanup_unconfirmed");
          }
        } catch { cleanupOk = false; process.exitCode = 1; }
      }
      if (cleanupOk && connected && collectionsTouched && /^vaultx_folder_cloud_check_[a-f0-9]{16}_$/.test(collectionPrefix)) {
        try {
          const physical = client.db(readDatabaseConfig().name);
          for (const name of ["owners", "folders", "files", "uploadJobs", "deletionJobs"]) {
            await physical.collection(collectionPrefix + name).drop().catch((error: unknown) => {
              if (!(error instanceof MongoServerError && error.code === 26)) throw error;
            });
          }
          console.log("Disposable Cloudinary objects and Atlas collections removed.");
        } catch { cleanupOk = false; process.exitCode = 1; }
      }
      if (!cleanupOk) console.error(`Synthetic cleanup needs review in isolated collections ${collectionPrefix || "not created"}.`);
      await client.close();
    }
  }
}

void main();
