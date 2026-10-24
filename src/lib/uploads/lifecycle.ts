import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { objectIdText } from "@/lib/auth/request-validation";
import { fileSchema, uploadCompletionMetadataSchema, type UploadJob, type VaultFile } from "@/lib/database/models";

export const completeInputSchema = uploadCompletionMetadataSchema.extend({ id: objectIdText });
export type CompletionMetadata = z.infer<typeof uploadCompletionMetadataSchema>;
export type ProviderAsset = { assetId: string; publicId: string; resourceType: string; deliveryType: string;
  format: string; bytes: number; version: number };
export type UploadOperation = "transfer" | "complete" | "cancel";

export class UploadLifecycleError extends Error {
  constructor(readonly code: "not_found" | "invalid_request" | "conflict" | "unavailable" | "missing_asset" | "provider_mismatch" | "oversize") { super(code); }
}

export interface UploadProvider {
  lookup(asset: UploadJob["cloudAssets"][number]): Promise<ProviderAsset | null>;
  readHeader(asset: UploadJob["cloudAssets"][number], totalBytes: number): Promise<Uint8Array>;
  destroy(asset: UploadJob["cloudAssets"][number]): Promise<void>;
}

export interface UploadStore {
  getJob(ownerId: ObjectId, id: ObjectId): Promise<UploadJob | null>;
  getReadyFile(ownerId: ObjectId, fileId: ObjectId): Promise<VaultFile | null>;
  acquire(ownerId: ObjectId, id: ObjectId, operation: UploadOperation, token: string,
    expiry: Date, now: Date, metadata?: CompletionMetadata): Promise<UploadJob | null>;
  commitReady(job: UploadJob, token: string, file: VaultFile, now: Date): Promise<void>;
  recordState(job: UploadJob, token: string, status: "retrying" | "failed" | "cancelled",
    code: string | undefined, now: Date): Promise<void>;
  recordAsset(job: UploadJob, token: string, asset: ProviderAsset, now: Date, index?: number): Promise<void>;
  requestCancel(ownerId: ObjectId, id: ObjectId, now: Date): Promise<boolean>;
}

export function validateCompletionMetadata(job: UploadJob, metadata: CompletionMetadata): void {
  if (!job.manifest || !job.category || metadata.nameEncrypted.vaultId !== job.manifest.vaultId
    || (metadata.sourceNameEncrypted && metadata.sourceNameEncrypted.vaultId !== job.manifest.vaultId)) {
    throw new UploadLifecycleError("invalid_request");
  }
  const format = `${metadata.extension}:${metadata.mimeType}`;
  if (job.category === "image") {
    if (!["webp:image/webp", "png:image/png", "jpg:image/jpeg"].includes(format)
      || !metadata.width || !metadata.height || metadata.durationSeconds !== undefined) throw new UploadLifecycleError("invalid_request");
  } else if (job.category === "video") {
    if (format !== "mp4:video/mp4" || !metadata.width || !metadata.height || !metadata.durationSeconds) throw new UploadLifecycleError("invalid_request");
  } else if ((job.category !== "document" && job.category !== "other")
    || metadata.width || metadata.height || metadata.durationSeconds
    || !/^(?:application\/[a-z0-9.+-]+|text\/plain)$/.test(metadata.mimeType)) {
    throw new UploadLifecycleError("invalid_request");
  }
}

function sameMetadata(left: CompletionMetadata, right: CompletionMetadata): boolean {
  return left.extension === right.extension && left.mimeType === right.mimeType && left.width === right.width
    && left.height === right.height && left.durationSeconds === right.durationSeconds
    && JSON.stringify(left.sourceNameEncrypted) === JSON.stringify(right.sourceNameEncrypted)
    && Object.keys(left.nameEncrypted).every((key) =>
      left.nameEncrypted[key as keyof CompletionMetadata["nameEncrypted"]]
        === right.nameEncrypted[key as keyof CompletionMetadata["nameEncrypted"]]);
}

export function verifyProviderAsset(job: UploadJob, provider: ProviderAsset | null, index = 0): ProviderAsset {
  if (!provider) throw new UploadLifecycleError("missing_asset");
  const planned = job.cloudAssets[index];
  if (!planned || !planned.assetId || provider.assetId !== planned.assetId
    || provider.publicId !== planned.publicId || provider.resourceType !== "raw"
    || provider.deliveryType !== "authenticated" || !["", "dat"].includes(provider.format)
    || !Number.isSafeInteger(provider.version) || provider.version <= 0) throw new UploadLifecycleError("provider_mismatch");
  const cap = index === 1 || job.category === "image" ? 1_000_000 : job.category === "video" ? 100_000_000 : 10_000_000;
  if (!Number.isSafeInteger(provider.bytes) || provider.bytes <= 0 || provider.bytes >= cap) throw new UploadLifecycleError("oversize");
  if (provider.bytes !== (index === 0 ? job.ciphertextBytes : Number(job.thumbnailManifest?.objectBytes))
    || provider.bytes.toString() !== (index === 0 ? job.manifest?.objectBytes : job.thumbnailManifest?.objectBytes)) {
    throw new UploadLifecycleError("provider_mismatch");
  }
  return provider;
}

