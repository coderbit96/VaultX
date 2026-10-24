import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { changeFile, FileOperationError } from "../src/lib/database/files";
import { FolderOperationError } from "../src/lib/database/folders";
import { summarizeStoredFiles } from "../src/lib/database/summary";
import { filterAndSortFiles, type NamedFile } from "../src/lib/files/browse";
import { encryptFileName } from "../src/lib/crypto/file-names";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath } from "../src/lib/auth/api-policy";
import type { Folder, VaultFile } from "../src/lib/database/models";

const owner = new ObjectId();
const stranger = new ObjectId();
const vaultId = randomBytes(16).toString("base64url");
const rootKey = new Uint8Array(randomBytes(32));

async function file(index: number, options: Partial<VaultFile> = {}): Promise<VaultFile> {
  const id = new ObjectId();
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
  return { _id: id, ownerId: owner, folderId: null, nameEncrypted: await encryptFileName(id.toHexString(), `photo-${index}.jpg`),
    extension: "jpg", category: "image", mimeType: "image/jpeg", storedSizeBytes: 500 + index,
    cloudinary: { publicId: `cipher-${index}`, assetId: `asset-${index}`, resourceType: "raw", deliveryType: "authenticated", format: "dat" },
    encryptedFileKey: "A".repeat(64), encryptionManifest: { version: 1, kind: "file", vaultId, objectBytes: String(500 + index),
      header: "A".repeat(107), wrappedKey: { version: 1, revision: 1, salt: "A".repeat(43), nonce: "A".repeat(16), ciphertext: "A".repeat(64) } },
    status: "ready", createdAt: now, updatedAt: now, ...options } as VaultFile;
}

function folder(id: ObjectId, parentFolderId: ObjectId | null, status: "active" | "deleting" = "active"): Folder {
  return { _id: id, ownerId: owner, parentFolderId, status } as Folder;
}

function fakeDatabase(files: VaultFile[], folders: Folder[]): Db {
  return { client: { withSession: async (fn: (session: { withTransaction: (callback: () => Promise<unknown>) => Promise<unknown> }) => Promise<unknown>) =>
    fn({ withTransaction: async (callback) => callback() }) },
  collection(name: string) {
    if (name === "owners") return { updateOne: async (query: { _id: ObjectId }) => ({ matchedCount: query._id.equals(owner) ? 1 : 0 }) };
    if (name === "vaultKeys") return { findOne: async () => ({ vaultId }) };
    if (name === "folders") return { findOne: async (query: { _id: ObjectId; ownerId: ObjectId }) => folders.find((entry) =>
      entry._id.equals(query._id) && entry.ownerId.equals(query.ownerId)) ?? null };
    if (name === "files") return {
      findOne: async (query: { _id: ObjectId; ownerId: ObjectId; status: string }) => files.find((entry) =>
        entry._id.equals(query._id) && entry.ownerId.equals(query.ownerId) && entry.status === query.status) ?? null,
      findOneAndUpdate: async (query: { _id: ObjectId; ownerId: ObjectId; status: string }, update: { $set: Partial<VaultFile> }) => {
        const record = files.find((entry) => entry._id.equals(query._id) && entry.ownerId.equals(query.ownerId) && entry.status === query.status);
        if (!record) return null;
        Object.assign(record, update.$set); return record;
      },
    };
    return {};
  } } as unknown as Db;
}

test("storage totals include verified ready ciphertext and change after move, deletion, and failed upload", async () => {
  installVaultRootKey(rootKey, vaultId);
  const active = folder(new ObjectId(), null);
  const deleting = folder(new ObjectId(), null, "deleting");
  const ready = await file(1);
  const moved = await file(2, { folderId: active._id, category: "video", storedSizeBytes: 999,
    encryptionManifest: { ...((await file(2)).encryptionManifest as object), objectBytes: "999" } as VaultFile["encryptionManifest"] });
  const failed = await file(3, { status: "failed" });
  const hidden = await file(4, { folderId: deleting._id });
  const records = [ready, moved, failed, hidden];
  const summarize = (selected: ObjectId | null = null) => summarizeStoredFiles((async function* () { yield* records; })(), [active, deleting], owner, selected);
  let summary = await summarize();
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.storedBytes, 1500);
  assert.deepEqual(summary.byCategory, { image: 1, video: 1, audio: 0, document: 0, other: 0 });
  assert.equal(summary.recent.length, 2);
  assert.equal(JSON.stringify(summary).includes("photo-"), false);
  assert.deepEqual(summary.breadcrumbCounts, [{ folderId: null, fileCount: 1, folderCount: 1 }]);
  // A failed upload must not count until the provider-confirmed ready transition.
  failed.status = "ready";
  summary = await summarize();
  assert.equal(summary.fileCount, 3);
  assert.equal(summary.storedBytes, 2003);
  failed.status = "failed";
  const db = fakeDatabase(records, [active, deleting]);
  await changeFile(db, owner, ready._id, { folderId: active._id });
  summary = await summarize(active._id);
  assert.deepEqual(summary.breadcrumbCounts.map((item) => item.fileCount), [0, 2]);
  ready.status = "deleting";
  summary = await summarize();
  assert.equal(summary.fileCount, 1);
  assert.equal(summary.storedBytes, 999);
  clearVaultKeyMaterial();
});

