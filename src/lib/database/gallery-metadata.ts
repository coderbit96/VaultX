import { ObjectId, type Db } from "mongodb";
import type { QueryFilter } from "mongoose";
import { z } from "zod";
import { activeAncestry, FolderOperationError } from "./folders";
import { changeFile, hasVerifiedCiphertext, publicFileMetadata } from "./files";
import { fileSchema, folderSchema, getModelCollections, type Folder, type VaultFile } from "./models";
import { getGalleryConnection } from "./gallery-connection";
import { getGalleryModels } from "@/models/gallery";

export class GalleryMetadataError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "unavailable") { super(code); }
}

const dateCursorSchema = z.strictObject({ sort: z.enum(["newest", "oldest"]), createdAt: z.date(), id: z.instanceof(ObjectId) });
const sizeCursorSchema = z.strictObject({ sort: z.literal("size"), storedSizeBytes: z.number().int().positive(), id: z.instanceof(ObjectId) });
const cursorSchema = z.union([dateCursorSchema, sizeCursorSchema]);
export const gallerySortSchema = z.enum(["newest", "oldest", "size"]);
export type GallerySortOrder = z.infer<typeof gallerySortSchema>;
export type GalleryCursor = z.infer<typeof cursorSchema>;
const cursorWireSchema = z.discriminatedUnion("sort", [
  z.strictObject({ sort: z.literal("newest"), createdAt: z.iso.datetime({ offset: false }), id: z.string().regex(/^[a-f0-9]{24}$/) }),
  z.strictObject({ sort: z.literal("oldest"), createdAt: z.iso.datetime({ offset: false }), id: z.string().regex(/^[a-f0-9]{24}$/) }),
  z.strictObject({ sort: z.literal("size"), storedSizeBytes: z.number().int().positive(), id: z.string().regex(/^[a-f0-9]{24}$/) }),
]);

export function parseGalleryCursor(raw: string, sort: GallerySortOrder): GalleryCursor | null {
  if (!/^[A-Za-z0-9_-]{1,240}$/.test(raw)) return null;
  try {
    const value = cursorWireSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (!value.success || value.data.sort !== sort) return null;
    if (Buffer.from(JSON.stringify(value.data)).toString("base64url") !== raw) return null;
    const id = new ObjectId(value.data.id);
    return value.data.sort === "size" ? { sort: "size", storedSizeBytes: value.data.storedSizeBytes, id }
      : { sort: value.data.sort, createdAt: new Date(value.data.createdAt), id };
  } catch { return null; }
}

