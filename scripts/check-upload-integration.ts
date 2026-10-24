import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { MongoClient, ObjectId } from "mongodb";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { cloudinaryUploadProvider } from "../src/lib/cloudinary/upload-provider";
import { proxyCiphertextRange, signedThumbnailUrl } from "../src/lib/cloudinary/ciphertext-access-core";
import { reserveUploadIntent } from "../src/lib/cloudinary/upload-intent";
import { openEncryptedContainer, prepareEncryptedFile, prepareEncryptedThumbnail, type MediaCategory } from "../src/lib/crypto/file-container";
import { encryptFileName } from "../src/lib/crypto/file-names";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { readDatabaseConfig } from "../src/lib/database/config";
import { getModelCollections } from "../src/lib/database/models";
import type { VaultFile } from "../src/lib/database/models";
import { mongoUploadStore } from "../src/lib/database/upload-lifecycle-store";
import { completeUpload } from "../src/lib/uploads/lifecycle";
import { transferCiphertext } from "../src/lib/uploads/transfer";

async function main() {
  if (!process.argv.includes("--live")) { console.error("Run with --live for disposable Atlas and Cloudinary tests."); process.exitCode = 2; return; }
  loadEnvConfig(process.cwd());
  let client: MongoClient | undefined;
  let databaseName = "";
  let cleanupFailed = false;
  let stage = "configuration";
  try {
    const database = readDatabaseConfig();
    const cloud = readCloudinaryConfig();
    client = new MongoClient(database.uri, { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
    databaseName = `vaultx_upload_check_${randomBytes(8).toString("hex")}`;
    if (!/^vaultx_upload_check_[a-f0-9]{16}$/.test(databaseName)) throw new Error("Invalid isolated database name");
    const db = client.db(databaseName);
    for (const name of ["owners", "vaultKeys", "folders", "files", "uploadJobs"]) await db.createCollection(name);
    await db.collection("owners").createIndex({ singletonKey: 1 }, { unique: true });
    await db.collection("uploadJobs").createIndex({ "cloudAssets.publicId": 1 }, { unique: true });
    cloudinary.config({ cloud_name: cloud.cloudName, api_key: cloud.apiKey, api_secret: cloud.apiSecret, secure: true });
    const provider = cloudinaryUploadProvider(cloudinary);
    const ownerId = new ObjectId();
    const vaultId = randomBytes(16).toString("base64url");
    installVaultRootKey(new Uint8Array(randomBytes(32)), vaultId);
    await getModelCollections(db).owners.insertOne({ _id: ownerId, singletonKey: "vaultx-owner", folderTreeRevision: 0,
      username: "synthetic", passwordHash: "$argon2id$v=19$m=65536,p=1,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      initializedAt: new Date(), settings: { autoLockMinutes: 5, requireLockOnOpen: true } });
    // Only the vault ID is read by reservation; the disposable record is never
    // used to unlock a browser or hold a real owner's key material.
    await db.collection("vaultKeys").insertOne({ ownerId, vaultId });
    const store = mongoUploadStore(db);
    for (const category of ["image", "video", "other"] as MediaCategory[]) {
      stage = `${category} prepare`;
      const extension = category === "image" ? "webp" : category === "video" ? "mp4" : "bin";
      const mimeType = category === "image" ? "image/webp" : category === "video" ? "video/mp4" : "application/octet-stream";
      const metadata = { storedName: `synthetic.${extension}`, extension, mimeType };
      const prepared = await prepareEncryptedFile(new Blob([randomBytes(2_048)]), metadata, category);
      const thumbPlain = category === "image" || category === "video" ? randomBytes(256) : undefined;
      const thumb = thumbPlain
        ? await prepareEncryptedThumbnail(new Blob([thumbPlain]),
          { storedName: "preview.webp", extension: "webp", mimeType: "image/webp" }, prepared.manifest) : undefined;
      const chunks: Uint8Array[] = [];
      for await (const chunk of prepared.chunks()) chunks.push(chunk);
      const ciphertext = Uint8Array.from(Buffer.concat(chunks));
      const job = await reserveUploadIntent(db, ownerId, { category, folderId: null, manifest: prepared.manifest,
        ...(thumb ? { thumbnailManifest: thumb.manifest } : {}) });
      try {
        stage = `${category} transfer`;
        const request = new Request("http://localhost", { method: "PUT", headers: {
          "content-type": "application/octet-stream", "content-length": String(ciphertext.length) },
          body: new Blob([ciphertext]) });
        if (await transferCiphertext(store, provider, ownerId, job._id, request) !== "transferred") throw new Error("Transfer not confirmed");
        if (thumb) {
          stage = `${category} private preview transfer`;
          const thumbnailChunks: Uint8Array[] = [];
          for await (const chunk of thumb.chunks()) thumbnailChunks.push(chunk);
          const thumbnailBytes = Uint8Array.from(Buffer.concat(thumbnailChunks));
          const thumbnailRequest = new Request("http://localhost", { method: "PUT", headers: {
            "content-type": "application/octet-stream", "content-length": String(thumbnailBytes.length) },
            body: new Blob([thumbnailBytes]) });
          if (await transferCiphertext(store, provider, ownerId, job._id, thumbnailRequest, new Date(), 1) !== "transferred") {
            throw new Error("Private preview transfer not confirmed");
          }
          thumbnailBytes.fill(0);
        }
        stage = `${category} completion`;
        const completion = { nameEncrypted: await encryptFileName(job.fileId.toHexString(), metadata.storedName),
          sourceNameEncrypted: await encryptFileName(job.fileId.toHexString(), `original.${extension}`), extension, mimeType,
          ...(category === "image" ? { width: 2, height: 2 } : {}),
          ...(category === "video" ? { width: 2, height: 2, durationSeconds: 1 } : {}) };
        const done = await completeUpload(store, provider, ownerId, job._id, completion);
        const ready = await getModelCollections(db).files.findOne({ _id: job.fileId, ownerId, status: "ready" });
        if (done.status !== "completed" || !ready || ready.storedSizeBytes !== ciphertext.length
          || (thumb && (!ready.thumbnail || ready.thumbnail.storedSizeBytes !== Number(thumb.manifest.objectBytes)))
          || await getModelCollections(db).files.countDocuments({ _id: job.fileId, ownerId }) !== 1) {
          throw new Error("Ready record not confirmed");
        }
        if (thumb && thumbPlain && ready.thumbnail) {
          stage = `${category} restricted preview retrieval`;
          const anonymousUrl = cloudinary.url(ready.thumbnail.cloudinary.publicId,
            { resource_type: "raw", type: "authenticated", secure: true });
          const anonymous = await fetch(anonymousUrl, { cache: "no-store", redirect: "error" });
          await anonymous.body?.cancel();
          if (anonymous.ok) throw new Error("Anonymous preview delivery was permitted");
          const thumbnailFile = { ...ready, storedSizeBytes: ready.thumbnail.storedSizeBytes } as VaultFile;
          const source = { size: BigInt(ready.thumbnail.storedSizeBytes), async read(start: bigint, end: bigint) {
            const response = await proxyCiphertextRange({ file: thumbnailFile,
              range: `bytes=${start}-${end - BigInt(1)}`,
              makeUrl: () => signedThumbnailUrl(cloudinary, ready) });
            return new Uint8Array(await response.arrayBuffer());
          } };
          const opened = await openEncryptedContainer(source, ready.thumbnail.encryptionManifest);
          try {
            const decoded: Uint8Array[] = [];
            for await (const chunk of opened.chunks()) decoded.push(chunk);
            if (!Buffer.concat(decoded).equals(thumbPlain)) throw new Error("Private preview did not decrypt exactly");
            for (const chunk of decoded) chunk.fill(0);
          } finally { opened.close(); }
        }
        console.log(`${category}: encrypted transfer${thumb ? ", private preview" : ""}, Cloudinary verification and Atlas ready commit PASS`);
      } finally {
        stage = `${category} cleanup`;
        try {
          for (const planned of job.cloudAssets) {
            if (await provider.lookup(planned)) {
              await provider.destroy(planned);
              if (await provider.lookup(planned)) throw new Error("Remote cleanup unconfirmed");
            }
          }
        } catch { cleanupFailed = true; throw new Error("Synthetic cleanup failed"); }
      }
    }
  } catch {
    console.error(`Live isolated upload integration failed at ${stage}. No secret or object ID is printed.`);
    process.exitCode = 1;
  } finally {
    clearVaultKeyMaterial();
    if (client) {
      try {
        if (databaseName && !cleanupFailed && /^vaultx_upload_check_[a-f0-9]{16}$/.test(databaseName)) {
          await client.db(databaseName).dropDatabase();
          console.log("Disposable Atlas database removed.");
        } else if (cleanupFailed) console.error(`Cleanup needs review in isolated database ${databaseName}.`);
      } catch { console.error(`Disposable database cleanup failed: ${databaseName}.`); process.exitCode = 1; }
      await client.close();
    }
  }
}

void main();
