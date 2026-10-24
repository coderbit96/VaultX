import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "./owner-api";
import { apiError } from "./api-policy";
import { parseObjectId } from "./request-validation";
import { findOwnedReadyCiphertextFile } from "@/lib/database/files";
import type { VaultFile } from "@/lib/database/models";
import { getCloudinary } from "@/lib/cloudinary";
import { CiphertextAccessError, proxyCiphertextRange, signedCiphertextUrl, signedThumbnailUrl } from "@/lib/cloudinary/ciphertext-access";

export async function privateCiphertextRoute(request: NextRequest, rawId: string, variant: "file" | "thumbnail" = "file"): Promise<Response> {
  const authorized = await authorizeOwnerApi(request);
  if (!authorized.ok) return authorized.response;
  const id = parseObjectId(rawId);
  if (!id) return apiError(404, "not_found");
  let file: VaultFile | null = null;
  try {
    file = await findOwnedReadyCiphertextFile(authorized.context.db, authorized.context.ownerId, id);
    // Do not disclose whether a syntactically valid ID belongs to this owner.
    if (!file) return apiError(404, "not_found");
    if (variant === "thumbnail" && !file.thumbnail) return apiError(404, "not_found");
    const ownedFile = file;
    return await proxyCiphertextRange({ file: variant === "thumbnail"
      ? { ...ownedFile, storedSizeBytes: ownedFile.thumbnail!.storedSizeBytes } : ownedFile,
    range: request.headers.get("range"),
    makeUrl: () => variant === "thumbnail" ? signedThumbnailUrl(getCloudinary(), ownedFile)
      : signedCiphertextUrl(getCloudinary(), ownedFile) });
  } catch (error) {
    if (error instanceof CiphertextAccessError && error.code === "invalid_range") {
      return new Response(null, { status: 416, headers: {
        "Cache-Control": "private, no-store, max-age=0", "Content-Range": `bytes */${variant === "thumbnail" ? file?.thumbnail?.storedSizeBytes ?? "*" : file?.storedSizeBytes ?? "*"}`,
        "Accept-Ranges": "bytes", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Vary: "Cookie",
      } });
    }
    return apiError(503, "unavailable");
  }
}
