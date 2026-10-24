import { ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { vaultKeyEnvelopeSchema } from "@/lib/crypto/vault-key-schema";
import { encryptedNameSchema } from "@/lib/crypto/folder-name-schema";
import { fileManifestSchema } from "@/lib/crypto/file-container";

const id = z.instanceof(ObjectId);
const date = z.date();
const encoded = z.string().min(16).max(16_384).regex(/^[A-Za-z0-9_-]+$/);
const shortCode = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export { encryptedNameSchema };

const cloudAssetIdentity = z.strictObject({
  publicId: z.string().min(1).max(512),
  assetId: z.string().min(1).max(128).optional(),
  resourceType: z.enum(["image", "video", "raw"]),
  deliveryType: z.enum(["authenticated", "private"]),
  format: shortCode.optional(),
  version: z.number().int().positive().optional(),
});

export const cloudAssetSchema = cloudAssetIdentity;

const timestamps = {
  createdAt: date,
  updatedAt: date,
};

function sameIds(ids: ObjectId[]): boolean {
  return new Set(ids.map((value) => value.toHexString())).size === ids.length;
}

function uniqueAssets(assets: { publicId: string; resourceType: string; deliveryType: string }[]): boolean {
  return new Set(assets.map((asset) => `${asset.resourceType}:${asset.deliveryType}:${asset.publicId}`)).size === assets.length;
}

export const ownerSchema = z.strictObject({
  _id: id,
  singletonKey: z.literal("vaultx-owner"),
  username: z.string().min(1).max(128),
  passwordHash: z.string().max(1024).regex(/^\$argon2id\$v=19\$m=\d+,p=\d+,t=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/),
  initializedAt: date,
  folderTreeRevision: z.number().int().nonnegative().optional(),
  settings: z.strictObject({
    autoLockMinutes: z.number().int().min(1).max(1440),
    requireLockOnOpen: z.boolean(),
  }),
});

export const folderSchema = z.strictObject({
  _id: id,
  ownerId: id,
  parentFolderId: id.nullable(),
  nameEncrypted: encryptedNameSchema,
  descriptionEncrypted: encryptedNameSchema.optional(),
  coverMediaId: id.optional(),
  status: z.enum(["active", "deleting"]),
  ...timestamps,
}).superRefine((folder, ctx) => {
  if (folder.parentFolderId?.equals(folder._id)) {
    ctx.addIssue({ code: "custom", path: ["parentFolderId"], message: "A folder cannot be its own parent" });
  }
  if (folder.descriptionEncrypted && folder.descriptionEncrypted.vaultId !== folder.nameEncrypted.vaultId) {
    ctx.addIssue({ code: "custom", path: ["descriptionEncrypted"], message: "Description uses a different vault" });
  }
});

export const fileSchema = z.strictObject({
  _id: id,
  ownerId: id,
  folderId: id.nullable(),
  nameEncrypted: encryptedNameSchema,
  sourceNameEncrypted: encryptedNameSchema.optional(),
  tagsEncrypted: z.array(encryptedNameSchema).max(20).optional(),
  favorite: z.boolean().optional(),
  extension: z.string().regex(/^[a-z0-9]{0,16}$/),
  category: z.enum(["image", "video", "audio", "document", "other"]),
  mimeType: z.string().min(3).max(127),
  sourceSizeBytes: z.number().int().nonnegative().optional(),
  storedSizeBytes: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().finite().positive().optional(),
  cloudinary: cloudAssetIdentity.optional(),
  // A thumbnail is independently encrypted and stored. It has no plaintext
  // filename and is never a Cloudinary transformation of the file object.
  thumbnail: z.strictObject({
    storedSizeBytes: z.number().int().positive(),
    cloudinary: cloudAssetIdentity,
    encryptionManifest: fileManifestSchema,
  }).optional(),
  encryptedFileKey: encoded,
  encryptionManifest: z.union([fileManifestSchema, z.strictObject({
    version: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    chunkCount: z.number().int().positive(),
    chunkSizeBytes: z.number().int().positive(),
  })]),
  status: z.enum(["queued", "optimizing", "uploading", "verifying", "ready", "deleting", "failed"]),
  ...timestamps,
}).superRefine((file, ctx) => {
  if (file.status === "ready" || file.status === "deleting") {
    if (!file.cloudinary) ctx.addIssue({ code: "custom", path: ["cloudinary"], message: "Stored files need a Cloudinary identity" });
    if (!file.storedSizeBytes) ctx.addIssue({ code: "custom", path: ["storedSizeBytes"], message: "Stored files need a verified size" });
  }
  if (file.storedSizeBytes && file.category === "image" && file.storedSizeBytes >= 1_000_000) {
    ctx.addIssue({ code: "custom", path: ["storedSizeBytes"], message: "Image ciphertext exceeds the PRD limit" });
  }
  if (file.storedSizeBytes && file.category === "video" && file.storedSizeBytes >= 100_000_000) {
    ctx.addIssue({ code: "custom", path: ["storedSizeBytes"], message: "Video ciphertext exceeds the PRD limit" });
  }
  if ("kind" in file.encryptionManifest && (file.encryptionManifest.kind !== "file"
    || file.encryptedFileKey !== file.encryptionManifest.wrappedKey.ciphertext
    || file.nameEncrypted.vaultId !== file.encryptionManifest.vaultId
    || (file.status === "ready" && (!file.cloudinary?.assetId || file.cloudinary.resourceType !== "raw"
      || file.cloudinary.deliveryType !== "authenticated" || file.cloudinary.format !== "dat"))
    || (file.storedSizeBytes !== undefined && String(file.storedSizeBytes) !== file.encryptionManifest.objectBytes))) {
    ctx.addIssue({ code: "custom", path: ["encryptionManifest"], message: "File encryption binding is inconsistent" });
  }
  if (file.sourceNameEncrypted && file.sourceNameEncrypted.vaultId !== file.nameEncrypted.vaultId) {
    ctx.addIssue({ code: "custom", path: ["sourceNameEncrypted"], message: "Original name uses a different vault" });
  }
  if (file.tagsEncrypted?.some((tag) => tag.vaultId !== file.nameEncrypted.vaultId)) {
    ctx.addIssue({ code: "custom", path: ["tagsEncrypted"], message: "Tags use a different vault" });
  }
  if (file.thumbnail && (file.thumbnail.encryptionManifest.kind !== "thumbnail"
    || file.thumbnail.storedSizeBytes >= 1_000_000
    || file.thumbnail.encryptionManifest.vaultId !== file.nameEncrypted.vaultId
    || file.thumbnail.encryptionManifest.objectBytes !== String(file.thumbnail.storedSizeBytes)
    || !file.thumbnail.cloudinary.assetId || file.thumbnail.cloudinary.resourceType !== "raw"
    || file.thumbnail.cloudinary.deliveryType !== "authenticated" || file.thumbnail.cloudinary.format !== "dat")) {
    ctx.addIssue({ code: "custom", path: ["thumbnail"], message: "Thumbnail storage binding is inconsistent" });
  }
});

export const uploadCompletionMetadataSchema = z.strictObject({
  nameEncrypted: encryptedNameSchema,
  sourceNameEncrypted: encryptedNameSchema.optional(),
  extension: z.string().regex(/^[a-z0-9]{0,16}$/),
  mimeType: z.string().min(3).max(127),
  width: z.number().int().positive().max(16_384).optional(),
  height: z.number().int().positive().max(16_384).optional(),
  durationSeconds: z.number().finite().positive().max(86_400).optional(),
});

export const uploadJobSchema = z.strictObject({
  _id: id,
  ownerId: id,
  fileId: id,
  folderId: id.nullable().optional(),
  category: z.enum(["image", "video", "document", "other"]).optional(),
  manifest: fileManifestSchema.optional(),
  thumbnailManifest: fileManifestSchema.optional(),
  ciphertextBytes: z.number().int().positive().optional(),
  intentExpiresAt: date.optional(),
  completionMetadata: uploadCompletionMetadataSchema.optional(),
  cancelRequestedAt: date.optional(),
  operation: z.enum(["transfer", "complete", "cancel"]).optional(),
  leaseToken: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  leaseExpiresAt: date.optional(),
  status: z.enum(["pending", "running", "retrying", "failed", "completed", "cancelled"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: date.optional(),
  lastErrorCode: shortCode.optional(),
  // Keep exact provider IDs so a failed upload can be reconciled or cleaned up.
  cloudAssets: z.array(cloudAssetIdentity.extend({ cleanupCompleted: z.boolean() })).max(100),
  ...timestamps,
}).superRefine((job, ctx) => {
  if (!uniqueAssets(job.cloudAssets)) ctx.addIssue({ code: "custom", path: ["cloudAssets"], message: "Duplicate Cloudinary object" });
  if (job.manifest && (!job.category || !job.ciphertextBytes || !job.intentExpiresAt
    || job.folderId === undefined || job.cloudAssets.length !== (job.thumbnailManifest ? 2 : 1) || job.manifest.kind !== "file"
    || job.cloudAssets[0].resourceType !== "raw" || job.cloudAssets[0].deliveryType !== "authenticated"
    || job.cloudAssets[0].format !== "dat"
    || !/^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/.test(job.cloudAssets[0].publicId)
    || job.manifest.objectBytes !== String(job.ciphertextBytes)
    || job.intentExpiresAt <= job.createdAt)) {
    ctx.addIssue({ code: "custom", path: ["manifest"], message: "Upload intent is incomplete" });
  }
  if (!job.manifest && (job.category || job.ciphertextBytes || job.intentExpiresAt || job.folderId !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["manifest"], message: "Upload intent is incomplete" });
  }
  if (job.completionMetadata && (!job.manifest || job.completionMetadata.nameEncrypted.vaultId !== job.manifest.vaultId
    || (job.completionMetadata.sourceNameEncrypted && job.completionMetadata.sourceNameEncrypted.vaultId !== job.manifest.vaultId))) {
    ctx.addIssue({ code: "custom", path: ["completionMetadata"], message: "Wrong vault name envelope" });
  }
  if ((job.leaseToken === undefined) !== (job.leaseExpiresAt === undefined)) {
    ctx.addIssue({ code: "custom", path: ["leaseToken"], message: "Incomplete upload lease" });
  }
  if (job.manifest && job.status === "completed" && (!job.cloudAssets[0]?.assetId || !job.completionMetadata)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Completed upload lacks verification identity" });
  }
  if (job.thumbnailManifest && (job.thumbnailManifest.kind !== "thumbnail" || !job.manifest
    || job.thumbnailManifest.vaultId !== job.manifest.vaultId || job.cloudAssets.length !== 2
    || !/^vaultx\/thumbnails\/[a-f0-9]{48}\.dat$/.test(job.cloudAssets[1]?.publicId ?? "")
    || job.cloudAssets[1]?.resourceType !== "raw" || job.cloudAssets[1]?.deliveryType !== "authenticated"
    || job.cloudAssets[1]?.format !== "dat")) {
    ctx.addIssue({ code: "custom", path: ["thumbnailManifest"], message: "Thumbnail intent is incomplete" });
  }
  if (!job.thumbnailManifest && job.cloudAssets.length > 1) {
    ctx.addIssue({ code: "custom", path: ["cloudAssets"], message: "Unexpected secondary cloud asset" });
  }
  if (job.manifest && job.status === "cancelled" && job.cloudAssets.some((asset) => !asset.cleanupCompleted)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Cancelled upload lacks confirmed cleanup" });
  }
});

const deletionAsset = cloudAssetIdentity.extend({
  fileId: id,
  completed: z.boolean(),
});

export const deletionJobSchema = z.strictObject({
  _id: id,
  ownerId: id,
  targetType: z.enum(["file", "folder"]),
  targetId: id,
  // For folders, these arrays are the durable subtree snapshot.
  fileIds: z.array(id).max(100_000),
  folderIds: z.array(id).max(100_000),
  inventoryComplete: z.boolean(),
  cloudAssets: z.array(deletionAsset).max(100_000),
  phase: z.enum(["inventorying", "deleting", "remote-delete-confirmed", "metadata-removed", "completed"]),
  status: z.enum(["pending", "running", "retrying", "failed", "completed"]),
  attempts: z.number().int().nonnegative(),
  leaseToken: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  leaseExpiresAt: date.optional(),
  lastErrorCode: shortCode.optional(),
  nextAttemptAt: date.optional(),
  ...timestamps,
}).superRefine((job, ctx) => {
  if ((job.leaseToken === undefined) !== (job.leaseExpiresAt === undefined)
    || (job.status === "running") !== (job.leaseToken !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["leaseToken"], message: "Deletion lease is inconsistent" });
  }
  if (!sameIds(job.fileIds) || !sameIds(job.folderIds)) ctx.addIssue({ code: "custom", path: ["fileIds"], message: "Duplicate inventory ID" });
  if (!uniqueAssets(job.cloudAssets)) ctx.addIssue({ code: "custom", path: ["cloudAssets"], message: "Duplicate Cloudinary object" });
  const files = new Set(job.fileIds.map((value) => value.toHexString()));
  if (job.cloudAssets.some((asset) => !files.has(asset.fileId.toHexString()))) {
    ctx.addIssue({ code: "custom", path: ["cloudAssets"], message: "Cloudinary object has no inventoried file" });
  }
  const targets = job.targetType === "file" ? files : new Set(job.folderIds.map((value) => value.toHexString()));
  if (job.inventoryComplete && !targets.has(job.targetId.toHexString())) {
    ctx.addIssue({ code: "custom", path: ["targetId"], message: "Target is absent from the inventory" });
  }
  if (!job.inventoryComplete && job.phase !== "inventorying") {
    ctx.addIssue({ code: "custom", path: ["phase"], message: "Deletion requires a complete inventory" });
  }
  if (["remote-delete-confirmed", "metadata-removed", "completed"].includes(job.phase) && job.cloudAssets.some((asset) => !asset.completed)) {
    ctx.addIssue({ code: "custom", path: ["cloudAssets"], message: "Remote deletion is not confirmed" });
  }
  if ((job.status === "completed") !== (job.phase === "completed")) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "Completion status and phase must agree" });
  }
});

