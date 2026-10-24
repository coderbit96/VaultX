import { ObjectId, type Db, type Filter } from "mongodb";
import { z } from "zod";
import { activeAncestry, FolderOperationError } from "./folders";
import { getModelCollections, type VaultFile } from "./models";
import { encryptedNameSchema, type EncryptedName } from "@/lib/crypto/folder-name-schema";

export const fileCategorySchema = z.enum(["image", "video", "audio", "document", "other"]);
export type FileCategory = z.infer<typeof fileCategorySchema>;

const PAGE_SIZE = 100;
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime({ offset: false }), id: z.string().regex(/^[a-f0-9]{24}$/) });
export type FileCursor = { createdAt: Date; id: ObjectId };

export function parseFileCursor(raw: string): FileCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (!parsed.success) return null;
    const date = new Date(parsed.data.createdAt);
    if (date.toISOString() !== parsed.data.createdAt) return null;
    return { createdAt: date, id: new ObjectId(parsed.data.id) };
  } catch { return null; }
}

export function encodeFileCursor(file: Pick<VaultFile, "createdAt" | "_id">): string {
  return Buffer.from(JSON.stringify({ createdAt: file.createdAt.toISOString(), id: file._id.toHexString() })).toString("base64url");
}

function hasStoredObject(file: VaultFile): boolean {
  return !!file.cloudinary?.publicId && Number.isSafeInteger(file.storedSizeBytes) && (file.storedSizeBytes ?? 0) > 0;
}

// Ready rows are counted only when they carry the identity and byte manifest
// confirmed by upload completion. Historical incomplete rows are excluded.
export function hasVerifiedCiphertext(file: VaultFile): boolean {
  return file.status === "ready" && hasStoredObject(file)
    && file.cloudinary?.resourceType === "raw" && file.cloudinary.deliveryType === "authenticated"
    && !!file.cloudinary.assetId && file.cloudinary.format === "dat"
    && "kind" in file.encryptionManifest && file.encryptionManifest.kind === "file"
    && file.encryptionManifest.objectBytes === String(file.storedSizeBytes);
}

export class FileOperationError extends Error {
  constructor(readonly code: "not_found" | "invalid_request" | "unavailable") { super(code); }
}

