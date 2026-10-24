import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { getCloudinary } from "@/lib/cloudinary";
import { cloudinaryDeletionProvider } from "@/lib/cloudinary/deletion-provider";
import { cloudinaryUploadProvider } from "@/lib/cloudinary/upload-provider";
import { runRecoveryPass } from "@/lib/recovery/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const body = await readJsonRequest(request, z.strictObject({}), 16);
  if (!body.ok) return apiError(400, "invalid_request");
  try {
    const cloudinary = getCloudinary();
    return apiOk(await runRecoveryPass(auth.context.db, {
      uploads: cloudinaryUploadProvider(cloudinary), deletions: cloudinaryDeletionProvider(cloudinary),
    }, new Date(), 1));
  }
  catch { return apiError(503, "unavailable"); }
}