export function encodeGalleryCursor(file: Pick<VaultFile, "_id" | "createdAt" | "storedSizeBytes">, sort: GallerySortOrder): string {
  const value = sort === "size" ? { sort, storedSizeBytes: file.storedSizeBytes, id: file._id.toHexString() }
    : { sort, createdAt: file.createdAt.toISOString(), id: file._id.toHexString() };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export const mediaPageOptionsSchema = z.strictObject({
  albumId: z.instanceof(ObjectId).nullable().optional(), // undefined: all albums, null: root
  category: z.enum(["image", "video"]).optional(),
  favoriteOnly: z.boolean().optional(),
  sort: gallerySortSchema.optional(),
  after: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).refine((value) => !value.after || value.after.sort === (value.sort ?? "newest"), { path: ["after"] });
export const albumPageOptionsSchema = z.strictObject({
  parentId: z.instanceof(ObjectId).nullable(),
  after: z.instanceof(ObjectId).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type MediaPageOptions = z.infer<typeof mediaPageOptionsSchema>;

const mediaProjection = {
  _id: 1, ownerId: 1, folderId: 1, nameEncrypted: 1, tagsEncrypted: 1, favorite: 1,
  extension: 1, category: 1, mimeType: 1, storedSizeBytes: 1, cloudinary: 1,
  encryptedFileKey: 1, encryptionManifest: 1, thumbnail: 1, status: 1,
  width: 1, height: 1, durationSeconds: 1, createdAt: 1, updatedAt: 1,
} as const;

function pageLimit(value: number | undefined): number {
  return value ?? 50;
}

async function visibleFolders(db: Db, ownerId: ObjectId, files: VaultFile[]): Promise<Set<string>> {
  const roots = new Set(files.map((file) => file.folderId?.toHexString()).filter((id): id is string => !!id));
  const ancestry = new Map<string, { parent: string | null; active: boolean }>();
  let frontier = [...roots];
  for (let depth = 0; frontier.length && depth < 128; depth++) {
    const ids = frontier.filter((id) => !ancestry.has(id));
    if (!ids.length) break;
    const found = await getModelCollections(db).folders.find({ ownerId, _id: { $in: ids.map((id) => new ObjectId(id)) } },
      { projection: { _id: 1, parentFolderId: 1, status: 1 } }).toArray();
    const byId = new Map(found.map((folder) => [folder._id.toHexString(), folder]));
    frontier = [];
    for (const id of ids) {
      const folder = byId.get(id);
      const parent = folder?.parentFolderId?.toHexString() ?? null;
      ancestry.set(id, { parent, active: folder?.status === "active" });
      if (parent && !ancestry.has(parent)) frontier.push(parent);
    }
  }
  const visible = new Set<string>();
  for (const root of roots) {
    const seen = new Set<string>();
    let current: string | null = root;
    while (current && !seen.has(current) && seen.size < 128) {
      seen.add(current);
      const entry = ancestry.get(current);
      if (!entry?.active) break;
      current = entry.parent;
    }
    if (!current) visible.add(root);
  }
  return visible;
}

/** Indexed keyset paging; names/tags remain ciphertext and are searched in the unlocked browser. */
export async function listGalleryMedia(db: Db, ownerId: ObjectId, options: MediaPageOptions = {}) {
  const input = mediaPageOptionsSchema.safeParse(options);
  if (!input.success) throw new GalleryMetadataError("invalid_request");
  options = input.data;
  const limit = pageLimit(options.limit);
  const sort = options.sort ?? "newest";
  if (options.albumId !== undefined) {
    try { await activeAncestry(db, ownerId, options.albumId); }
    catch (error) { if (error instanceof FolderOperationError) throw new GalleryMetadataError("not_found"); throw new GalleryMetadataError("unavailable"); }
  }
  const position: QueryFilter<VaultFile> = !options.after ? {} : options.after.sort === "size" ? { $or: [
    { storedSizeBytes: { $lt: options.after.storedSizeBytes } },
    { storedSizeBytes: options.after.storedSizeBytes, _id: { $lt: options.after.id } },
  ] } : options.after.sort === "oldest" ? { $or: [
    { createdAt: { $gt: options.after.createdAt } },
    { createdAt: options.after.createdAt, _id: { $gt: options.after.id } },
  ] } : { $or: [
    { createdAt: { $lt: options.after.createdAt } },
    { createdAt: options.after.createdAt, _id: { $lt: options.after.id } },
  ] };
  const filter: QueryFilter<VaultFile> = { ownerId, status: "ready", storedSizeBytes: { $gt: 0 },
    "cloudinary.resourceType": "raw", "cloudinary.deliveryType": "authenticated",
    "cloudinary.assetId": { $type: "string" }, "cloudinary.format": "dat",
    "cloudinary.publicId": { $regex: /^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/ },
    "encryptionManifest.kind": "file",
    category: options.category ?? { $in: ["image", "video"] as const },
    ...(options.albumId !== undefined ? { folderId: options.albumId } : {}),
    ...(options.favoriteOnly ? { favorite: true } : {}),
    ...position,
  };
  try {
    const { Media } = getGalleryModels(await getGalleryConnection());
    const records = await Media.find(filter, mediaProjection)
      .sort(sort === "size" ? { storedSizeBytes: -1, _id: -1 } : { createdAt: sort === "oldest" ? 1 : -1, _id: sort === "oldest" ? 1 : -1 })
      .limit(limit + 1).lean<VaultFile[]>().maxTimeMS(5_000);
    const page = records.slice(0, limit);
    const active = options.albumId === undefined ? await visibleFolders(db, ownerId, page) : null;
    return {
      media: page.filter((file) => fileSchema.safeParse(file).success && hasVerifiedCiphertext(file)
        && (!file.folderId || active?.has(file.folderId.toHexString()) !== false))
        .map((file) => ({ ...publicFileMetadata(file), cursor: encodeGalleryCursor(file, sort) })),
      nextCursor: records.length > limit ? encodeGalleryCursor(page[page.length - 1], sort) : null,
    };
  } catch (error) {
    if (error instanceof GalleryMetadataError) throw error;
    throw new GalleryMetadataError("unavailable");
  }
}

export async function countGalleryMedia(db: Db, ownerId: ObjectId) {
  const rows = await getModelCollections(db).files.aggregate<{ _id: "image" | "video"; count: number }>([
    { $match: { ownerId, status: "ready", category: { $in: ["image", "video"] },
      "cloudinary.resourceType": "raw", "cloudinary.deliveryType": "authenticated",
      "cloudinary.assetId": { $type: "string" }, "cloudinary.format": "dat",
      "cloudinary.publicId": { $regex: /^vaultx\/ciphertext\/[a-f0-9]{48}\.dat$/ },
      "encryptionManifest.kind": "file", storedSizeBytes: { $gt: 0 },
      $expr: { $eq: ["$encryptionManifest.objectBytes", { $toString: "$storedSizeBytes" }] } } },
    { $group: { _id: "$category", count: { $sum: 1 } } },
  ], { maxTimeMS: 5_000 }).toArray();
  const counts = { image: 0, video: 0 };
  for (const row of rows) if (row._id === "image" || row._id === "video") counts[row._id] = row.count;
  return counts;
}

/** Existing folders are gallery albums; no duplicate album collection is created. */
export async function listGalleryAlbums(db: Db, ownerId: ObjectId,
  options: z.infer<typeof albumPageOptionsSchema>) {
  const input = albumPageOptionsSchema.safeParse(options);
  if (!input.success) throw new GalleryMetadataError("invalid_request");
  options = input.data;
  const limit = pageLimit(options.limit);
  try { await activeAncestry(db, ownerId, options.parentId); }
  catch (error) { if (error instanceof FolderOperationError) throw new GalleryMetadataError("not_found"); throw new GalleryMetadataError("unavailable"); }
  try {
    const { Album } = getGalleryModels(await getGalleryConnection());
    const rows = await Album.find({ ownerId, parentFolderId: options.parentId, status: "active",
      ...(options.after ? { _id: { $gt: options.after } } : {}) },
    { _id: 1, ownerId: 1, parentFolderId: 1, nameEncrypted: 1, descriptionEncrypted: 1, coverMediaId: 1, status: 1, createdAt: 1, updatedAt: 1 })
      .sort({ _id: 1 }).limit(limit + 1).lean<Folder[]>().maxTimeMS(5_000);
    const page = rows.slice(0, limit);
    return { albums: page.filter((album) => folderSchema.safeParse(album).success).map((album) => ({ id: album._id.toHexString(),
      parentId: album.parentFolderId?.toHexString() ?? null, nameEncrypted: album.nameEncrypted,
      ...(album.descriptionEncrypted ? { descriptionEncrypted: album.descriptionEncrypted } : {}),
      ...(album.coverMediaId ? { coverMediaId: album.coverMediaId.toHexString() } : {}),
      createdAt: album.createdAt.toISOString(), updatedAt: album.updatedAt.toISOString() })),
      nextCursor: rows.length > limit ? page[page.length - 1]._id.toHexString() : null };
  } catch { throw new GalleryMetadataError("unavailable"); }
}

/** Favorite updates use the existing owner/folder transaction fence. */
export async function setGalleryFavorite(db: Db, ownerId: ObjectId, mediaId: ObjectId, favorite: boolean) {
  if (!z.boolean().safeParse(favorite).success || !(mediaId instanceof ObjectId)) throw new GalleryMetadataError("invalid_request");
  try { return await changeFile(db, ownerId, mediaId, { favorite }); }
  catch (error) { if (error instanceof GalleryMetadataError) throw error; throw new GalleryMetadataError("unavailable"); }
}
