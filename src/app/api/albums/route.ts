import type { NextRequest } from "next/server";
import { MongoServerError } from "mongodb";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { objectIdText, parseObjectId, readJsonRequest } from "@/lib/auth/request-validation";
import { encryptedNameSchema } from "@/lib/crypto/folder-name-schema";
import { AlbumOperationError, createAlbum, listAlbums } from "@/lib/database/albums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createInput = z.strictObject({
  id: objectIdText,
  nameEncrypted: encryptedNameSchema,
  descriptionEncrypted: encryptedNameSchema.optional(),
});

function albumError(error: unknown): Response {
  if (error instanceof AlbumOperationError) {
    const status = error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : error.code === "conflict" ? 409 : 503;
    return apiError(status, error.code);
  }
  if (error instanceof MongoServerError && error.code === 11000) return apiError(409, "conflict");
  return apiError(503, "unavailable");
}

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  if ([...request.nextUrl.searchParams.keys()].length) return apiError(400, "invalid_request");
  try { return apiOk(await listAlbums(auth.context.db, auth.context.ownerId)); }
  catch (error) { return albumError(error); }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const input = await readJsonRequest(request, createInput, 2_048);
  if (!input.ok) return apiError(400, "invalid_request");
  try {
    const album = await createAlbum(auth.context.db, auth.context.ownerId, parseObjectId(input.data.id)!, input.data.nameEncrypted,
      input.data.descriptionEncrypted);
    return apiOk({ album: { id: album._id.toHexString(), nameEncrypted: album.nameEncrypted } });
  } catch (error) { return albumError(error); }
}