export const sessionSchema = z.strictObject({
  _id: id,
  ownerId: id,
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: date,
  lastSeenAt: date,
  idleExpiresAt: date,
  expiresAt: date,
  deviceLabel: z.enum(["Chrome on Windows", "Chrome on Android", "Chrome on desktop", "Browser on iPhone or iPad", "Safari on Mac", "Edge on Windows", "Firefox", "Other browser"]).optional(),
  lockedAt: date.optional(),
  revokedAt: date.optional(),
}).superRefine((session, ctx) => {
  if (session.expiresAt <= session.createdAt) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiration must follow creation" });
  if (session.idleExpiresAt <= session.createdAt || session.idleExpiresAt > session.expiresAt) ctx.addIssue({ code: "custom", path: ["idleExpiresAt"], message: "Idle expiry must fall within the session lifetime" });
});

export const deviceCredentialSchema = z.strictObject({
  _id: id,
  ownerId: id,
  credentialId: encoded,
  publicKey: encoded,
  signCount: z.number().int().nonnegative(),
  rpId: z.string().min(1).max(253).optional(),
  transports: z.array(z.enum(["usb", "nfc", "ble", "internal", "hybrid"])).max(5),
  labelEncrypted: encryptedNameSchema.optional(),
  createdAt: date,
  lastUsedAt: date.optional(),
});

