import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db, type IndexDescription } from "mongodb";
import {
  assertFileFolder,
  assertFolderParent,
  assertJobFile,
  deletionJobSchema,
  deviceCredentialSchema,
  fileSchema,
  folderSchema,
  ownerSchema,
  sessionSchema,
  uploadJobSchema,
} from "../src/lib/database/models";
import { ensureModelIndexes, modelIndexes } from "../src/lib/database/model-indexes";

const ownerId = new ObjectId();
const otherOwnerId = new ObjectId();
const fileId = new ObjectId();
const folderId = new ObjectId();
const now = new Date("2026-01-01T00:00:00Z");
const later = new Date("2026-01-02T00:00:00Z");
const encrypted = { version: 1, vaultId: "a".repeat(22), salt: "b".repeat(43), ciphertext: "c".repeat(24), nonce: "d".repeat(16), algorithm: "AES-256-GCM" } as const;
const asset = { publicId: "vaultx/opaque", resourceType: "raw", deliveryType: "authenticated" } as const;

const folder = {
  _id: folderId, ownerId, parentFolderId: null, nameEncrypted: encrypted,
  status: "active", createdAt: now, updatedAt: now,
} as const;
const file = {
  _id: fileId, ownerId, folderId, nameEncrypted: encrypted, extension: "jpg",
  category: "image", mimeType: "image/jpeg", storedSizeBytes: 999_999,
  cloudinary: asset, encryptedFileKey: "c".repeat(32),
  encryptionManifest: { version: 1, algorithm: "AES-256-GCM", chunkCount: 1, chunkSizeBytes: 999_999 },
  status: "ready", createdAt: now, updatedAt: now,
} as const;

test("owner is single-owner shaped and rejects secret material", () => {
  const valid = {
    _id: ownerId, singletonKey: "vaultx-owner", username: "owner",
    passwordHash: "$argon2id$v=19$m=65536,p=1,t=3$" + "a".repeat(22) + "$" + "b".repeat(43), initializedAt: now,
    settings: { autoLockMinutes: 15, requireLockOnOpen: true },
  };
  assert.equal(ownerSchema.safeParse(valid).success, true);
  assert.equal(ownerSchema.safeParse({ ...valid, singletonKey: "second-owner" }).success, false);
  assert.equal(ownerSchema.safeParse({ ...valid, recoveryKey: "plaintext" }).success, false);
});

test("encrypted names are required and plaintext fields are rejected", () => {
  assert.equal(folderSchema.safeParse(folder).success, true);
  assert.equal(folderSchema.safeParse({ ...folder, name: "Holiday" }).success, false);
  assert.equal(folderSchema.safeParse({ ...folder, nameEncrypted: "Holiday" }).success, false);
  assert.equal(folderSchema.safeParse({ ...folder, parentFolderId: folderId }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, fileContent: "plain bytes" }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, encryptedFileKey: "raw key" }).success, false);
});

test("ready files need object identity and must meet ciphertext byte limits", () => {
  assert.equal(fileSchema.safeParse(file).success, true);
  assert.equal(fileSchema.safeParse({ ...file, cloudinary: undefined }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, storedSizeBytes: 1_000_000 }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, status: "published" }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, category: "video", storedSizeBytes: 100_000_000 }).success, false);
});

test("upload inventory retains exact object identity without plaintext", () => {
  const job = {
    _id: new ObjectId(), ownerId, fileId, status: "retrying", attempts: 1,
    cloudAssets: [{ ...asset, cleanupCompleted: false }], createdAt: now, updatedAt: later,
  };
  assert.equal(uploadJobSchema.safeParse(job).success, true);
  assert.equal(uploadJobSchema.safeParse({ ...job, cloudAssets: [...job.cloudAssets, ...job.cloudAssets] }).success, false);
  assert.equal(uploadJobSchema.safeParse({ ...job, rawFilename: "holiday.jpg" }).success, false);
});

test("deletion cannot advance without a complete inventory and remote confirmation", () => {
  const job = {
    _id: new ObjectId(), ownerId, targetType: "file", targetId: fileId,
    fileIds: [fileId], folderIds: [], inventoryComplete: true,
    cloudAssets: [{ ...asset, fileId, completed: false }],
    phase: "deleting", status: "running", attempts: 1, leaseToken: "a".repeat(32), leaseExpiresAt: later,
    createdAt: now, updatedAt: later,
  };
  assert.equal(deletionJobSchema.safeParse(job).success, true);
  assert.equal(deletionJobSchema.safeParse({ ...job, inventoryComplete: false }).success, false);
  assert.equal(deletionJobSchema.safeParse({ ...job, phase: "completed", status: "completed" }).success, false);
  assert.equal(deletionJobSchema.safeParse({ ...job, cloudAssets: [{ ...asset, fileId: new ObjectId(), completed: false }] }).success, false);
  assert.equal(deletionJobSchema.safeParse({ ...job, fileIds: [new ObjectId()] }).success, false);
  assert.equal(deletionJobSchema.safeParse({ ...job, cloudAssets: [{ ...asset, fileId, completed: true }], phase: "completed", status: "completed", leaseToken: undefined, leaseExpiresAt: undefined }).success, true);
});