export function verifyStoredHeader(job: UploadJob, header: Uint8Array, index = 0): void {
  const manifest = index === 0 ? job.manifest : job.thumbnailManifest;
  if (!manifest || header.length !== 80
    || Buffer.from(header).toString("base64url") !== manifest.header) throw new UploadLifecycleError("provider_mismatch");
}

export function readyFileFromVerified(job: UploadJob, metadata: CompletionMetadata, asset: ProviderAsset, now: Date,
  thumbnail?: ProviderAsset): VaultFile {
  validateCompletionMetadata(job, metadata);
  verifyProviderAsset(job, asset);
  if (job.thumbnailManifest && !thumbnail) throw new UploadLifecycleError("missing_asset");
  if (thumbnail) verifyProviderAsset(job, thumbnail, 1);
  const manifest = job.manifest!;
  return fileSchema.parse({ _id: job.fileId, ownerId: job.ownerId, folderId: job.folderId,
    nameEncrypted: metadata.nameEncrypted,
    ...(metadata.sourceNameEncrypted ? { sourceNameEncrypted: metadata.sourceNameEncrypted } : {}),
    extension: metadata.extension, category: job.category,
    mimeType: metadata.mimeType, width: metadata.width, height: metadata.height,
    ...(metadata.durationSeconds ? { durationSeconds: metadata.durationSeconds } : {}),
    storedSizeBytes: asset.bytes,
    cloudinary: { publicId: asset.publicId, assetId: asset.assetId, resourceType: "raw", deliveryType: "authenticated",
      format: "dat", version: asset.version },
    ...(job.thumbnailManifest && thumbnail ? { thumbnail: { storedSizeBytes: thumbnail.bytes,
      cloudinary: { publicId: thumbnail.publicId, assetId: thumbnail.assetId, resourceType: "raw",
        deliveryType: "authenticated", format: "dat", version: thumbnail.version },
      encryptionManifest: job.thumbnailManifest } } : {}),
    encryptedFileKey: manifest.wrappedKey.ciphertext, encryptionManifest: manifest,
    status: "ready", createdAt: job.createdAt, updatedAt: now });
}

function statusResult(job: UploadJob) {
  return { id: job._id.toHexString(), fileId: job.fileId.toHexString(), status: job.status,
    category: job.category, createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
    nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null, errorCode: job.lastErrorCode ?? null,
    transferComplete: !!job.cloudAssets[0]?.assetId && (!job.thumbnailManifest || !!job.cloudAssets[1]?.assetId),
    cancelRequested: !!job.cancelRequestedAt,
    cleanupComplete: job.cloudAssets.every((asset) => asset.cleanupCompleted) };
}

export async function uploadStatus(store: UploadStore, ownerId: ObjectId, id: ObjectId) {
  const job = await store.getJob(ownerId, id);
  if (!job) throw new UploadLifecycleError("not_found");
  return statusResult(job);
}

async function acquire(store: UploadStore, ownerId: ObjectId, job: UploadJob,
  operation: UploadOperation, now: Date, metadata?: CompletionMetadata) {
  const token = randomBytes(16).toString("hex");
  const acquired = await store.acquire(ownerId, job._id, operation, token, new Date(now.getTime() + 2 * 60_000), now, metadata);
  if (!acquired) throw new UploadLifecycleError("conflict");
  return { acquired, token };
}

