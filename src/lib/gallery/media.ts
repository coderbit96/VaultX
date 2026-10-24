import type { FilePublicMetadata } from "@/lib/files/types";

export type GalleryFile = FilePublicMetadata & { name: string; tags?: string[] };
export type GallerySort = "newest" | "oldest" | "name" | "size";

export function matchesGallerySearch(file: GalleryFile, rawQuery: string): boolean {
  const query = rawQuery.normalize("NFC").trim().toLocaleLowerCase();
  return !query || file.name.toLocaleLowerCase().includes(query)
    || !!file.tags?.some((tag) => tag.toLocaleLowerCase().includes(query));
}

export function appendGallerySearchPage(existing: GalleryFile[], incoming: (GalleryFile & { cursor: string })[],
  query: string, pageNextCursor: string | null, limit = 36) {
  const files = [...existing];
  for (let index = 0; index < incoming.length; index++) {
    const file = incoming[index];
    if (matchesGallerySearch(file, query)) files.push(file);
    if (files.length >= limit) return {
      files,
      nextCursor: index < incoming.length - 1 || pageNextCursor ? file.cursor : null,
      full: true,
    };
  }
  return { files, nextCursor: pageNextCursor, full: false };
}

export function mergeGalleryFiles(existing: GalleryFile[], incoming: GalleryFile[]): GalleryFile[] {
  const byId = new Map<string, GalleryFile>();
  for (const file of [...existing, ...incoming]) {
    if (file.category === "image" || file.category === "video") byId.set(file.id, file);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function visibleGalleryFiles(files: GalleryFile[], category: "all" | "image" | "video", sort: GallerySort): GalleryFile[] {
  const selected = files.filter((file) => category === "all" || file.category === category);
  return selected.sort((a, b) => {
    const order = sort === "name" ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : sort === "size" ? b.storedSizeBytes - a.storedSizeBytes
        : sort === "oldest" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt);
    return order || a.id.localeCompare(b.id);
  });
}