test("folder deletion snapshots include the target and have no duplicate descendants", () => {
  const childId = new ObjectId();
  const job = {
    _id: new ObjectId(), ownerId, targetType: "folder", targetId: folderId,
    fileIds: [fileId], folderIds: [folderId, childId], inventoryComplete: true,
    cloudAssets: [{ ...asset, fileId, completed: false }],
    phase: "deleting", status: "running", attempts: 0, leaseToken: "a".repeat(32), leaseExpiresAt: later,
    createdAt: now, updatedAt: now,
  };
  assert.equal(deletionJobSchema.safeParse(job).success, true);
  assert.equal(deletionJobSchema.safeParse({ ...job, folderIds: [childId] }).success, false);
  assert.equal(deletionJobSchema.safeParse({ ...job, folderIds: [folderId, folderId] }).success, false);
});

test("session tokens are digests and credentials contain public metadata only", () => {
  const session = {
    _id: new ObjectId(), ownerId, tokenDigest: "a".repeat(64),
    createdAt: now, lastSeenAt: now, idleExpiresAt: later, expiresAt: later,
  };
  assert.equal(sessionSchema.safeParse(session).success, true);
  assert.equal(sessionSchema.safeParse({ ...session, lockedAt: now }).success, true);
  assert.equal(sessionSchema.safeParse({ ...session, token: "raw token" }).success, false);
  assert.equal(sessionSchema.safeParse({ ...session, expiresAt: now }).success, false);
  const credential = {
    _id: new ObjectId(), ownerId, credentialId: "a".repeat(32),
    publicKey: "b".repeat(32), signCount: 0, transports: ["internal"], createdAt: now,
  };
  assert.equal(deviceCredentialSchema.safeParse(credential).success, true);
  assert.equal(deviceCredentialSchema.safeParse({ ...credential, biometricTemplate: "secret" }).success, false);
});

test("owner relationships reject cross-owner and mismatched references", () => {
  const parsedFolder = folderSchema.parse(folder);
  const parsedFile = fileSchema.parse(file);
  assert.doesNotThrow(() => assertFileFolder(parsedFile, parsedFolder));
  assert.throws(() => assertFileFolder(parsedFile, { ...parsedFolder, ownerId: otherOwnerId }));
  assert.throws(() => assertFileFolder({ ...parsedFile, folderId: new ObjectId() }, parsedFolder));
  const child = folderSchema.parse({ ...folder, _id: new ObjectId(), parentFolderId: folderId });
  assert.doesNotThrow(() => assertFolderParent(child, parsedFolder));
  assert.throws(() => assertFolderParent(child, { ...parsedFolder, ownerId: otherOwnerId }));
  const job = uploadJobSchema.parse({ _id: new ObjectId(), ownerId, fileId, status: "pending", attempts: 0, cloudAssets: [], createdAt: now, updatedAt: now });
  assert.doesNotThrow(() => assertJobFile(job, parsedFile));
  assert.throws(() => assertJobFile(job, { ...parsedFile, ownerId: otherOwnerId }));
});

test("index setup includes PRD indexes, uniqueness, and no plaintext name index", async () => {
  const calls: { collection: string; indexes: IndexDescription[] }[] = [];
  const db = {
    collection(name: string) {
      return { createIndexes: async (indexes: IndexDescription[]) => { calls.push({ collection: name, indexes }); return []; } };
    },
  } as unknown as Db;
  await ensureModelIndexes(db);
  assert.equal(calls.length, 11);
  assert.deepEqual(modelIndexes.folders[0].key, { ownerId: 1, parentFolderId: 1, status: 1 });
  assert.deepEqual(modelIndexes.folders[1].key, { ownerId: 1, parentFolderId: 1, status: 1, _id: 1 });
  assert.deepEqual(modelIndexes.files[0].key, { ownerId: 1, folderId: 1, status: 1 });
  assert.deepEqual(modelIndexes.files.find((index) => index.name === "owner_category_created")?.key, { ownerId: 1, category: 1, createdAt: -1 });
  assert.deepEqual(modelIndexes.deletionJobs[0].key, { status: 1, nextAttemptAt: 1 });
  assert.equal(modelIndexes.owners[0].unique, true);
  assert.equal(modelIndexes.owners[1].unique, true);
  assert.equal(modelIndexes.sessions[2].expireAfterSeconds, 0);
  assert.equal(JSON.stringify(modelIndexes).includes("nameEncrypted"), false);
});