export const pinCredentialSchema = z.strictObject({
  _id: id, ownerId: id,
  deviceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verifier: z.string().max(1024).regex(/^\$argon2id\$/),
  failedAttempts: z.number().int().min(0).max(5),
  lockedUntil: date.optional(),
  createdAt: date, expiresAt: date, lastUsedAt: date.optional(),
});
export type PinCredential = z.infer<typeof pinCredentialSchema>;

export const webauthnChallengeSchema = z.strictObject({
  _id: id, ownerId: id.optional(), kind: z.enum(["register", "authenticate"]),
  challenge: z.string().min(16).max(256), browserDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expiresAt: date,
});
export type WebauthnChallenge = z.infer<typeof webauthnChallengeSchema>;

export const vaultKeyRecordSchema = vaultKeyEnvelopeSchema.extend({
  _id: id,
  ownerId: id,
  createdAt: date,
  recoveryConfirmedAt: date,
});

export type Owner = z.infer<typeof ownerSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type VaultFile = z.infer<typeof fileSchema>;
export type UploadJob = z.infer<typeof uploadJobSchema>;
export type DeletionJob = z.infer<typeof deletionJobSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type DeviceCredential = z.infer<typeof deviceCredentialSchema>;
export type VaultKeyRecord = z.infer<typeof vaultKeyRecordSchema>;

