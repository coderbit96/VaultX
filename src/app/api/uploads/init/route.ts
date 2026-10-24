import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, privateApiHeaders } from "@/lib/auth/api-policy";
import { readJsonRequest } from "@/lib/auth/request-validation";
import { reserveUploadIntent, uploadInitInput, UploadIntentError } from "@/lib/cloudinary/upload-intent";
import { FolderOperationError } from "@/lib/database/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const parsed = await readJsonRequest(request, uploadInitInput, 2_048);
  if (!parsed.ok) return apiError(400, "invalid_request");
  try {
    const job = await reserveUploadIntent(auth.context.db, auth.context.ownerId, parsed.data);
    // No Cloudinary signature, URL, key or public ID leaves this endpoint.
    return Response.json({ upload: { id: job._id.toHexString(), fileId: job.fileId.toHexString(),
      status: job.status, expiresAt: job.intentExpiresAt?.toISOString(),
      ciphertextBytes: job.ciphertextBytes, transferAvailable: job.ciphertextBytes! < 10_000_000 } },
    { status: 201, headers: privateApiHeaders });
  } catch (error) {
    if (error instanceof FolderOperationError) return apiError(error.code === "not_found" ? 404 : 503,
      error.code === "not_found" ? "not_found" : "unavailable");
    if (error instanceof UploadIntentError) {
      const status = error.code === "rate_limited" ? 429 : error.code === "not_found" ? 404
        : error.code === "vault_setup_required" ? 409
        : error.code === "invalid_request" ? 400 : 503;
      return apiError(status, error.code);
    }
    return apiError(503, "unavailable");
  }
}
