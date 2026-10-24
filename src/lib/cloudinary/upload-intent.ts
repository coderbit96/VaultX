import { randomBytes } from "node:crypto";
import { ObjectId, type Db } from "mongodb";
import { z } from "zod";
import { activeAncestry } from "@/lib/database/folders";
import { getModelCollections, uploadJobSchema, type UploadJob } from "@/lib/database/models";
import { fileManifestSchema } from "@/lib/crypto/file-container";
import { V1_CHUNK_BYTES, V1_HEADER_BYTES, V1_MAX_METADATA_CIPHER_BYTES, v1ChunkCount, v1ObjectBytes } from "@/lib/crypto/format-v1";
import { objectIdText, parseObjectId } from "@/lib/auth/request-validation";

export const uploadInitInput = z.strictObject({
  category: z.enum(["image", "video", "document", "other"]),
  folderId: objectIdText.nullable(),
  manifest: fileManifestSchema.refine((value) => value.kind === "file"),
  thumbnailManifest: fileManifestSchema.refine((value) => value.kind === "thumbnail").optional(),
});
export type UploadInitInput = z.infer<typeof uploadInitInput>;

export class UploadIntentError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "rate_limited" | "vault_setup_required" | "unavailable") { super(code); }
}

const IMAGE_LIMIT = 1_000_000;
const VIDEO_LIMIT = 100_000_000;
const INTENT_LIFETIME_MS = 10 * 60_000;
const MAX_ACTIVE_INTENTS = 5;
const MAX_HOURLY_INTENTS = 20;

// A client claim is used only to reject impossible requests early. The eventual
// provider response must independently confirm exact bytes before File.ready.
export function inspectUploadManifest(input: UploadInitInput): number {
  const ciphertextBytes = inspectManifest(input.manifest, "file", input.category === "image" ? IMAGE_LIMIT : input.category === "video" ? VIDEO_LIMIT : 10_000_000);
  if (input.thumbnailManifest) {
    if (input.category !== "image" && input.category !== "video") throw new UploadIntentError("invalid_request");
    inspectManifest(input.thumbnailManifest, "thumbnail", IMAGE_LIMIT);
    const fileHeader = Buffer.from(input.manifest.header, "base64url");
    const thumbHeader = Buffer.from(input.thumbnailManifest.header, "base64url");
    if (!fileHeader.subarray(16, 32).equals(thumbHeader.subarray(16, 32))
      || fileHeader.subarray(32, 48).equals(thumbHeader.subarray(32, 48))) throw new UploadIntentError("invalid_request");
  }
  return ciphertextBytes;
}

function inspectManifest(manifest: UploadInitInput["manifest"], kind: "file" | "thumbnail", cap: number): number {
  if (manifest.kind !== kind) throw new UploadIntentError("invalid_request");
  const header = Buffer.from(manifest.header, "base64url");
  if (header.length !== V1_HEADER_BYTES || header.toString("base64url") !== manifest.header
    || header.toString("ascii", 0, 8) !== "VAULTX01") throw new UploadIntentError("invalid_request");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const plaintext = view.getBigUint64(48);
  const metadataBytes = view.getUint32(72);
  if (view.getUint16(8) !== 1 || view.getUint16(10) !== (kind === "file" ? 1 : 2) || view.getUint32(12) !== V1_HEADER_BYTES
    || (kind === "file" ? !header.subarray(32, 48).every((byte) => byte === 0)
      : header.subarray(32, 48).every((byte) => byte === 0))
    || view.getUint32(56) !== V1_CHUNK_BYTES || view.getUint32(76) !== 0
    || metadataBytes < 16 || metadataBytes > V1_MAX_METADATA_CIPHER_BYTES
    || plaintext === BigInt(0) || plaintext > BigInt(Number.MAX_SAFE_INTEGER)) throw new UploadIntentError("invalid_request");
  let expected: bigint;
  try {
    const count = v1ChunkCount(plaintext);
    if (view.getUint32(60) !== count) throw new Error();
    expected = v1ObjectBytes({ plaintextLength: plaintext, metadataCiphertextLength: metadataBytes, chunkCount: count });
  } catch { throw new UploadIntentError("invalid_request"); }
  if (expected >= BigInt(cap) || manifest.objectBytes !== expected.toString()) throw new UploadIntentError("invalid_request");
  return Number(expected);
}

