import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { v2 as cloudinary } from "cloudinary";
import { readCloudinaryConfig } from "../src/lib/cloudinary/config";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { inspectMediaCandidate, providerIdentity, type ProviderReference } from "../src/lib/migrations/media-audit";

type ProviderState = "verified" | "missing" | "inaccessible" | "not_checked";
type Report = {
  version: 1; mode: "dry-run"; generatedAt: string; auditComplete: boolean; migratedRecords: 0;
  scanned: { collections: number; documents: number; candidates: number };
  collections: Array<{ name: string; documents: number; candidates: number }>;
  outcomes: Record<string, number>; provider: Record<ProviderState, number>;
  duplicates: { sourceAssetReferences: number; alreadyCompatibleUniqueAssetReferences: number };
  storageInventory: { status: "complete" | "partial" | "unavailable"; checkedAssets: number; unreferencedAssets: number; byType: Record<string, number> };
  fieldAvailability: Record<string, number>;
  mapping: Record<string, string>;
  nextAction: string;
};

function reportPath(): string {
  const index = process.argv.indexOf("--report");
  const supplied = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && (!supplied || supplied.startsWith("-"))) throw new Error("Invalid report destination");
  return resolve(process.cwd(), supplied ?? "reports/media-migration-dry-run.json");
}
function emptyStates(): Record<ProviderState, number> { return { verified: 0, missing: 0, inaccessible: 0, not_checked: 0 }; }
function emptyFields(): Record<string, number> { return { originalFilename: 0, displayName: 0, dates: 0, dimensions: 0, duration: 0, tags: 0, albumReference: 0 }; }
function missingProvider(error: unknown): boolean {
  const value = typeof error === "object" && error !== null ? error as { http_code?: unknown; error?: { http_code?: unknown } } : {};
  return value.http_code === 404 || value.error?.http_code === 404;
}
async function verify(reference: ProviderReference): Promise<ProviderState> {
  if (reference.deliveryType === "unknown") return "not_checked";
  try {
    const value = await cloudinary.api.resource(reference.publicId, { resource_type: reference.resourceType, type: reference.deliveryType });
    if (!value || typeof value !== "object") return "inaccessible";
    const asset = value as Record<string, unknown>;
    return asset.public_id === reference.publicId && asset.resource_type === reference.resourceType
      && asset.type === reference.deliveryType && typeof asset.asset_id === "string"
      && Number.isSafeInteger(asset.bytes) && Number(asset.bytes) > 0 ? "verified" : "inaccessible";
  } catch (error) { return missingProvider(error) ? "missing" : "inaccessible"; }
}

