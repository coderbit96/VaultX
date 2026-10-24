import { type Db, type ObjectId } from "mongodb";
import { hasVerifiedCiphertext, publicFileMetadata } from "./files";
import { FolderOperationError } from "./folders";
import { getModelCollections, type Folder, type VaultFile } from "./models";

type Category = VaultFile["category"];
type Counts = { fileCount: number; folderCount: number };

export async function summarizeStoredFiles(files: AsyncIterable<VaultFile>, folders: Folder[], ownerId: ObjectId, selectedId: ObjectId | null) {
  const ownedFolders = folders.filter((folder) => folder.ownerId.equals(ownerId));
  const byId = new Map(ownedFolders.map((folder) => [folder._id.toHexString(), folder]));
  const active = new Map<string, boolean>();
  const isActive = (id: string, seen = new Set<string>()): boolean => {
    if (active.has(id)) return active.get(id)!;
    if (seen.has(id)) return false;
    const folder = byId.get(id);
    if (!folder || folder.status !== "active") return false;
    seen.add(id);
    const valid = !folder.parentFolderId || isActive(folder.parentFolderId.toHexString(), seen);
    active.set(id, valid);
    return valid;
  };
  if (selectedId && !isActive(selectedId.toHexString())) throw new FolderOperationError("not_found");
  const counts = new Map<string, Counts>();
  const countFor = (id: string) => {
    let count = counts.get(id);
    if (!count) { count = { fileCount: 0, folderCount: 0 }; counts.set(id, count); }
    return count;
  };
  for (const folder of ownedFolders) {
    if (isActive(folder._id.toHexString())) countFor(folder.parentFolderId?.toHexString() ?? "root").folderCount++;
  }
  const byCategory: Record<Category, number> = { image: 0, video: 0, audio: 0, document: 0, other: 0 };
  let fileCount = 0;
  let storedBytes = 0;
  let thumbnailBytes = 0;
  const recent: ReturnType<typeof publicFileMetadata>[] = [];
  for await (const file of files) {
    if (!file.ownerId.equals(ownerId) || !hasVerifiedCiphertext(file) || (file.folderId && !isActive(file.folderId.toHexString()))) continue;
    const next = storedBytes + file.storedSizeBytes!;
    if (!Number.isSafeInteger(next)) throw new Error("Storage total overflow");
    storedBytes = next;
    fileCount++;
    byCategory[file.category]++;
    countFor(file.folderId?.toHexString() ?? "root").fileCount++;
    if (file.thumbnail && file.thumbnail.cloudinary.assetId
      && file.thumbnail.cloudinary.resourceType === "raw" && file.thumbnail.cloudinary.deliveryType === "authenticated"
      && file.thumbnail.encryptionManifest.objectBytes === String(file.thumbnail.storedSizeBytes)) {
      thumbnailBytes += file.thumbnail.storedSizeBytes;
      if (!Number.isSafeInteger(thumbnailBytes)) throw new Error("Storage total overflow");
    }
    // The database cursor is newest first. Never send a filename in plaintext.
    if (recent.length < 8) recent.push(publicFileMetadata(file));
  }
  const path: Array<{ folderId: string | null; fileCount: number; folderCount: number }> = [];
  let current = selectedId?.toHexString() ?? null;
  while (true) {
    path.push({ folderId: current, ...countFor(current ?? "root") });
    if (!current) break;
    current = byId.get(current)?.parentFolderId?.toHexString() ?? null;
  }
  path.reverse();
  if (!Number.isSafeInteger(storedBytes + thumbnailBytes)) throw new Error("Storage total overflow");
  return { fileCount, storedBytes: storedBytes + thumbnailBytes, fileBytes: storedBytes, thumbnailBytes, byCategory, recent, breadcrumbCounts: path };
}

export async function getStorageSummary(db: Db, ownerId: ObjectId, selectedId: ObjectId | null) {
  const { files, folders } = getModelCollections(db);
  const ownedFolders = await folders.find({ ownerId }, { projection: { _id: 1, ownerId: 1, parentFolderId: 1, status: 1 } }).toArray();
  const readyFiles = files.find({ ownerId, status: "ready" }, { projection: {
    _id: 1, ownerId: 1, folderId: 1, status: 1, cloudinary: 1, encryptionManifest: 1,
    nameEncrypted: 1, extension: 1, category: 1, mimeType: 1, storedSizeBytes: 1,
    thumbnail: 1, width: 1, height: 1, durationSeconds: 1, createdAt: 1, updatedAt: 1,
  } }).sort({ createdAt: -1, _id: -1 });
  try { return await summarizeStoredFiles(readyFiles, ownedFolders, ownerId, selectedId); }
  finally { await readyFiles.close(); }
}