// The driver types queries but does not validate documents at runtime. Parse at write boundaries.
export function getModelCollections(db: Db) {
  return {
    owners: db.collection<Owner>("owners"),
    folders: db.collection<Folder>("folders"),
    files: db.collection<VaultFile>("files"),
    uploadJobs: db.collection<UploadJob>("uploadJobs"),
    deletionJobs: db.collection<DeletionJob>("deletionJobs"),
    sessions: db.collection<Session>("sessions"),
    deviceCredentials: db.collection<DeviceCredential>("deviceCredentials"),
    pinCredentials: db.collection<PinCredential>("pinCredentials"),
    webauthnChallenges: db.collection<WebauthnChallenge>("webauthnChallenges"),
    vaultKeys: db.collection<VaultKeyRecord>("vaultKeys"),
  };
}

export function assertSameOwner(expected: ObjectId, actual: ObjectId): void {
  if (!expected.equals(actual)) throw new Error("Owner relationship mismatch");
}

export function assertFolderParent(folder: Folder, parent: Folder): void {
  assertSameOwner(folder.ownerId, parent.ownerId);
  if (!folder.parentFolderId?.equals(parent._id) || parent.status !== "active") {
    throw new Error("Invalid parent folder relationship");
  }
}

export function assertFileFolder(file: VaultFile, folder: Folder): void {
  assertSameOwner(file.ownerId, folder.ownerId);
  if (!file.folderId?.equals(folder._id) || folder.status !== "active") {
    throw new Error("Invalid file folder relationship");
  }
}

export function assertJobFile(job: UploadJob, file: VaultFile): void {
  assertSameOwner(job.ownerId, file.ownerId);
  if (!job.fileId.equals(file._id)) throw new Error("Invalid upload file relationship");
}