test("file rename is encrypted and moves reject foreign and deleting folders", async () => {
  installVaultRootKey(rootKey, vaultId);
  const active = folder(new ObjectId(), null);
  const deleting = folder(new ObjectId(), null, "deleting");
  const record = await file(5);
  const db = fakeDatabase([record], [active, deleting]);
  const encrypted = await encryptFileName(record._id.toHexString(), "renamed.jpg");
  const changed = await changeFile(db, owner, record._id, { nameEncrypted: encrypted });
  assert.equal(changed.nameEncrypted.ciphertext, encrypted.ciphertext);
  assert.equal(JSON.stringify(changed).includes("renamed.jpg"), false);
  await assert.rejects(changeFile(db, owner, record._id, { folderId: deleting._id }), (error: unknown) => error instanceof Error && error.message === "not_found");
  await assert.rejects(changeFile(db, owner, record._id, { folderId: new ObjectId() }), FolderOperationError);
  await assert.rejects(changeFile(db, stranger, record._id, { folderId: null }), FileOperationError);
  assert.equal(record.folderId, null);
  clearVaultKeyMaterial();
});

test("favorite and tags are owner-scoped and tags stay encrypted", async () => {
  installVaultRootKey(rootKey, vaultId);
  const record = await file(9);
  const db = fakeDatabase([record], []);
  const encryptedTag = await encryptFileName(record._id.toHexString(), "Holiday");
  await assert.rejects(changeFile(db, stranger, record._id, { favorite: true }),
    (error: unknown) => error instanceof FileOperationError);
  const changed = await changeFile(db, owner, record._id, { favorite: true, tagsEncrypted: [encryptedTag] });
  assert.equal(changed.favorite, true);
  assert.equal(changed.tagsEncrypted?.[0].ciphertext, encryptedTag.ciphertext);
  assert.equal(JSON.stringify(changed).includes("Holiday"), false);
  await assert.rejects(changeFile(db, owner, record._id, { tagsEncrypted: [
    { ...encryptedTag, vaultId: randomBytes(16).toString("base64url") },
  ] }), (error: unknown) => error instanceof FileOperationError && error.code === "invalid_request");
  clearVaultKeyMaterial();
});

test("client search, categories and sorts operate on decrypted metadata only", () => {
  const base = { id: "a", folderId: null, nameEncrypted: {} as NamedFile["nameEncrypted"], extension: "jpg", category: "image" as const,
    mimeType: "image/jpeg", storedSizeBytes: 10, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const entries: NamedFile[] = [{ ...base, name: "Zebra.jpg" }, { ...base, id: "b", name: "Álbum.jpg", storedSizeBytes: 30,
    createdAt: "2026-01-02T00:00:00.000Z" }, { ...base, id: "c", name: "music.mp3", category: "audio", extension: "mp3" }];
  assert.deepEqual(filterAndSortFiles(entries, "ÁLBUM", "all", "name").map((entry) => entry.id), ["b"]);
  assert.deepEqual(filterAndSortFiles(entries, "", "image", "size-large").map((entry) => entry.id), ["b", "a"]);
  assert.deepEqual(filterAndSortFiles(entries, "", "all", "date-new").map((entry) => entry.id), ["b", "c", "a"]);
  assert.equal(isEnabledPrivateApiPath("/api/vault/summary"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/summary", "POST"), false);
  assert.equal(isEnabledPrivateApiMethod("/api/files/abc", "PATCH"), true);
});
