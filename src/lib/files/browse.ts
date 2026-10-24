import type { FilePublicMetadata } from "./types";

export type NamedFile = FilePublicMetadata & { name: string };
export type FileSort = "date-new" | "date-old" | "name" | "type" | "size-large" | "size-small";
export type FileFilter = "all" | FilePublicMetadata["category"];

export function filterAndSortFiles(files: NamedFile[], query: string, category: FileFilter, sort: FileSort): NamedFile[] {
  const term = query.trim().normalize("NFC").toLocaleLowerCase();
  const matches = files.filter((file) => (category === "all" || file.category === category)
    && (!term || file.name.normalize("NFC").toLocaleLowerCase().includes(term)));
  const byRecent = (a: NamedFile, b: NamedFile) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  return matches.sort((a, b) => {
    const main = sort === "name" ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : sort === "type" ? a.category.localeCompare(b.category) || a.extension.localeCompare(b.extension)
      : sort === "size-large" ? b.storedSizeBytes - a.storedSizeBytes
      : sort === "size-small" ? a.storedSizeBytes - b.storedSizeBytes
      : sort === "date-old" ? a.createdAt.localeCompare(b.createdAt) : byRecent(a, b);
    return main || byRecent(a, b);
  });
}
