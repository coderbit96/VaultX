import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId } from "@/lib/auth/request-validation";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryUploadProvider } from "@/lib/cloudinary/upload-provider";
import { mongoUploadStore } from "@/lib/database/upload-lifecycle-store";
import { transferCiphertext } from "@/lib/uploads/transfer";
import { UploadLifecycleError } from "@/lib/uploads/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: Context): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await context.params).id);
  if (!id) return apiError(404, "not_found");
  const variant = request.nextUrl.searchParams.get("variant");
  if (variant !== null && variant !== "thumbnail") return apiError(400, "invalid_request");
  try {
    const result = await transferCiphertext(mongoUploadStore(auth.context.db), cloudinaryUploadProvider(getCloudinary()),
      auth.context.ownerId, id, request, new Date(), variant === "thumbnail" ? 1 : 0);
    return apiOk({ upload: { id: id.toHexString(), status: result === "cancelled" ? "cancelled" : "verifying" } });
  } catch (error) {
    if (error instanceof UploadLifecycleError) {
      if (error.code === "not_found") return apiError(404, "not_found");
      if (error.code === "invalid_request") return apiError(400, "invalid_request");
      if (error.code === "conflict") return apiError(409, "upload_conflict");
      if (["provider_mismatch", "oversize"].includes(error.code)) return apiError(422, "upload_verification_failed");
    }
    return apiError(503, "unavailable");
  }
}
