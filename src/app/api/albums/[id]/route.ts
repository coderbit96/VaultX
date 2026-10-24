import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { objectIdText, parseObjectId, readJsonRequest } from "@/lib/auth/request-validation";
import { encryptedNameSchema } from "@/lib/crypto/folder-name-schema";
import { AlbumOperationError, changeAlbum, removeAlbum } from "@/lib/database/albums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchInput = z.strictObject({
  nameEncrypted: encryptedNameSchema.optional(),
  descriptionEncrypted: encryptedNameSchema.nullable().optional(),
  coverMediaId: objectIdText.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

function albumError(error: unknown): Response {
  if (error instanceof AlbumOperationError) {
    const status = error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : error.code === "conflict" ? 409 : 503;
    return apiError(status, error.code);
  }
  return apiError(503, "unavailable");
}

function idFrom(params: Promise<{ id: string }>): Promise<import("mongodb").ObjectId | null> {
  return params.then(({ id }) => parseObjectId(id));
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const [id, input] = await Promise.all([idFrom(params), readJsonRequest(request, patchInput, 2_048)]);
  if (!id || !input.ok) return apiError(400, "invalid_request");
  try {
    const album = await changeAlbum(auth.context.db, auth.context.ownerId, id, {
      ...(input.data.nameEncrypted ? { nameEncrypted: input.data.nameEncrypted } : {}),
      ...(Object.hasOwn(input.data, "descriptionEncrypted") ? { descriptionEncrypted: input.data.descriptionEncrypted } : {}),
      ...(Object.hasOwn(input.data, "coverMediaId") ? { coverMediaId: input.data.coverMediaId ? parseObjectId(input.data.coverMediaId)! : null } : {}),
    });
    return apiOk({ album: { id: album._id.toHexString(), nameEncrypted: album.nameEncrypted } });
  } catch (error) { return albumError(error); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  if ([...request.nextUrl.searchParams.keys()].length) return apiError(400, "invalid_request");
  const id = await idFrom(params);
  if (!id) return apiError(400, "invalid_request");
  try { return apiOk({ removal: await removeAlbum(auth.context.db, auth.context.ownerId, id) }); }
  catch (error) { return albumError(error); }
}