async function main(): Promise<void> {
  if (process.argv.includes("--apply") || process.argv.includes("--cleanup")) {
    console.error("This migration gate is read-only. It never imports, deletes, or overwrites media."); process.exitCode = 2; return;
  }
  loadEnvConfig(process.cwd());
  const output = reportPath();
  const outcomes: Record<string, number> = {};
  const provider = emptyStates(); const fields = emptyFields();
  const sourceAssets = new Map<string, number>(); const destinationAssets = new Set<string>();
  let documentCount = 0; let candidateCount = 0;
  const collections: Report["collections"] = [];
  try {
    const cloud = readCloudinaryConfig();
    cloudinary.config({ cloud_name: cloud.cloudName, api_key: cloud.apiKey, api_secret: cloud.apiSecret, secure: true });
    const db = await getDatabase();
    const collectionNames = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name).filter((name) => !name.startsWith("system."));
    for (const name of collectionNames) {
      let scanned = 0; let candidates = 0;
      const cursor = db.collection(name).find({}, { batchSize: 100, projection: { _id: 1, cloudinary: 1, public_id: 1, publicId: 1, resource_type: 1, resourceType: 1, type: 1, delivery_type: 1, category: 1, mime_type: 1, mimeType: 1, secure_url: 1, thumbnail_url: 1, original_filename: 1, originalFilename: 1, sourceNameEncrypted: 1, display_name: 1, displayName: 1, nameEncrypted: 1, createdAt: 1, created_at: 1, updatedAt: 1, updated_at: 1, width: 1, height: 1, duration: 1, durationSeconds: 1, tags: 1, tagsEncrypted: 1, albumId: 1, album_id: 1, folderId: 1, extension: 1, encryptedFileKey: 1, encryptionManifest: 1, status: 1, storedSizeBytes: 1, ownerId: 1 } });
      for await (const source of cursor) {
        scanned++; documentCount++;
        const candidate = inspectMediaCandidate(name, source);
        if (!candidate) continue;
        candidates++; candidateCount++;
        outcomes[candidate.disposition] = (outcomes[candidate.disposition] ?? 0) + 1;
        for (const [field, present] of Object.entries(candidate.fields)) if (present) fields[field]++;
        if (candidate.provider) {
          const identity = providerIdentity(candidate.provider);
          sourceAssets.set(identity, (sourceAssets.get(identity) ?? 0) + 1);
          if (candidate.disposition === "already-compatible") destinationAssets.add(identity);
          const state = await verify(candidate.provider); provider[state]++;
        } else provider.not_checked++;
        if (candidateCount % 100 === 0) console.log(`Audited ${candidateCount} media candidates; no filenames, IDs, or credentials were printed.`);
      }
      collections.push({ name, documents: scanned, candidates });
      console.log(`Audited collection ${collections.length}/${collectionNames.length}: ${scanned} records, ${candidates} media candidates.`);
    }
    const storageInventory: Report["storageInventory"] = { status: "complete", checkedAssets: 0, unreferencedAssets: 0, byType: {} };
    try {
      const combinations = (["image", "video", "raw"] as const).flatMap((resourceType) =>
        (["upload", "private", "authenticated"] as const).map((deliveryType) => ({ resourceType, deliveryType })));
      for (const combination of combinations) {
        let cursor: string | undefined;
        do {
          const response = await cloudinary.api.resources({ resource_type: combination.resourceType,
            type: combination.deliveryType, max_results: 500, ...(cursor ? { next_cursor: cursor } : {}) }) as
            { resources?: Array<{ public_id?: unknown; resource_type?: unknown; type?: unknown }>; next_cursor?: string };
          if (!Array.isArray(response.resources)) throw new Error("Invalid provider inventory");
          for (const asset of response.resources) {
            if (typeof asset.public_id !== "string" || asset.resource_type !== combination.resourceType
              || asset.type !== combination.deliveryType) throw new Error("Invalid provider inventory");
            storageInventory.checkedAssets++;
            const label = `${combination.resourceType}/${combination.deliveryType}`;
            storageInventory.byType[label] = (storageInventory.byType[label] ?? 0) + 1;
            if (!sourceAssets.has(providerIdentity({ publicId: asset.public_id, ...combination }))) storageInventory.unreferencedAssets++;
          }
          cursor = response.next_cursor;
          if (storageInventory.checkedAssets >= 10_000 && cursor) { storageInventory.status = "partial"; break; }
        } while (cursor);
        if (storageInventory.status === "partial") break;
      }
    } catch { storageInventory.status = "unavailable"; }
    const report: Report = { version: 1, mode: "dry-run", generatedAt: new Date().toISOString(),
      auditComplete: storageInventory.status === "complete", migratedRecords: 0,
      scanned: { collections: collections.length, documents: documentCount, candidates: candidateCount }, collections,
      outcomes, provider, duplicates: { sourceAssetReferences: [...sourceAssets.values()].filter((count) => count > 1).length, alreadyCompatibleUniqueAssetReferences: destinationAssets.size }, storageInventory,
      fieldAvailability: fields,
      mapping: {
        "public_id + resource_type + type": "Cloudinary verification identity only; never copied into a ready VaultX file unless it is already encrypted raw/authenticated ciphertext.",
        "secure_url + thumbnail_url": "Not migrated. URLs are public-delivery metadata and are incompatible with VaultX private retrieval.",
        "original_filename + display_name + tags": "Preserved only by approved browser-side re-encryption because VaultX stores these fields encrypted.",
        "bytes + width + height + duration + format": "Compared against Cloudinary during an approved import; missing values remain missing.",
        "albumId": "Maps to existing folderId only after owner-scoped folder mapping is reviewed.",
        "createdAt + updatedAt": "Retained as source metadata when valid; otherwise recorded as unavailable rather than invented.",
      },
      nextAction: "Review this dry-run report. Legacy public/plaintext assets require an approved client-side encryption import and cannot be converted server-side.",
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Dry run complete: ${candidateCount} candidate records. Report written without filenames, public IDs, URLs, or credentials.`);
  } catch {
    console.error("Migration audit failed. No records or Cloudinary assets were changed; check service configuration and access."); process.exitCode = 1;
  } finally { await closeDatabaseConnection().catch(() => undefined); }
}

void main();
