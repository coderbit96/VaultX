import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { encryptFileName, decryptFileName, newFileId } from "../src/lib/crypto/file-names";
import { encryptFolderName } from "../src/lib/crypto/folder-names";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { fileSchema, type VaultFile } from "../src/lib/database/models";
import { findOwnedReadyCiphertextFile, findReadyFileAccessMetadata, findReadyFileDetails, listReadyFiles, parseFileCursor, publicFileMetadata } from "../src/lib/database/files";
import { modelIndexes } from "../src/lib/database/model-indexes";

const owner = new ObjectId();
const foreign = new ObjectId();
const vaultId = Buffer.from(randomBytes(16)).toString("base64url");
const key = new Uint8Array(randomBytes(32));

async function record(index: number, options: Partial<VaultFile> = {}): Promise<VaultFile> {
  const id = new ObjectId();
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
  return fileSchema.parse({ _id: id, ownerId: owner, folderId: null,
    nameEncrypted: await encryptFileName(id.toHexString(), `private-${index}.jpg`),
    extension: "jpg", category: "image", mimeType: "image/jpeg", storedSizeBytes: 12_345,
    cloudinary: { publicId: `dummy-test-only-${index}`, resourceType: "raw", deliveryType: "authenticated" },
    encryptedFileKey: "A".repeat(16), encryptionManifest: { version: 1, algorithm: "AES-256-GCM", chunkCount: 1, chunkSizeBytes: 64 },
    status: "ready", createdAt: date, updatedAt: date, ...options });
}

