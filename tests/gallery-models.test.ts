import assert from "node:assert/strict";
import test from "node:test";
import mongoose, { Types } from "mongoose";
import { albumSchema, getGalleryModels, mediaSchema } from "../src/models/gallery";
import { fileSchema, folderSchema } from "../src/lib/database/models";
import { modelIndexes } from "../src/lib/database/model-indexes";
import { albumPageOptionsSchema, encodeGalleryCursor, listGalleryMedia, mediaPageOptionsSchema, parseGalleryCursor } from "../src/lib/database/gallery-metadata";

const ownerId = new Types.ObjectId();
const nameEncrypted = { version: 1, vaultId: "A".repeat(22), salt: "B".repeat(43),
  ciphertext: "C".repeat(24), nonce: "D".repeat(16), algorithm: "AES-256-GCM" } as const;
const now = new Date("2026-01-01T00:00:00.000Z");

test("gallery models reuse files and folders, and never auto-create indexes", () => {
  const connection = mongoose.createConnection();
  const first = getGalleryModels(connection);
  const second = getGalleryModels(connection);
  assert.equal(first.Media, second.Media);
  assert.equal(first.Album, second.Album);
  assert.equal(first.Media.collection.name, "files");
  assert.equal(first.Album.collection.name, "folders");
  assert.equal(mediaSchema.options.autoIndex, false);
  assert.equal(albumSchema.options.autoCreate, false);
  assert.equal(mediaSchema.path("fileContent"), undefined);
  assert.equal(mediaSchema.path("secure_url"), undefined);
  assert.equal(mediaSchema.path("original_filename"), undefined);
});

test("Mongoose and Zod reject plaintext metadata and unsafe delivery fields", async () => {
  const connection = mongoose.createConnection();
  const { Media, Album } = getGalleryModels(connection);
  const file = { _id: new Types.ObjectId(), ownerId, folderId: null, nameEncrypted,
    extension: "jpg", category: "image", mimeType: "image/jpeg", storedSizeBytes: 900_000,
    cloudinary: { publicId: "vaultx/ciphertext/" + "a".repeat(48) + ".dat", assetId: "opaque",
      resourceType: "raw", deliveryType: "authenticated", format: "dat" },
    encryptedFileKey: "A".repeat(16), encryptionManifest: { version: 1, algorithm: "AES-256-GCM", chunkCount: 1, chunkSizeBytes: 64 },
    status: "ready", createdAt: now, updatedAt: now } as const;
  assert.equal(fileSchema.safeParse(file).success, true);
  assert.equal(fileSchema.safeParse({ ...file, original_filename: "private.jpg" }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, secure_url: "https://example.com/private.jpg" }).success, false);
  assert.equal(fileSchema.safeParse({ ...file, tagsEncrypted: [nameEncrypted], favorite: true }).success, true);
  assert.throws(() => new Media({ ...file, display_name: "private" }));
  const media = new Media(file);
  await media.validate();
  assert.equal(media.status, "ready");
  const folder = { _id: new Types.ObjectId(), ownerId, parentFolderId: null,
    nameEncrypted, status: "active", createdAt: now, updatedAt: now } as const;
  assert.equal(folderSchema.safeParse(folder).success, true);
  assert.equal(folderSchema.safeParse({ ...folder, description: "private" }).success, false);
  assert.throws(() => new Album({ ...folder, name: "private" }));
  const album = new Album(folder);
  await album.validate();
  assert.equal(album.status, "active");
});

test("unique provider ID and indexed gallery filters are explicit", () => {
  const indexes = modelIndexes.files;
  const unique = indexes.find((index) => index.name === "cloudinary_public_id_unique");
  assert.deepEqual(unique?.key, { "cloudinary.publicId": 1 });
  assert.equal(unique?.unique, true);
  assert.equal(unique?.sparse, true);
  assert.ok(indexes.some((index) => index.name === "owner_category_ready_date"));
  assert.ok(indexes.some((index) => index.name === "owner_ready_favorite_date"));
  assert.equal(indexes.some((index) => JSON.stringify(index.key).includes("nameEncrypted")), false);
  assert.equal(mediaSchema.indexes().some(([fields, options]) => fields["cloudinary.publicId"] === 1 && options.unique), true);
});

test("pagination is bounded and rejects invalid filters before a database query", async () => {
  assert.equal(mediaPageOptionsSchema.safeParse({ limit: 100, category: "video" }).success, true);
  assert.equal(mediaPageOptionsSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(mediaPageOptionsSchema.safeParse({ ownerId }).success, false);
  assert.equal(albumPageOptionsSchema.safeParse({ parentId: null, limit: 1 }).success, true);
  assert.equal(albumPageOptionsSchema.safeParse({ parentId: null, limit: 0 }).success, false);
  await assert.rejects(listGalleryMedia({} as never, ownerId, { limit: 101 }), { code: "invalid_request" });
});

test("gallery cursors bind to sort order and reject malformed input", () => {
  const file = { _id: new Types.ObjectId(), createdAt: now, storedSizeBytes: 999 };
  for (const sort of ["newest", "oldest", "size"] as const) {
    const encoded = encodeGalleryCursor(file, sort);
    const parsed = parseGalleryCursor(encoded, sort);
    assert.equal(parsed?.id.toHexString(), file._id.toHexString());
    assert.equal(parsed?.sort, sort);
    assert.equal(parseGalleryCursor(encoded, sort === "size" ? "newest" : "size"), null);
    assert.equal(parseGalleryCursor(`${encoded}!`, sort), null);
  }
  assert.equal(mediaPageOptionsSchema.safeParse({ sort: "size", after: { sort: "newest", createdAt: now, id: file._id } }).success, false);
});