export async function completeUpload(store: UploadStore, provider: UploadProvider, ownerId: ObjectId,
  id: ObjectId, metadata: CompletionMetadata, now = new Date()) {
  const job = await store.getJob(ownerId, id);
  if (!job) throw new UploadLifecycleError("not_found");
  if (job.status === "completed") {
    if (job.completionMetadata && !sameMetadata(job.completionMetadata, metadata)) throw new UploadLifecycleError("conflict");
    const file = await store.getReadyFile(ownerId, job.fileId);
    if (!file) throw new UploadLifecycleError("unavailable");
    if (job.thumbnailManifest && !file.thumbnail) throw new UploadLifecycleError("conflict");
    return statusResult(job);
  }
  if (job.status === "cancelled" || job.cancelRequestedAt || !job.manifest || !job.cloudAssets[0]?.assetId
    || (job.thumbnailManifest && !job.cloudAssets[1]?.assetId)
    || !job.intentExpiresAt || job.intentExpiresAt <= now) throw new UploadLifecycleError("conflict");
  validateCompletionMetadata(job, metadata);
  if (job.completionMetadata && !sameMetadata(job.completionMetadata, metadata)) throw new UploadLifecycleError("conflict");
  const { acquired, token } = await acquire(store, ownerId, job, "complete", now, metadata);
  let asset: ProviderAsset;
  let thumbnail: ProviderAsset | undefined;
  try {
    asset = verifyProviderAsset(acquired, await provider.lookup(acquired.cloudAssets[0]));
    verifyStoredHeader(acquired, await provider.readHeader(acquired.cloudAssets[0], asset.bytes));
    if (acquired.thumbnailManifest) {
      thumbnail = verifyProviderAsset(acquired, await provider.lookup(acquired.cloudAssets[1]), 1);
      verifyStoredHeader(acquired, await provider.readHeader(acquired.cloudAssets[1], thumbnail.bytes), 1);
    }
  } catch (error) {
    if (error instanceof UploadLifecycleError) {
      await store.recordState(acquired, token, "failed", error.code, now);
      throw error;
    }
    await store.recordState(acquired, token, "retrying", "provider_unavailable", now).catch(() => undefined);
    throw new UploadLifecycleError("unavailable");
  }
  const file = readyFileFromVerified(acquired, metadata, asset, now, thumbnail);
  try {
    await store.commitReady(acquired, token, file, now);
    return { ...statusResult({ ...acquired, status: "completed", updatedAt: now }), status: "completed" as const };
  } catch {
    // An uncertain transaction commit may have succeeded. Do not destroy an
    // object until a later read can establish whether a ready file exists.
    const ready = await store.getReadyFile(ownerId, acquired.fileId).catch(() => null);
    if (ready?.cloudinary?.assetId === asset.assetId) return { ...statusResult({ ...acquired, status: "completed", updatedAt: now }), status: "completed" as const };
    await store.recordState(acquired, token, "retrying", "db_commit_failed", now).catch(() => undefined);
    throw new UploadLifecycleError("unavailable");
  }
}

export async function cancelUpload(store: UploadStore, provider: UploadProvider, ownerId: ObjectId,
  id: ObjectId, now = new Date()) {
  const job = await store.getJob(ownerId, id);
  if (!job) throw new UploadLifecycleError("not_found");
  if (job.status === "cancelled") return statusResult(job);
  if (job.status === "completed") throw new UploadLifecycleError("conflict");
  if (await store.getReadyFile(ownerId, job.fileId)) throw new UploadLifecycleError("conflict");
  if (job.status === "running" && job.operation === "transfer" && job.leaseExpiresAt && job.leaseExpiresAt > now) {
    if (!await store.requestCancel(ownerId, id, now)) throw new UploadLifecycleError("conflict");
    return { ...statusResult(job), cancelRequested: true };
  }
  const { acquired, token } = await acquire(store, ownerId, job, "cancel", now);
  try {
    for (const [index, planned] of acquired.cloudAssets.entries()) {
      const prefix = index === 0 ? "ciphertext" : "thumbnails";
      if (!new RegExp(`^vaultx/${prefix}/[a-f0-9]{48}\\.dat$`).test(planned.publicId)
        || planned.resourceType !== "raw" || planned.deliveryType !== "authenticated" || planned.format !== "dat") {
        throw new UploadLifecycleError("invalid_request");
      }
      const found = await provider.lookup(planned);
      if (found) {
        if (found.publicId !== planned.publicId || found.resourceType !== "raw" || found.deliveryType !== "authenticated"
          || !["", "dat"].includes(found.format)
          || (planned.assetId && found.assetId !== planned.assetId)) throw new UploadLifecycleError("provider_mismatch");
        await provider.destroy(planned);
        if (await provider.lookup(planned)) throw new UploadLifecycleError("unavailable");
      }
    }
    await store.recordState(acquired, token, "cancelled", undefined, now);
    return { ...statusResult({ ...acquired, status: "cancelled", updatedAt: now,
      cloudAssets: acquired.cloudAssets.map((asset) => ({ ...asset, cleanupCompleted: true })) }), status: "cancelled" as const };
  } catch (error) {
    const code = error instanceof UploadLifecycleError ? error.code : "provider_unavailable";
    await store.recordState(acquired, token,
      code === "provider_mismatch" || code === "invalid_request" ? "failed" : "retrying", code, now).catch(() => undefined);
    throw error instanceof UploadLifecycleError ? error : new UploadLifecycleError("unavailable");
  }
}
