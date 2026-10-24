import type { NextRequest } from "next/server";
import { authorizeOwnerApi } from "@/lib/auth/owner-api";
import { apiError, apiOk } from "@/lib/auth/api-policy";
import { parseObjectId } from "@/lib/auth/request-validation";
import { countGalleryMedia, gallerySortSchema, listGalleryMedia, parseGalleryCursor } from "@/lib/database/gallery-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const auth = await authorizeOwnerApi(request);
  if (!auth.ok) return auth.response;
  const query = request.nextUrl.searchParams;
  const allowed = new Set(["category", "sort", "after", "favorites", "counts", "album"]);
  if ([...query.keys()].some((key) => !allowed.has(key) || query.getAll(key).length !== 1)) return apiError(400, "invalid_request");
  const category = query.get("category") ?? "all";
  const parsedSort = gallerySortSchema.safeParse(query.get("sort") ?? "newest");
  const favorites = query.get("favorites") ?? "0";
  const counts = query.get("counts") ?? "0";
  if (!["all", "image", "video"].includes(category) || !parsedSort.success
    || !["0", "1"].includes(favorites) || !["0", "1"].includes(counts)) return apiError(400, "invalid_request");
  const rawAfter = query.get("after");
  const rawAlbum = query.get("album");
  const albumId = rawAlbum === null ? undefined : rawAlbum === "unorganized" ? null : parseObjectId(rawAlbum);
  if (rawAlbum !== null && rawAlbum !== "unorganized" && !albumId) return apiError(400, "invalid_request");
  const after = rawAfter === null ? undefined : parseGalleryCursor(rawAfter, parsedSort.data);
  if (rawAfter !== null && !after) return apiError(400, "invalid_request");
  try {
    const [page, totals] = await Promise.all([
      listGalleryMedia(auth.context.db, auth.context.ownerId, {
        ...(category === "all" ? {} : { category: category as "image" | "video" }),
        sort: parsedSort.data, favoriteOnly: favorites === "1", ...(albumId !== undefined ? { albumId } : {}), ...(after ? { after } : {}), limit: 36,
      }),
      counts === "1" ? countGalleryMedia(auth.context.db, auth.context.ownerId) : Promise.resolve(null),
    ]);
    return apiOk({ media: page.media, nextCursor: page.nextCursor, ...(totals ? { counts: totals } : {}) });
  } catch { return apiError(503, "unavailable"); }
}
