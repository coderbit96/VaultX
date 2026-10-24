import { ObjectId, type ClientSession, type Db } from "mongodb";
import { getModelCollections, folderSchema, type Folder } from "./models";
import type { EncryptedFolderName } from "@/lib/crypto/folder-name-schema";

export class FolderOperationError extends Error {
  constructor(readonly code: "not_found" | "invalid_request" | "unavailable") { super(code); }
}

const MAX_DEPTH = 128;
const MAX_SUBTREE = 10_000;

// Walk by stable IDs, with owner on every lookup. This detects corrupt legacy
// cycles and refuses to change a tree being deleted.
export async function activeAncestry(db: Db, ownerId: ObjectId, start: ObjectId | null, session?: ClientSession): Promise<Folder[]> {
  const path: Folder[] = [];
  const seen = new Set<string>();
  let current = start;
  while (current) {
    if (path.length >= MAX_DEPTH || seen.has(current.toHexString())) throw new FolderOperationError("invalid_request");
    seen.add(current.toHexString());
    const folder = await getModelCollections(db).folders.findOne({ _id: current, ownerId }, { session });
    if (!folder || folder.status !== "active") throw new FolderOperationError("not_found");
    path.push(folder);
    current = folder.parentFolderId;
  }
  return path;
}

async function subtreeHeight(db: Db, ownerId: ObjectId, root: ObjectId, session: ClientSession): Promise<number> {
  const { folders } = getModelCollections(db);
  let frontier = [root];
  let height = 0;
  let visited = 0;
  while (frontier.length) {
    if (height >= MAX_DEPTH || visited > MAX_SUBTREE) throw new FolderOperationError("invalid_request");
    const children = await folders.find({ ownerId, parentFolderId: { $in: frontier } }, { session,
      projection: { _id: 1, status: 1 } }).toArray();
    if (children.some((child) => child.status !== "active")) throw new FolderOperationError("not_found");
    visited += children.length;
    frontier = children.map((child) => child._id);
    height++;
  }
  return height;
}

async function mutate<T>(db: Db, ownerId: ObjectId, action: (session: ClientSession) => Promise<T>): Promise<T> {
  const result = await db.client.withSession(async (session) => session.withTransaction(async () => {
    // Every folder mutation writes this owner document before reading the tree.
    // Concurrent moves contend on one document and retry against a fresh view.
    const owner = await getModelCollections(db).owners.updateOne({ _id: ownerId, singletonKey: "vaultx-owner" },
      { $inc: { folderTreeRevision: 1 } }, { session });
    if (owner.matchedCount !== 1) throw new FolderOperationError("unavailable");
    return action(session);
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
  if (result === undefined) throw new FolderOperationError("unavailable");
  return result;
}

export async function listFolders(db: Db, ownerId: ObjectId, parentId: ObjectId | null, after?: ObjectId) {
  const path = await activeAncestry(db, ownerId, parentId);
  const { folders } = getModelCollections(db);
  const entries = await folders.find({ ownerId, parentFolderId: parentId, status: "active", ...(after ? { _id: { $gt: after } } : {}) },
    { projection: { _id: 1, parentFolderId: 1, nameEncrypted: 1, createdAt: 1, updatedAt: 1 } })
    .sort({ _id: 1 }).limit(101).toArray();
  return { path: path.reverse(), folders: entries.slice(0, 100), nextCursor: entries.length > 100 ? entries[99]._id.toHexString() : null };
}

export async function createFolder(db: Db, ownerId: ObjectId, id: ObjectId, parentId: ObjectId | null, nameEncrypted: EncryptedFolderName) {
  return mutate(db, ownerId, async (session) => {
    const vault = await getModelCollections(db).vaultKeys.findOne({ ownerId }, { session, projection: { vaultId: 1 } });
    if (!vault || vault.vaultId !== nameEncrypted.vaultId) throw new FolderOperationError("invalid_request");
    const path = await activeAncestry(db, ownerId, parentId, session);
    if (path.length >= MAX_DEPTH) throw new FolderOperationError("invalid_request");
    const now = new Date();
    const record = folderSchema.parse({ _id: id, ownerId, parentFolderId: parentId, nameEncrypted,
      status: "active", createdAt: now, updatedAt: now });
    await getModelCollections(db).folders.insertOne(record, { session });
    return record;
  });
}

export async function changeFolder(db: Db, ownerId: ObjectId, id: ObjectId,
  change: { nameEncrypted?: EncryptedFolderName; parentFolderId?: ObjectId | null }) {
  return mutate(db, ownerId, async (session) => {
    if (change.nameEncrypted) {
      const vault = await getModelCollections(db).vaultKeys.findOne({ ownerId }, { session, projection: { vaultId: 1 } });
      if (!vault || vault.vaultId !== change.nameEncrypted.vaultId) throw new FolderOperationError("invalid_request");
    }
    const { folders } = getModelCollections(db);
    const current = await folders.findOne({ _id: id, ownerId, status: "active" }, { session });
    if (!current) throw new FolderOperationError("not_found");
    await activeAncestry(db, ownerId, current.parentFolderId, session);
    if ("parentFolderId" in change) {
      const parentId = change.parentFolderId ?? null;
      const path = await activeAncestry(db, ownerId, parentId, session);
      if (path.some((folder) => folder._id.equals(id))) throw new FolderOperationError("invalid_request");
      const height = await subtreeHeight(db, ownerId, id, session);
      if (path.length + height > MAX_DEPTH) throw new FolderOperationError("invalid_request");
    }
    const update = { ...(change.nameEncrypted ? { nameEncrypted: change.nameEncrypted } : {}),
      ...(Object.hasOwn(change, "parentFolderId") ? { parentFolderId: change.parentFolderId ?? null } : {}),
      updatedAt: new Date() };
    const result = await folders.findOneAndUpdate({ _id: id, ownerId, status: "active" }, { $set: update },
      { session, returnDocument: "after" });
    if (!result) throw new FolderOperationError("not_found");
    return result;
  });
}
