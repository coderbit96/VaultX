import type { NextRequest } from "next/server";
import { z } from "zod";
import { getModelCollections } from "@/lib/database/models";
import { lockSession, createMongoAuthStore } from "@/lib/auth/session-core";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { reauthenticateOwner } from "@/lib/auth/security-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const input = z.strictObject({ autoLockMinutes: z.number().int().min(1).max(60), loginPassword: z.string().min(1).max(1024) });

export async function GET(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  try {
    const { db, ownerId } = authorized.context;
    const owner = await getModelCollections(db).owners.findOne(
      { _id: ownerId, singletonKey: "vaultx-owner" },
      { projection: { "settings.autoLockMinutes": 1, "settings.requireLockOnOpen": 1 } },
    );
    return owner ? apiOk({ settings: owner.settings }) : apiError(503, "unavailable");
  } catch {
    return apiError(503, "unavailable");
  }
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, input, 1_536);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId, token } = authorized.context;
    const verified = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (verified.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (verified.kind === "invalid") return apiError(401, "invalid_credentials");
    const store = createMongoAuthStore(db);
    const result = await getModelCollections(db).owners.updateOne(
      { _id: ownerId, singletonKey: "vaultx-owner" },
      { $set: { "settings.autoLockMinutes": parsed.data.autoLockMinutes } },
    );
    if (result.matchedCount !== 1) return apiError(503, "unavailable");
    // The new server idle window starts with a fresh password unlock.
    await lockSession(store, token);
    return apiOk({ ok: true, reunlock: true });
  } catch {
    return apiError(503, "unavailable");
  }
}
