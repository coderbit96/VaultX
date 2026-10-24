import type { Db, IndexDescription } from "mongodb";

type ModelCollection = "owners" | "folders" | "files" | "uploadJobs" | "deletionJobs" | "sessions" | "deviceCredentials" | "pinCredentials" | "webauthnChallenges" | "loginAttempts" | "vaultKeys";

// Stable names make setup repeatable and make drift visible during review.
export const modelIndexes: Record<ModelCollection, IndexDescription[]> = {
  owners: [
    { name: "username_unique", key: { username: 1 }, unique: true },
    { name: "singleton_owner_unique", key: { singletonKey: 1 }, unique: true },
  ],
  folders: [
    { name: "owner_parent_status", key: { ownerId: 1, parentFolderId: 1, status: 1 } },
    { name: "owner_parent_status_id", key: { ownerId: 1, parentFolderId: 1, status: 1, _id: 1 } },
  ],
  files: [
    { name: "owner_folder_status", key: { ownerId: 1, folderId: 1, status: 1 } },
    { name: "owner_folder_ready_category", key: { ownerId: 1, folderId: 1, status: 1, category: 1 } },
    { name: "owner_folder_ready_date", key: { ownerId: 1, folderId: 1, status: 1, createdAt: -1, _id: -1 } },
    { name: "owner_ready_date", key: { ownerId: 1, status: 1, createdAt: -1, _id: -1 } },
    { name: "owner_category_created", key: { ownerId: 1, category: 1, createdAt: -1 } },
    { name: "cloudinary_public_id_unique", key: { "cloudinary.publicId": 1 }, unique: true, sparse: true },
    { name: "owner_ready_favorite_date", key: { ownerId: 1, status: 1, favorite: 1, createdAt: -1, _id: -1 } },
    { name: "owner_category_ready_date", key: { ownerId: 1, category: 1, status: 1, createdAt: -1, _id: -1 } },
  ],
  uploadJobs: [
    { name: "owner_file", key: { ownerId: 1, fileId: 1 } },
    { name: "cloud_object_unique", key: { "cloudAssets.publicId": 1 }, unique: true, sparse: true },
    { name: "owner_intent_expiry", key: { ownerId: 1, status: 1, intentExpiresAt: 1 } },
    { name: "upload_retry", key: { status: 1, nextAttemptAt: 1 } },
  ],
  deletionJobs: [
    { name: "deletion_retry", key: { status: 1, nextAttemptAt: 1 } },
    { name: "owner_target", key: { ownerId: 1, targetType: 1, targetId: 1 } },
    { name: "owner_target_unique", key: { targetType: 1, targetId: 1, ownerId: 1 }, unique: true },
  ],
  sessions: [
    { name: "token_digest_unique", key: { tokenDigest: 1 }, unique: true },
    { name: "owner_expires", key: { ownerId: 1, expiresAt: 1 } },
    { name: "expire_sessions", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  deviceCredentials: [
    { name: "credential_id_unique", key: { credentialId: 1 }, unique: true },
    { name: "owner_credentials", key: { ownerId: 1, createdAt: -1 } },
  ],
  pinCredentials: [
    { name: "pin_device_unique", key: { deviceDigest: 1 }, unique: true },
    { name: "pin_owner", key: { ownerId: 1 } },
    { name: "pin_expiry", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  webauthnChallenges: [
    { name: "webauthn_expiry", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  loginAttempts: [
    { name: "expire_login_attempts", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  vaultKeys: [
    { name: "one_vault_keys_per_owner", key: { ownerId: 1 }, unique: true },
  ],
};

// Explicitly called by the setup script; importing a model never changes Atlas.
export async function ensureModelIndexes(db: Db): Promise<void> {
  for (const [collectionName, indexes] of Object.entries(modelIndexes)) {
    await db.collection(collectionName).createIndexes(indexes);
  }
}
