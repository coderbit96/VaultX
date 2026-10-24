import type { EncryptedName } from "@/lib/crypto/folder-name-schema";
import type { FileManifest } from "@/lib/crypto/file-container";

export type FileCategory = "image" | "video" | "audio" | "document" | "other";
export type FilePublicMetadata = {
  id: string;
  folderId: string | null;
  nameEncrypted: EncryptedName;
  tagsEncrypted?: EncryptedName[];
  favorite?: boolean;
  extension: string;
  category: FileCategory;
  mimeType: string;
  storedSizeBytes: number;
  hasThumbnail?: boolean;
  width?: number;
  height?: number;
  durationSeconds?: number;
  createdAt: string;
  updatedAt: string;
};

export type FileAccessMetadata = FilePublicMetadata & { encryptionManifest: FileManifest;
  thumbnail?: { storedSizeBytes: number; encryptionManifest: FileManifest } };