export async function changeFile(db: Db, ownerId: ObjectId, id: ObjectId,
  change: { nameEncrypted?: EncryptedName; folderId?: ObjectId | null; favorite?: boolean; tagsEncrypted?: EncryptedName[] }) {
  const result = await db.client.withSession(async (session) => session.withTransaction(async () => {
    // Serialize with folder moves/deletion transitions before checking ancestry.
    const owner = await getModelCollections(db).owners.updateOne({ _id: ownerId, singletonKey: "vaultx-owner" },
      { $inc: { folderTreeRevision: 1 } }, { session });
    if (owner.matchedCount !== 1) throw new FileOperationError("unavailable");
    const { files, vaultKeys } = getModelCollections(db);
    const current = await files.findOne({ _id: id, ownerId, status: "ready" }, { session });
    if (!current || !hasVerifiedCiphertext(current)) throw new FileOperationError("not_found");
    await activeAncestry(db, ownerId, current.folderId, session);
    if (change.favorite !== undefined && typeof change.favorite !== "boolean") throw new FileOperationError("invalid_request");
    if (change.tagsEncrypted && (change.tagsEncrypted.length > 20
      || change.tagsEncrypted.some((tag) => !encryptedNameSchema.safeParse(tag).success
        || tag.vaultId !== current.nameEncrypted.vaultId))) throw new FileOperationError("invalid_request");
    if (change.nameEncrypted || change.tagsEncrypted?.length) {
      const vault = await vaultKeys.findOne({ ownerId }, { session, projection: { vaultId: 1 } });
      if (!vault || vault.vaultId !== current.nameEncrypted.vaultId
        || (change.nameEncrypted && vault.vaultId !== change.nameEncrypted.vaultId)) throw new FileOperationError("invalid_request");
    }
    if (Object.hasOwn(change, "folderId")) await activeAncestry(db, ownerId, change.folderId ?? null, session);
    const updated = await files.findOneAndUpdate({ _id: id, ownerId, status: "ready" }, { $set: {
      ...(change.nameEncrypted ? { nameEncrypted: change.nameEncrypted } : {}),
      ...(change.tagsEncrypted ? { tagsEncrypted: change.tagsEncrypted } : {}),
      ...(Object.hasOwn(change, "folderId") ? { folderId: change.folderId ?? null } : {}),
      ...(change.favorite !== undefined ? { favorite: change.favorite } : {}),
      updatedAt: new Date(),
    } }, { session, returnDocument: "after" });
    if (!updated) throw new FileOperationError("not_found");
    return publicFileMetadata(updated);
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
  if (!result) throw new FileOperationError("unavailable");
  return result;
}

export function publicFileMetadata(file: VaultFile) {
  return {
    id: file._id.toHexString(), folderId: file.folderId?.toHexString() ?? null,
    nameEncrypted: file.nameEncrypted, extension: file.extension, category: file.category,
    ...(file.tagsEncrypted ? { tagsEncrypted: file.tagsEncrypted } : {}), favorite: file.favorite ?? false,
    mimeType: file.mimeType, storedSizeBytes: file.storedSizeBytes!,
    hasThumbnail: !!file.thumbnail,
    ...(file.width ? { width: file.width } : {}), ...(file.height ? { height: file.height } : {}),
    ...(file.durationSeconds ? { durationSeconds: file.durationSeconds } : {}),
    createdAt: file.createdAt.toISOString(), updatedAt: file.updatedAt.toISOString(),
  };
}

export async function listReadyFiles(db: Db, ownerId: ObjectId,
  options: { folderId: ObjectId | null; allFolders?: boolean; category?: FileCategory; after?: FileCursor }) {
  if (!options.allFolders) await activeAncestry(db, ownerId, options.folderId);
  const filter: Filter<VaultFile> = {
    ownerId, status: "ready",
    ...(!options.allFolders ? { folderId: options.folderId } : {}),
    ...(options.category ? { category: options.category } : {}),
    ...(options.after ? { $or: [
      { createdAt: { $lt: options.after.createdAt } },
      { createdAt: options.after.createdAt, _id: { $lt: options.after.id } },
    ] } : {}),
  };
  const records = await getModelCollections(db).files.find(filter, { projection: {
    _id: 1, folderId: 1, nameEncrypted: 1, tagsEncrypted: 1, favorite: 1, extension: 1, category: 1, mimeType: 1,
    storedSizeBytes: 1, cloudinary: 1, width: 1, height: 1, durationSeconds: 1, createdAt: 1, updatedAt: 1,
  } }).sort({ createdAt: -1, _id: -1 }).limit(PAGE_SIZE + 1).toArray();
  const page = records.slice(0, PAGE_SIZE);
  const visible: VaultFile[] = [];
  for (const file of page) {
    if (!hasStoredObject(file)) continue;
    if (options.allFolders && file.folderId) {
      try { await activeAncestry(db, ownerId, file.folderId); }
      catch (error) { if (error instanceof FolderOperationError) continue; throw error; }
    }
    visible.push(file);
  }
  return { files: visible.map(publicFileMetadata), nextCursor: records.length > PAGE_SIZE ? encodeFileCursor(page[page.length - 1]) : null };
}

export async function findReadyFileDetails(db: Db, ownerId: ObjectId, id: ObjectId) {
  const file = await getModelCollections(db).files.findOne({ _id: id, ownerId, status: "ready" });
  if (!file || !hasStoredObject(file)) return null;
  try { await activeAncestry(db, ownerId, file.folderId); }
  catch (error) { if (error instanceof FolderOperationError) return null; throw error; }
  return publicFileMetadata(file);
}

// The browser needs this wrapped manifest to decrypt on-device. It deliberately
// omits the Cloudinary identity and all server-only provider details.
export async function findReadyFileAccessMetadata(db: Db, ownerId: ObjectId, id: ObjectId) {
  const file = await findOwnedReadyCiphertextFile(db, ownerId, id);
  if (!file || !("kind" in file.encryptionManifest) || file.encryptionManifest.kind !== "file") return null;
  return { ...publicFileMetadata(file), encryptionManifest: file.encryptionManifest,
    ...(file.thumbnail ? { thumbnail: { storedSizeBytes: file.thumbnail.storedSizeBytes,
      encryptionManifest: file.thumbnail.encryptionManifest } } : {}) };
}

// This returns the private storage identity only after the same ownership,
// ready-state and active-folder checks used by visible file metadata. It must
// only be used by a server-side ciphertext gateway.
export async function findOwnedReadyCiphertextFile(db: Db, ownerId: ObjectId, id: ObjectId): Promise<VaultFile | null> {
  const file = await getModelCollections(db).files.findOne({ _id: id, ownerId, status: "ready" });
  if (!file || !hasVerifiedCiphertext(file) || !file.cloudinary
    || !/^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/.test(file.cloudinary.publicId)) return null;
  try { await activeAncestry(db, ownerId, file.folderId); }
  catch (error) { if (error instanceof FolderOperationError) return null; throw error; }
  return file;
}
