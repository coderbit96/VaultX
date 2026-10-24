import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId } from "@/lib/auth/request-validation";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryUploadProvider } from "@/lib/cloudinary/upload-provider";
import { mongoUploadStore } from "@/lib/database/upload-lifecycle-store";
import { cancelUpload, uploadStatus, UploadLifecycleError } from "@/lib/uploads/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await context.params).id);
  if (!id) return apiError(404, "not_found");
  try { return apiOk({ upload: await uploadStatus(mongoUploadStore(auth.context.db), auth.context.ownerId, id) }); }
  catch (error) { return error instanceof UploadLifecycleError && error.code === "not_found"
    ? apiError(404, "not_found") : apiError(503, "unavailable"); }
}

export async function DELETE(request: NextRequest, context: Context): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const id = parseObjectId((await context.params).id);
  if (!id) return apiError(404, "not_found");
  try {
    return apiOk({ upload: await cancelUpload(mongoUploadStore(auth.context.db),
      cloudinaryUploadProvider(getCloudinary()), auth.context.ownerId, id) });
  } catch (error) {
    if (error instanceof UploadLifecycleError) {
      if (error.code === "not_found") return apiError(404, "not_found");
      if (error.code === "conflict") return apiError(409, "upload_conflict");
    }
    return apiError(503, "unavailable");
  }
}
