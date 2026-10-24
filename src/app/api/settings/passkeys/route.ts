import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { reauthenticateOwner } from "@/lib/auth/security-settings";
import { readJsonRequest, objectIdText, parseObjectId } from "@/lib/auth/request-validation";
import { getModelCollections } from "@/lib/database/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const removal = z.strictObject({ id: objectIdText, loginPassword: z.string().min(1).max(1024) });

export async function GET(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  try {
    const { db, ownerId } = authorized.context;
    const credentials = await getModelCollections(db).deviceCredentials.find({ ownerId },
      { projection: { _id: 1, createdAt: 1, lastUsedAt: 1, rpId: 1 } }).sort({ createdAt: -1 }).limit(20).toArray();
    return apiOk({ passkeys: credentials.map((item) => ({ id: item._id.toHexString(), createdAt: item.createdAt,
      lastUsedAt: item.lastUsedAt ?? null, rpId: item.rpId ?? null })) });
  } catch { return apiError(503, "unavailable"); }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, removal, 1_536);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId } = authorized.context;
    const reauth = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (reauth.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (reauth.kind === "invalid") return apiError(401, "invalid_credentials");
    const result = await getModelCollections(db).deviceCredentials.deleteOne({ _id: parseObjectId(parsed.data.id)!, ownerId });
    return result.deletedCount === 1 ? apiOk({ ok: true }) : apiError(404, "not_found");
  } catch { return apiError(503, "unavailable"); }
}
