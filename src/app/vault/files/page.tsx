import { FolderBrowser } from "@/components/vault/folder-browser";
import { requireOwner } from "@/lib/auth/server";

export default async function FilesPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  await requireOwner();
  const raw = (await searchParams).category;
  const category = raw === "image" || raw === "video" || raw === "audio" || raw === "document" || raw === "other" ? raw : "all";
  return <FolderBrowser initialCategory={category} />;
}
