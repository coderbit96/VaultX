import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { MongoClient, ObjectId } from "mongodb";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryDeletionProvider } from "../src/lib/cloudinary/deletion-provider";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { reserveUploadIntent } from "../src/lib/cloudinary/upload-intent";
import { prepareEncryptedFile, prepareEncryptedThumbnail } from "../src/lib/crypto/file-container";
import { encryptFileName } from "../src/lib/crypto/file-names";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { readDatabaseConfig } from "../src/lib/database/config";
import { mongoDeletionStore, queueFileDeletion } from "../src/lib/database/file-deletions";
import { getModelCollections } from "../src/lib/database/models";
import type { UploadJob } from "../src/lib/database/models";
import { mongoUploadStore } from "../src/lib/database/upload-lifecycle-store";
import { processFileDeletion } from "../src/lib/deletions/file-deletion";
import { completeUpload } from "../src/lib/uploads/lifecycle";
import { transferCiphertext } from "../src/lib/uploads/transfer";

async function main() {
  if (!process.argv.includes("--live")) { console.error("Run with --live for one disposable encrypted Cloudinary object and isolated Atlas database."); process.exitCode = 2; return; }
  loadEnvConfig(process.cwd());
  let client: MongoClient | undefined;
  let databaseName = "";
  let confirmedRemoteAbsent = false;
  let stage = "configuration";
  let planned: UploadJob["cloudAssets"] = [];
  try {
    const database = readDatabaseConfig();
    const cloud = readCloudinaryConfig();
    client = new MongoClient(database.uri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    databaseName = `vaultx_deletion_check_${randomBytes(8).toString("hex")}`;
    const db = client.db(databaseName);
    for (const name of ["owners", "vaultKeys", "folders", "files", "uploadJobs", "deletionJobs"]) await db.createCollection(name);
    await db.collection("owners").createIndex({ singletonKey: 1 }, { unique: true });
    await db.collection("deletionJobs").createIndex({ targetType: 1, targetId: 1, ownerId: 1 }, { unique: true });
    cloudinary.config({ cloud_name: cloud.cloudName, api_key: cloud.apiKey, api_secret: cloud.apiSecret, secure: true });
    const uploads = cloudinaryUploadProvider(cloudinary);
    const deletions = cloudinaryDeletionProvider(cloudinary);
    const ownerId = new ObjectId();
    const vaultId = randomBytes(16).toString("base64url");
    installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
    await getModelCollections(db).owners.insertOne({ _id: ownerId, singletonKey: "vaultx-owner", folderTreeRevision: 0,
      username: "synthetic", passwordHash: "$argon2id$v=19$m=65536,p=1,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      initializedAt: new Date(), settings: { autoLockMinutes: 5, requireLockOnOpen: true } });
    await db.collection("vaultKeys").insertOne({ ownerId, vaultId });
    stage = "prepare";
    const metadata = { storedName: "synthetic.webp", extension: "webp", mimeType: "image/webp" };
    const prepared = await prepareEncryptedFile(new Blob([randomBytes(2_048)]), metadata, "image");
    const thumbnail = await prepareEncryptedThumbnail(new Blob([randomBytes(256)]),
      { storedName: "preview.webp", extension: "webp", mimeType: "image/webp" }, prepared.manifest);
    const chunks: Uint8Array[] = [];
    for await (const chunk of prepared.chunks()) chunks.push(chunk);
    const ciphertext = Uint8Array.from(Buffer.concat(chunks));
    const upload = await reserveUploadIntent(db, ownerId, { category: "image", folderId: null,
      manifest: prepared.manifest, thumbnailManifest: thumbnail.manifest });
    planned = upload.cloudAssets;
    stage = "upload";
    const request = new Request("http://localhost", { method: "PUT", headers: {
      "content-type": "application/octet-stream", "content-length": String(ciphertext.length) }, body: new Blob([ciphertext]) });
    if (await transferCiphertext(mongoUploadStore(db), uploads, ownerId, upload._id, request) !== "transferred") throw new Error("Transfer not confirmed");
    const thumbChunks: Uint8Array[] = [];
    for await (const chunk of thumbnail.chunks()) thumbChunks.push(chunk);
    const thumbBytes = Uint8Array.from(Buffer.concat(thumbChunks));
    const thumbRequest = new Request("http://localhost", { method: "PUT", headers: {
      "content-type": "application/octet-stream", "content-length": String(thumbBytes.length) }, body: new Blob([thumbBytes]) });
    if (await transferCiphertext(mongoUploadStore(db), uploads, ownerId, upload._id, thumbRequest, new Date(), 1) !== "transferred") {
      throw new Error("Preview transfer not confirmed");
    }
    stage = "completion";
    const completion = { nameEncrypted: await encryptFileName(upload.fileId.toHexString(), metadata.storedName),
      extension: metadata.extension, mimeType: metadata.mimeType, width: 2, height: 2 };
    await completeUpload(mongoUploadStore(db), uploads, ownerId, upload._id, completion);
    stage = "queue";
    const queued = await queueFileDeletion(db, ownerId, upload.fileId);
    const fenced = await getModelCollections(db).files.findOne({ _id: upload.fileId, ownerId });
    if (fenced?.status !== "deleting" || queued.cloudAssets.length !== 2) throw new Error("Deletion fence or inventory missing");
    stage = "remote and metadata removal";
    let done = await processFileDeletion(mongoDeletionStore(db), deletions, ownerId, queued._id);
    if (done.status === "retrying") {
      // Cloudinary Admin reads may briefly lag the destroy acknowledgement.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      done = await processFileDeletion(mongoDeletionStore(db), deletions, ownerId, queued._id, new Date(), true);
    }
    if (done.status !== "completed" || await getModelCollections(db).files.findOne({ _id: upload.fileId, ownerId })) {
      throw new Error("Deletion did not complete");
    }
    for (const asset of planned) if (await uploads.lookup(asset)) throw new Error("Cloudinary object still present");
    confirmedRemoteAbsent = true;
    const repeat = await queueFileDeletion(db, ownerId, upload.fileId);
    if (!repeat._id.equals(queued._id) || (await processFileDeletion(mongoDeletionStore(db), deletions, ownerId, queued._id)).status !== "completed") {
      throw new Error("Repeated deletion was not idempotent");
    }
    console.log("Synthetic encrypted photo and preview, durable fence, both Cloudinary deletions, Atlas removal, and repeat request PASS.");
  } catch {
    console.error(`Live deletion check failed at ${stage}. No secret or object ID is printed.`);
    process.exitCode = 1;
  } finally {
    clearVaultKeyMaterial();
    if (client) {
      try {
        if (!confirmedRemoteAbsent && planned.length) {
          const uploads = cloudinaryUploadProvider(cloudinary);
          for (const asset of planned) {
            if (await uploads.lookup(asset)) {
              await uploads.destroy(asset);
              if (await uploads.lookup(asset)) throw new Error("Cleanup unconfirmed");
            }
          }
          confirmedRemoteAbsent = true;
        }
      } catch { process.exitCode = 1; console.error("Synthetic remote cleanup unconfirmed; isolated Atlas job retained for review."); }
      try {
        if ((!planned.length || confirmedRemoteAbsent) && /^vaultx_deletion_check_[a-f0-9]{16}$/.test(databaseName)) {
          await client.db(databaseName).dropDatabase();
          console.log("Disposable Atlas database removed.");
        } else console.error(`Isolated database retained for cleanup review: ${databaseName}.`);
      } catch { process.exitCode = 1; console.error(`Disposable database cleanup failed: ${databaseName}.`); }
      await client.close();
    }
  }
}

void main();