function fakeDatabase(records: VaultFile[], folders: { _id: ObjectId; ownerId: ObjectId; status: string; parentFolderId: ObjectId | null }[] = []): Db {
  return { collection(name: string) {
    if (name === "folders") return { findOne: async (query: { _id: ObjectId; ownerId: ObjectId }) => folders.find((folder) =>
      folder._id.equals(query._id) && folder.ownerId.equals(query.ownerId)) ?? null };
    if (name !== "files") return {};
    return {
      findOne: async (query: { _id: ObjectId; ownerId: ObjectId; status: string }) => records.find((file) =>
        file._id.equals(query._id) && file.ownerId.equals(query.ownerId) && file.status === query.status) ?? null,
      find(query: { ownerId: ObjectId; status: string; folderId?: ObjectId | null; category?: string;
        $or?: [{ createdAt: { $lt: Date } }, { createdAt: Date; _id: { $lt: ObjectId } }] }) {
        const found = records.filter((file) => file.ownerId.equals(query.ownerId) && file.status === query.status &&
          (!Object.hasOwn(query, "folderId") || (file.folderId?.toHexString() ?? null) === (query.folderId?.toHexString() ?? null)) &&
          (!query.category || file.category === query.category) && (!query.$or ||
            file.createdAt < query.$or[0].createdAt.$lt ||
            (file.createdAt.getTime() === query.$or[1].createdAt.getTime() && file._id.toHexString() < query.$or[1]._id.$lt.toHexString())));
        return { sort: () => ({ limit: (count: number) => ({ toArray: async () => found.sort((a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || b._id.toHexString().localeCompare(a._id.toHexString())).slice(0, count) }) }) };
      },
    };
  } } as unknown as Db;
}

test("file names use a separate browser-only context and fail closed after lock", async () => {
  installVaultRootKey(key, vaultId);
  const id = newFileId();
  const encrypted = await encryptFileName(id, "Private photo.jpg");
  assert.equal(JSON.stringify(encrypted).includes("Private photo"), false);
  assert.equal(await decryptFileName(id, encrypted), "Private photo.jpg");
  await assert.rejects(decryptFileName(newFileId(), encrypted));
  await assert.rejects(decryptFileName(id, { ...encrypted, ciphertext: `${encrypted.ciphertext[0] === "A" ? "B" : "A"}${encrypted.ciphertext.slice(1)}` }));
  await assert.rejects(decryptFileName(id, await encryptFolderName(id, "Private photo.jpg")));
  clearVaultKeyMaterial();
  await assert.rejects(decryptFileName(id, encrypted));
});

test("ready listings are owner scoped, folder scoped, stable paginated, and omit private storage fields", async () => {
  installVaultRootKey(key, vaultId);
  const records = await Promise.all(Array.from({ length: 105 }, (_, index) => record(index)));
  const otherFolder = new ObjectId();
  records.push(await record(106, { ownerId: foreign }));
  records.push(await record(107, { status: "deleting" }));
  records.push(await record(108, { status: "failed", cloudinary: undefined, storedSizeBytes: undefined }));
  records.push(await record(109, { folderId: otherFolder }));
  const db = fakeDatabase(records, [{ _id: otherFolder, ownerId: owner, status: "active", parentFolderId: null }]);
  const first = await listReadyFiles(db, owner, { folderId: null });
  assert.equal(first.files.length, 100);
  assert.ok(first.nextCursor);
  assert.equal(first.files[0].id, records[104]._id.toHexString());
  assert.equal(first.files[0].nameEncrypted.version, 1);
  assert.equal(JSON.stringify(first.files).includes("dummy-test-only"), false);
  assert.equal(JSON.stringify(first.files).includes("encryptedFileKey"), false);
  assert.equal(JSON.stringify(first.files).includes("private-"), false);
  const second = await listReadyFiles(db, owner, { folderId: null, after: parseFileCursor(first.nextCursor!)! });
  assert.equal(second.files.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal((await listReadyFiles(db, owner, { folderId: otherFolder })).files.length, 1);
  assert.equal((await listReadyFiles(db, foreign, { folderId: null })).files.length, 1);
  assert.equal((await listReadyFiles(db, owner, { folderId: null, category: "video" })).files.length, 0);
  clearVaultKeyMaterial();
});

test("details hide foreign, deleting and deleting-parent files", async () => {
  installVaultRootKey(key, vaultId);
  const folderId = new ObjectId();
  const ready = await record(1, { folderId });
  const deleting = await record(2, { status: "deleting" });
  const db = fakeDatabase([ready, deleting], [{ _id: folderId, ownerId: owner, status: "active", parentFolderId: null }]);
  assert.equal((await findReadyFileDetails(db, owner, ready._id))?.id, ready._id.toHexString());
  assert.equal(await findReadyFileDetails(db, foreign, ready._id), null);
  assert.equal(await findReadyFileDetails(db, owner, deleting._id), null);
  const blocked = fakeDatabase([ready], [{ _id: folderId, ownerId: owner, status: "deleting", parentFolderId: null }]);
  assert.equal(await findReadyFileDetails(blocked, owner, ready._id), null);
  assert.equal((await listReadyFiles(blocked, owner, { folderId: null, allFolders: true })).files.length, 0);
  assert.equal(publicFileMetadata(ready).storedSizeBytes, ready.storedSizeBytes);
  clearVaultKeyMaterial();
});

test("ciphertext lookup requires an owned ready restricted asset in an active folder", async () => {
  installVaultRootKey(key, vaultId);
  const folderId = new ObjectId();
  const legacy = await record(40, { folderId, cloudinary: {
    publicId: "vaultx/ciphertext/0123456789abcdef0123456789abcdef0123456789abcdef.dat",
    assetId: "asset-test-40", resourceType: "raw", deliveryType: "authenticated", format: "dat",
  } });
  const ready = { ...legacy, encryptionManifest: { version: 1 as const, kind: "file" as const, vaultId,
    header: "A".repeat(107), objectBytes: String(legacy.storedSizeBytes),
    wrappedKey: { version: 1 as const, revision: 1 as const, salt: "A".repeat(43), nonce: "A".repeat(16), ciphertext: "A".repeat(64) },
  } } as VaultFile;
  const db = fakeDatabase([ready], [{ _id: folderId, ownerId: owner, status: "active", parentFolderId: null }]);
  assert.equal((await findOwnedReadyCiphertextFile(db, owner, ready._id))?._id.toHexString(), ready._id.toHexString());
  assert.equal(await findOwnedReadyCiphertextFile(fakeDatabase([legacy], [{ _id: folderId, ownerId: owner, status: "active", parentFolderId: null }]), owner, legacy._id), null);
  assert.equal(await findOwnedReadyCiphertextFile(db, foreign, ready._id), null);
  const hidden = fakeDatabase([ready], [{ _id: folderId, ownerId: owner, status: "deleting", parentFolderId: null }]);
  assert.equal(await findOwnedReadyCiphertextFile(hidden, owner, ready._id), null);
  const nonRestricted = await record(41, { cloudinary: {
    publicId: "vaultx/ciphertext/abcdef0123456789abcdef0123456789abcdef0123456789.dat",
    assetId: "asset-test-41", resourceType: "raw", deliveryType: "private", format: "dat",
  } });
  assert.equal(await findOwnedReadyCiphertextFile(fakeDatabase([nonRestricted]), owner, nonRestricted._id), null);
  const outsideNamespace = { ...ready, cloudinary: { ...ready.cloudinary!, publicId: "elsewhere/object.dat" } };
  assert.equal(await findOwnedReadyCiphertextFile(fakeDatabase([outsideNamespace]), owner, ready._id), null);
  clearVaultKeyMaterial();
});

test("authorized file access metadata includes only the wrapped manifest, never provider identity", async () => {
  installVaultRootKey(key, vaultId);
  const base = await record(42, { cloudinary: {
    publicId: "vaultx/ciphertext/abcdef0123456789abcdef0123456789abcdef0123456789.dat", assetId: "asset-test-42",
    resourceType: "raw", deliveryType: "authenticated", format: "dat",
  } });
  const manifest = { version: 1 as const, kind: "file" as const, vaultId,
    header: "A".repeat(107), objectBytes: String(base.storedSizeBytes),
    wrappedKey: { version: 1 as const, revision: 1 as const, salt: "A".repeat(43), nonce: "A".repeat(16), ciphertext: "A".repeat(64) } };
  const ready = { ...base, encryptionManifest: manifest, encryptedFileKey: manifest.wrappedKey.ciphertext } as VaultFile;
  const access = await findReadyFileAccessMetadata(fakeDatabase([ready]), owner, ready._id);
  assert.equal(access?.encryptionManifest.kind, "file");
  assert.equal(JSON.stringify(access).includes("publicId"), false);
  assert.equal(JSON.stringify(access).includes("asset-test-42"), false);
  assert.equal(JSON.stringify(access).includes("encryptedFileKey"), false);
  clearVaultKeyMaterial();
});

test("malformed cursors are rejected and date paging indexes are present", () => {
  for (const raw of ["", "not-a-cursor", "x".repeat(300), Buffer.from(JSON.stringify({ id: "bad", createdAt: "2026-01-01" })).toString("base64url")]) {
    assert.equal(parseFileCursor(raw), null);
  }
  assert.ok(modelIndexes.files.some((index) => index.name === "owner_folder_ready_date"));
  assert.ok(modelIndexes.files.some((index) => index.name === "owner_ready_date"));
});
