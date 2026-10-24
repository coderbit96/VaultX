import type { NextRequest } from "next/server";
import { MongoServerError, ObjectId, type Db } from "mongodb";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { vaultKeyEnvelopeSchema } from "@/lib/crypto/vault-key-schema";
import { getModelCollections, vaultKeyRecordSchema } from "@/lib/database/models";
import { reauthenticateOwner, saveRotatedVaultEnvelope } from "@/lib/auth/security-settings";
import { sessionCookieName, sessionCookieOptions } from "@/lib/auth/session-core";
import { NextResponse } from "next/server";
import { privateApiHeaders } from "@/lib/auth/api-policy";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function hasLegacyData(db: Db, ownerId: ObjectId): Promise<boolean> {
  const { files, folders, uploadJobs, deletionJobs } = getModelCollections(db);
  const projection = { projection: { _id: 1 } } as const;
  const existing = await Promise.all([
    files.findOne({ ownerId }, projection),
    folders.findOne({ ownerId }, projection),
    uploadJobs.findOne({ ownerId }, projection),
    deletionJobs.findOne({ ownerId }, projection),
  ]);
  return existing.some((record) => record !== null);
}

export async function GET(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  try {
    const { db, ownerId } = authorized.context;
    const stored = await getModelCollections(db).vaultKeys.findOne({ ownerId });
    if (stored) {
      const parsed = vaultKeyRecordSchema.safeParse(stored);
      if (!parsed.success) return apiOk({ status: "migration_required" });
      const envelope = {
        version: parsed.data.version,
        vaultId: parsed.data.vaultId,
        revision: parsed.data.revision,
        password: parsed.data.password,
        recovery: parsed.data.recovery,
      };
      return apiOk({ status: "ready", envelope, recoveryConfirmedAt: parsed.data.recoveryConfirmedAt.toISOString() });
    }
    return apiOk({ status: await hasLegacyData(db, ownerId) ? "migration_required" : "uninitialized" });
  } catch {
    return apiError(503, "unavailable");
  }
}

const rotationInput = z.strictObject({
  loginPassword: z.string().min(1).max(1024),
  previousRevision: z.number().int().min(1),
  envelope: vaultKeyEnvelopeSchema,
});

export async function PUT(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, rotationInput, 3_072);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId } = authorized.context;
    const verified = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (verified.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (verified.kind === "invalid") return apiError(401, "invalid_credentials");
    const result = await saveRotatedVaultEnvelope(db, ownerId, parsed.data.previousRevision, parsed.data.envelope);
    if (result === "conflict") return apiError(409, "settings_conflict");
    const production = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ ok: true, reunlock: true }, { headers: privateApiHeaders });
    response.cookies.set(sessionCookieName(production), "", sessionCookieOptions(production, 0));
    return response;
  } catch { return apiError(503, "unavailable"); }
}

export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, vaultKeyEnvelopeSchema, 2_048);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId } = authorized.context;
    const { vaultKeys } = getModelCollections(db);
    // Create the unique index before the first write, including on a fresh Atlas DB.
    await vaultKeys.createIndex({ ownerId: 1 }, { unique: true, name: "one_vault_keys_per_owner" });
    if (await vaultKeys.findOne({ ownerId }, { projection: { _id: 1 } })) return apiError(409, "conflict");
    if (await hasLegacyData(db, ownerId)) return apiError(409, "migration_required");
    const now = new Date();
    await vaultKeys.insertOne(vaultKeyRecordSchema.parse({
      ...parsed.data, _id: new ObjectId(), ownerId, createdAt: now, recoveryConfirmedAt: now,
    }));
    return apiOk({ status: "ready" });
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return apiError(409, "conflict");
    return apiError(503, "unavailable");
  }
}
