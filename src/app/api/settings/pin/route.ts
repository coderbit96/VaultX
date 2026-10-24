import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk, privateApiHeaders } from "@/lib/auth/api-policy";
import { reauthenticateOwner } from "@/lib/auth/security-settings";
import { deviceDigest, disablePin, enrollPin, pinCookieName, pinCookieOptions } from "@/lib/auth/pin";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { getModelCollections } from "@/lib/database/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.strictObject({ loginPassword: z.string().min(1).max(1024), pin: z.string().regex(/^\d{6}$/) });
const removal = z.strictObject({ loginPassword: z.string().min(1).max(1024) });

export async function GET(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const token = request.cookies.get(pinCookieName(process.env.NODE_ENV === "production"))?.value;
  const digest = token && deviceDigest(token);
  try {
    const credential = digest ? await getModelCollections(authorized.context.db).pinCredentials.findOne({
      ownerId: authorized.context.ownerId, deviceDigest: digest, expiresAt: { $gt: new Date() },
    }, { projection: { expiresAt: 1, lockedUntil: 1 } }) : null;
    return apiOk({ enabled: Boolean(credential), expiresAt: credential?.expiresAt?.toISOString() ?? null,
      lockedUntil: credential?.lockedUntil?.toISOString() ?? null });
  } catch { return apiError(503, "unavailable"); }
}

export async function POST(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, input, 1_536);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId } = authorized.context;
    const verified = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (verified.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (verified.kind === "invalid") return apiError(401, "invalid_credentials");
    const priorToken = request.cookies.get(pinCookieName(process.env.NODE_ENV === "production"))?.value;
    const priorDigest = deviceDigest(priorToken ?? "");
    if (await getModelCollections(db).pinCredentials.countDocuments({ ownerId, expiresAt: { $gt: new Date() } }) >= 5
      && !(priorDigest && await getModelCollections(db).pinCredentials.findOne({ ownerId, deviceDigest: priorDigest }))) return apiError(409, "settings_conflict");
    const token = await enrollPin(db, ownerId, parsed.data.pin, new Date(), priorToken);
    const production = process.env.NODE_ENV === "production";
    const response = NextResponse.json({ ok: true }, { headers: privateApiHeaders });
    response.cookies.set(pinCookieName(production), token, pinCookieOptions(production, 30 * 24 * 60 * 60));
    return response;
  } catch { return apiError(503, "unavailable"); }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const parsed = await readJsonRequest(request, removal, 1_536);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const { db, ownerId } = authorized.context;
    const verified = await reauthenticateOwner(db, ownerId, parsed.data.loginPassword);
    if (verified.kind === "limited") return apiError(429, "rate_limited", { "Retry-After": "900" });
    if (verified.kind === "invalid") return apiError(401, "invalid_credentials");
    const production = process.env.NODE_ENV === "production";
    await disablePin(db, ownerId, request.cookies.get(pinCookieName(production))?.value);
    const response = NextResponse.json({ ok: true }, { headers: privateApiHeaders });
    response.cookies.set(pinCookieName(production), "", pinCookieOptions(production, 0));
    return response;
  } catch { return apiError(503, "unavailable"); }
}
