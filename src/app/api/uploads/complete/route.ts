import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId, readJsonRequest } from "@/lib/auth/request-validation";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryUploadProvider } from "@/lib/cloudinary/upload-provider";
import { mongoUploadStore } from "@/lib/database/upload-lifecycle-store";
import { completeInputSchema, completeUpload, UploadLifecycleError } from "@/lib/uploads/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonRequest(request, completeInputSchema, 2_048);
  if (!parsed.ok) return apiError(400, "invalid_request");
  const { id, ...metadata } = parsed.data;
  try {
    const result = await completeUpload(mongoUploadStore(auth.context.db),
      cloudinaryUploadProvider(getCloudinary()), auth.context.ownerId, parseObjectId(id)!, metadata);
    return apiOk({ upload: result });
  } catch (error) {
    if (error instanceof UploadLifecycleError) {
      if (error.code === "not_found") return apiError(404, "not_found");
      if (error.code === "invalid_request") return apiError(400, "invalid_request");
      if (error.code === "conflict") return apiError(409, "upload_conflict");
      if (["missing_asset", "provider_mismatch", "oversize"].includes(error.code)) return apiError(422, "upload_verification_failed");
    }
    return apiError(503, "unavailable");
  }
}
