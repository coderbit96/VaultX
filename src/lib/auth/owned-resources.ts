import { type Db, type ObjectId } from "mongodb";
import { getModelCollections } from "@/lib/database/models";
import { parseObjectId } from "./request-validation";

// Every lookup is scoped by the owner derived from the server-side session.
// Client-supplied ownerId, folderId, or Cloudinary publicId is never a selector.
export async function findOwnedFile(db: Db, ownerId: ObjectId, rawId: unknown) {
  const id = parseObjectId(rawId);
  return id ? getModelCollections(db).files.findOne({ _id: id, ownerId }) : null;
}

export async function findOwnedFolder(db: Db, ownerId: ObjectId, rawId: unknown) {
  const id = parseObjectId(rawId);
  return id ? getModelCollections(db).folders.findOne({ _id: id, ownerId }) : null;
}

export async function findOwnedUploadJob(db: Db, ownerId: ObjectId, rawId: unknown) {
  const id = parseObjectId(rawId);
  return id ? getModelCollections(db).uploadJobs.findOne({ _id: id, ownerId }) : null;
}

export async function findOwnedDeletionJob(db: Db, ownerId: ObjectId, rawId: unknown) {
  const id = parseObjectId(rawId);
  return id ? getModelCollections(db).deletionJobs.findOne({ _id: id, ownerId }) : null;
}

export async function findOwnedActiveFolderId(db: Db, ownerId: ObjectId, rawId: unknown): Promise<ObjectId | null> {
  const folder = await findOwnedFolder(db, ownerId, rawId);
  return folder?.status === "active" ? folder._id : null;
}

export async function findOwnedReadyCloudAsset(db: Db, ownerId: ObjectId, rawFileId: unknown) {
  const file = await findOwnedFile(db, ownerId, rawFileId);
  return file?.status === "ready" ? file.cloudinary ?? null : null;
}
