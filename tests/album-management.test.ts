import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId, type Db } from "mongodb";
import { isEnabledPrivateApiMethod, isEnabledPrivateApiPath, isPrivateApiPath } from "../src/lib/auth/api-policy";
import { listAlbums } from "../src/lib/database/albums";
import { folderSchema } from "../src/lib/database/models";
import { modelIndexes } from "../src/lib/database/model-indexes";

const encrypted = { version: 1, vaultId: "a".repeat(22), salt: "b".repeat(43), ciphertext: "c".repeat(24), nonce: "d".repeat(16), algorithm: "AES-256-GCM" } as const;

test("album endpoints are explicit private API routes with no unreviewed methods", () => {
  assert.equal(isPrivateApiPath("/api/albums"), true);
  assert.equal(isEnabledPrivateApiPath("/api/albums"), true);
  assert.equal(isEnabledPrivateApiPath("/api/albums/0123456789abcdef01234567"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/albums", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/albums", "POST"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/albums", "DELETE"), false);
  assert.equal(isEnabledPrivateApiMethod("/api/albums/0123456789abcdef01234567", "PATCH"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/albums/0123456789abcdef01234567", "DELETE"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/albums/0123456789abcdef01234567", "GET"), false);
});

test("album records keep descriptions encrypted and cover identifiers are opaque", () => {
  const folder = { _id: new ObjectId(), ownerId: new ObjectId(), parentFolderId: null, nameEncrypted: encrypted,
    descriptionEncrypted: encrypted, coverMediaId: new ObjectId(), status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  assert.equal(folderSchema.safeParse(folder).success, true);
  assert.equal(folderSchema.safeParse({ ...folder, description: "Summer trip" }).success, false);
  assert.equal(folderSchema.safeParse({ ...folder, descriptionEncrypted: { ...encrypted, vaultId: "z".repeat(22) } }).success, false);
});

test("album count queries have a compact owner-folder-ready-category index", () => {
  const index = modelIndexes.files.find((item) => item.name === "owner_folder_ready_category");
  assert.deepEqual(index?.key, { ownerId: 1, folderId: 1, status: 1, category: 1 });
  assert.equal(JSON.stringify(modelIndexes).includes("nameEncrypted"), false);
});

test("album counts exclude legacy ready rows without verified ciphertext identity", async () => {
  let match: Record<string, unknown> | undefined;
  const db = { collection(name: string) {
    if (name === "folders") return { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
    if (name === "files") return { aggregate: (pipeline: Array<{ $match?: Record<string, unknown> }>) => {
      match = pipeline[0].$match;
      return { toArray: async () => [] };
    } };
    return {};
  } } as unknown as Db;
  await listAlbums(db, new ObjectId());
  assert.equal(match?.["cloudinary.resourceType"], "raw");
  assert.equal(match?.["cloudinary.deliveryType"], "authenticated");
  assert.equal(match?.["encryptionManifest.kind"], "file");
  assert.equal(typeof match?.$expr, "object");
});
