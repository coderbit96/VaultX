import { ObjectId, type ClientSession, type Db } from "mongodb";
import type { EncryptedFolderName } from "@/lib/crypto/folder-name-schema";
import { getModelCollections, type Folder } from "./models";

export class AlbumOperationError extends Error {
  constructor(readonly code: "not_found" | "invalid_request" | "conflict" | "unavailable") { super(code); }
}

const MAX_ALBUMS = 100;
const MAX_ALBUM_FOLDERS = 10_000;
const MAX_ALBUM_FILES = 10_000;

async function mutate<T>(db: Db, ownerId: ObjectId, action: (session: ClientSession) => Promise<T>): Promise<T> {
  const result = await db.client.withSession((session) => session.withTransaction(async () => {
    const owner = await getModelCollections(db).owners.updateOne({ _id: ownerId, singletonKey: "vaultx-owner" },
      { $inc: { folderTreeRevision: 1 } }, { session });
    if (owner.matchedCount !== 1) throw new AlbumOperationError("unavailable");
    return action(session);
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
  if (result === undefined) throw new AlbumOperationError("unavailable");
  return result;
}

async function assertVaultEnvelope(db: Db, ownerId: ObjectId, name: EncryptedFolderName, session: ClientSession) {
  const vault = await getModelCollections(db).vaultKeys.findOne({ ownerId }, { session, projection: { vaultId: 1 } });
  if (!vault || vault.vaultId !== name.vaultId) throw new AlbumOperationError("invalid_request");
}

function asPublicAlbum(album: Folder, counts: Map<string, { image: number; video: number }>, coverIds: Set<string>) {
  const count = counts.get(album._id.toHexString()) ?? { image: 0, video: 0 };
  return {
    id: album._id.toHexString(), nameEncrypted: album.nameEncrypted,
    ...(album.descriptionEncrypted ? { descriptionEncrypted: album.descriptionEncrypted } : {}),
    ...(album.coverMediaId && coverIds.has(album.coverMediaId.toHexString()) ? { coverMediaId: album.coverMediaId.toHexString() } : {}),
    counts: { image: count.image, video: count.video },
    createdAt: album.createdAt.toISOString(), updatedAt: album.updatedAt.toISOString(),
  };
}

/** Root folders are the existing vault's albums. No duplicate collection is created. */
export async function listAlbums(db: Db, ownerId: ObjectId) {
  const { folders, files } = getModelCollections(db);
  const albums = await folders.find({ ownerId, parentFolderId: null, status: "active" }, {
    projection: { _id: 1, nameEncrypted: 1, descriptionEncrypted: 1, coverMediaId: 1, createdAt: 1, updatedAt: 1 },
  }).sort({ createdAt: -1, _id: -1 }).limit(MAX_ALBUMS + 1).toArray();
  if (albums.length > MAX_ALBUMS) throw new AlbumOperationError("unavailable");
  const ids = albums.map((album) => album._id);
  const rows = await files.aggregate<{ _id: { folderId: ObjectId | null; category: "image" | "video" }; count: number }>([
    { $match: { ownerId, status: "ready", category: { $in: ["image", "video"] }, folderId: { $in: [...ids, null] },
      storedSizeBytes: { $gt: 0 }, "cloudinary.resourceType": "raw", "cloudinary.deliveryType": "authenticated",
      "cloudinary.assetId": { $type: "string" }, "cloudinary.format": "dat",
      "cloudinary.publicId": { $regex: /^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/ },
      "encryptionManifest.kind": "file",
      $expr: { $eq: ["$encryptionManifest.objectBytes", { $toString: "$storedSizeBytes" }] } } },
    { $group: { _id: { folderId: "$folderId", category: "$category" }, count: { $sum: 1 } } },
  ], { maxTimeMS: 5_000 }).toArray();
  const counts = new Map<string, { image: number; video: number }>();
  const unorganized = { image: 0, video: 0 };
  for (const row of rows) {
    if (!row._id.folderId) { unorganized[row._id.category] = row.count; continue; }
    const key = row._id.folderId.toHexString();
    const entry = counts.get(key) ?? { image: 0, video: 0 };
    entry[row._id.category] = row.count;
    counts.set(key, entry);
  }
  const candidates = albums.flatMap((album) => album.coverMediaId ? [album.coverMediaId] : []);
  const covers = candidates.length ? await files.find({ _id: { $in: candidates }, ownerId, status: "ready", category: "image",
    "cloudinary.resourceType": "raw", "cloudinary.deliveryType": "authenticated", "encryptionManifest.kind": "file",
    folderId: { $in: ids } }, { projection: { _id: 1, folderId: 1 } }).toArray() : [];
  const coverIds = new Set(covers.filter((file) => file.folderId && albums.some((album) => album._id.equals(file.folderId)
    && album.coverMediaId?.equals(file._id))).map((file) => file._id.toHexString()));
  return { albums: albums.map((album) => asPublicAlbum(album, counts, coverIds)), unorganized };
}

export async function createAlbum(db: Db, ownerId: ObjectId, id: ObjectId, nameEncrypted: EncryptedFolderName,
  descriptionEncrypted?: EncryptedFolderName) {
  return mutate(db, ownerId, async (session) => {
    await assertVaultEnvelope(db, ownerId, nameEncrypted, session);
    if (descriptionEncrypted && descriptionEncrypted.vaultId !== nameEncrypted.vaultId) throw new AlbumOperationError("invalid_request");
    const now = new Date();
    const album: Folder = { _id: id, ownerId, parentFolderId: null, nameEncrypted,
      ...(descriptionEncrypted ? { descriptionEncrypted } : {}), status: "active", createdAt: now, updatedAt: now };
    await getModelCollections(db).folders.insertOne(album, { session });
    return album;
  });
}

export async function changeAlbum(db: Db, ownerId: ObjectId, id: ObjectId,
  change: { nameEncrypted?: EncryptedFolderName; descriptionEncrypted?: EncryptedFolderName | null; coverMediaId?: ObjectId | null }) {
  return mutate(db, ownerId, async (session) => {
    const { folders, files } = getModelCollections(db);
    const current = await folders.findOne({ _id: id, ownerId, parentFolderId: null, status: "active" }, { session });
    if (!current) throw new AlbumOperationError("not_found");
    const name = change.nameEncrypted ?? current.nameEncrypted;
    await assertVaultEnvelope(db, ownerId, name, session);
    if (change.descriptionEncrypted && change.descriptionEncrypted.vaultId !== name.vaultId) throw new AlbumOperationError("invalid_request");
    if (change.coverMediaId) {
      const cover = await files.findOne({ _id: change.coverMediaId, ownerId, folderId: id, status: "ready", category: "image",
        "cloudinary.resourceType": "raw", "cloudinary.deliveryType": "authenticated", "encryptionManifest.kind": "file" },
        { session, projection: { _id: 1 } });
      if (!cover) throw new AlbumOperationError("not_found");
    }
    const update = {
      ...(change.nameEncrypted ? { nameEncrypted: change.nameEncrypted } : {}),
      ...(change.descriptionEncrypted ? { descriptionEncrypted: change.descriptionEncrypted } : {}),
      ...(change.coverMediaId ? { coverMediaId: change.coverMediaId } : {}),
      updatedAt: new Date(),
    };
    const result = await folders.findOneAndUpdate({ _id: id, ownerId, parentFolderId: null, status: "active" },
      { $set: update, ...(change.descriptionEncrypted === null ? { $unset: { descriptionEncrypted: "" } } : {}),
        ...(change.coverMediaId === null ? { $unset: { coverMediaId: "" } } : {}) }, { session, returnDocument: "after" });
    if (!result) throw new AlbumOperationError("not_found");
    return result;
  });
}

async function albumTree(db: Db, ownerId: ObjectId, root: ObjectId, session: ClientSession) {
  const { folders } = getModelCollections(db);
  const records: Folder[] = [];
  const seen = new Set<string>();
  let frontier = [root];
  for (let depth = 0; frontier.length; depth++) {
    if (depth >= 128 || records.length >= MAX_ALBUM_FOLDERS) throw new AlbumOperationError("conflict");
    const current = await folders.find({ ownerId, _id: { $in: frontier }, status: "active" }, { session }).toArray();
    if (current.length !== frontier.length || current.some((folder) => seen.has(folder._id.toHexString()))) throw new AlbumOperationError("conflict");
    current.forEach((folder) => seen.add(folder._id.toHexString()));
    if (records.length + current.length > MAX_ALBUM_FOLDERS) throw new AlbumOperationError("conflict");
    records.push(...current);
    const ids = current.map((folder) => folder._id);
    frontier = (await folders.find({ ownerId, parentFolderId: { $in: ids } }, { session, projection: { _id: 1, status: 1 } }).toArray())
      .map((folder) => { if (folder.status !== "active") throw new AlbumOperationError("conflict"); return folder._id; });
  }
  return records;
}

/** Remove only album organization. Ciphertext assets and ready media stay intact and become Unorganized. */
export async function removeAlbum(db: Db, ownerId: ObjectId, id: ObjectId) {
  return mutate(db, ownerId, async (session) => {
    const { folders, files, uploadJobs } = getModelCollections(db);
    const root = await folders.findOne({ _id: id, ownerId, parentFolderId: null, status: "active" }, { session });
    if (!root) throw new AlbumOperationError("not_found");
    const tree = await albumTree(db, ownerId, id, session);
    const folderIds = tree.map((folder) => folder._id);
    const fileRecords = await files.find({ ownerId, folderId: { $in: folderIds } }, { session, projection: { _id: 1, status: 1 } })
      .limit(MAX_ALBUM_FILES + 1).toArray();
    if (fileRecords.length > MAX_ALBUM_FILES || fileRecords.some((file) => file.status !== "ready")) throw new AlbumOperationError("conflict");
    const inFlight = await uploadJobs.find({ ownerId, folderId: { $in: folderIds }, status: { $nin: ["completed", "cancelled"] } },
      { session, projection: { _id: 1 } }).limit(1).toArray();
    if (inFlight.length) throw new AlbumOperationError("conflict");
    const now = new Date();
    if (fileRecords.length) {
      const moved = await files.updateMany({ _id: { $in: fileRecords.map((file) => file._id) }, ownerId, status: "ready" },
        { $set: { folderId: null, updatedAt: now } }, { session });
      if (moved.matchedCount !== fileRecords.length) throw new AlbumOperationError("conflict");
    }
    const removed = await folders.deleteMany({ _id: { $in: folderIds }, ownerId, status: "active" }, { session });
    if (removed.deletedCount !== folderIds.length) throw new AlbumOperationError("conflict");
    return { movedMedia: fileRecords.length, removedFolders: folderIds.length };
  });
}