export function makeOpaqueCloudinaryId(): string {
  return `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`;
}
export function makeOpaqueThumbnailCloudinaryId(): string {
  return `vaultx/thumbnails/${randomBytes(24).toString("hex")}.dat`;
}

// This is deliberately server-only. Cloudinary excludes resource_type and file
// bytes from browser-visible signatures and has no per-preset byte cap.
export function cloudinaryCiphertextUploadOptions(publicId: string) {
  if (!/^vaultx\/(?:ciphertext|thumbnails)\/[a-f0-9]{48}\.dat$/.test(publicId)) throw new UploadIntentError("invalid_request");
  return { resource_type: "raw" as const, type: "authenticated" as const, public_id: publicId,
    overwrite: false, use_filename: false, unique_filename: false };
}

export async function reserveUploadIntent(db: Db, ownerId: ObjectId, input: UploadInitInput, now = new Date()): Promise<UploadJob> {
  const ciphertextBytes = inspectUploadManifest(input);
  if (input.thumbnailManifest && (input.thumbnailManifest.vaultId !== input.manifest.vaultId
    || Number(input.thumbnailManifest.objectBytes) >= 1_000_000)) throw new UploadIntentError("invalid_request");
  const folderId = input.folderId ? parseObjectId(input.folderId) : null;
  if (input.folderId && !folderId) throw new UploadIntentError("invalid_request");
  const collections = getModelCollections(db);
  const fileId = new ObjectId();
  const options = cloudinaryCiphertextUploadOptions(makeOpaqueCloudinaryId());
  const asset = { publicId: options.public_id, resourceType: options.resource_type,
    deliveryType: options.type, format: "dat", cleanupCompleted: false };
  const thumbnailAsset = input.thumbnailManifest ? { publicId: makeOpaqueThumbnailCloudinaryId(), resourceType: "raw" as const,
    deliveryType: "authenticated" as const, format: "dat", cleanupCompleted: false } : undefined;
  const job = uploadJobSchema.parse({ _id: new ObjectId(), ownerId, fileId, folderId, category: input.category,
    manifest: input.manifest, ciphertextBytes, ...(input.thumbnailManifest ? { thumbnailManifest: input.thumbnailManifest } : {}),
    intentExpiresAt: new Date(now.getTime() + INTENT_LIFETIME_MS), status: "pending", attempts: 0,
    cloudAssets: thumbnailAsset ? [asset, thumbnailAsset] : [asset], createdAt: now, updatedAt: now });
  // Serialize reservations with folder moves/deletion fences on the owner row.
  const created = await db.client.withSession((session) => session.withTransaction(async () => {
    const owner = await collections.owners.updateOne({ _id: ownerId, singletonKey: "vaultx-owner" },
      { $inc: { folderTreeRevision: 1 } }, { session });
    if (owner.matchedCount !== 1) throw new UploadIntentError("unavailable");
    const vault = await collections.vaultKeys.findOne({ ownerId }, { session, projection: { vaultId: 1 } });
    if (!vault) throw new UploadIntentError("vault_setup_required");
    if (vault.vaultId !== input.manifest.vaultId) throw new UploadIntentError("invalid_request");
    await activeAncestry(db, ownerId, folderId, session);
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    const recent = await collections.uploadJobs.countDocuments({ ownerId, createdAt: { $gte: hourAgo } }, { session });
    const active = await collections.uploadJobs.countDocuments({ ownerId, status: "pending", intentExpiresAt: { $gt: now } }, { session });
    if (recent >= MAX_HOURLY_INTENTS || active >= MAX_ACTIVE_INTENTS) throw new UploadIntentError("rate_limited");
    await collections.uploadJobs.insertOne(job, { session });
    return job;
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
  if (!created) throw new UploadIntentError("unavailable");
  return created;
}
