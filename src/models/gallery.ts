import { Schema, type Connection, type Model } from "mongoose";
import type { Folder, VaultFile } from "@/lib/database/models";

// These models are typed views over the existing files/folders collections.
// Uploads, folder mutations, and deletion still use their established state
// machines. Compiling a model does not create a collection or an index.
const encryptedName = new Schema({
  version: { type: Number, required: true, enum: [1] },
  vaultId: { type: String, required: true },
  salt: { type: String, required: true },
  ciphertext: { type: String, required: true },
  nonce: { type: String, required: true },
  algorithm: { type: String, required: true, enum: ["AES-256-GCM"] },
}, { _id: false, strict: "throw" });

const cloudAsset = new Schema({
  publicId: { type: String, required: true },
  assetId: String,
  resourceType: { type: String, required: true, enum: ["raw", "image", "video"] },
  deliveryType: { type: String, required: true, enum: ["authenticated", "private"] },
  format: String,
  version: Number,
}, { _id: false, strict: "throw" });

export const mediaSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true },
  folderId: { type: Schema.Types.ObjectId, default: null },
  nameEncrypted: { type: encryptedName, required: true },
  sourceNameEncrypted: encryptedName,
  tagsEncrypted: { type: [encryptedName], default: undefined },
  favorite: { type: Boolean, default: false },
  extension: { type: String, required: true },
  category: { type: String, required: true, enum: ["image", "video", "audio", "document", "other"] },
  mimeType: { type: String, required: true },
  sourceSizeBytes: Number,
  storedSizeBytes: Number,
  width: Number,
  height: Number,
  durationSeconds: Number,
  cloudinary: cloudAsset,
  thumbnail: Schema.Types.Mixed,
  encryptedFileKey: { type: String, required: true },
  encryptionManifest: { type: Schema.Types.Mixed, required: true },
  status: { type: String, required: true, enum: ["queued", "optimizing", "uploading", "verifying", "ready", "deleting", "failed"] },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { collection: "files", strict: "throw", strictQuery: "throw", autoCreate: false, autoIndex: false, versionKey: false });

mediaSchema.index({ ownerId: 1, status: 1, createdAt: -1, _id: -1 }, { name: "owner_ready_date" });
mediaSchema.index({ ownerId: 1, folderId: 1, status: 1, createdAt: -1, _id: -1 }, { name: "owner_folder_ready_date" });
mediaSchema.index({ ownerId: 1, folderId: 1, status: 1, category: 1 }, { name: "owner_folder_ready_category" });
mediaSchema.index({ "cloudinary.publicId": 1 }, { name: "cloudinary_public_id_unique", unique: true, sparse: true });
mediaSchema.index({ ownerId: 1, status: 1, favorite: 1, createdAt: -1, _id: -1 }, { name: "owner_ready_favorite_date" });
mediaSchema.index({ ownerId: 1, category: 1, status: 1, createdAt: -1, _id: -1 }, { name: "owner_category_ready_date" });

export const albumSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, required: true },
  parentFolderId: { type: Schema.Types.ObjectId, default: null },
  nameEncrypted: { type: encryptedName, required: true },
  descriptionEncrypted: encryptedName,
  coverMediaId: Schema.Types.ObjectId,
  status: { type: String, required: true, enum: ["active", "deleting"] },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { collection: "folders", strict: "throw", strictQuery: "throw", autoCreate: false, autoIndex: false, versionKey: false });

albumSchema.index({ ownerId: 1, parentFolderId: 1, status: 1, _id: 1 }, { name: "owner_parent_status_id" });

export function getGalleryModels(connection: Connection) {
  return {
    Media: (connection.models.GalleryMedia as Model<VaultFile> | undefined) ?? connection.model<VaultFile>("GalleryMedia", mediaSchema, "files"),
    Album: (connection.models.GalleryAlbum as Model<Folder> | undefined) ?? connection.model<Folder>("GalleryAlbum", albumSchema, "folders"),
  };
}
