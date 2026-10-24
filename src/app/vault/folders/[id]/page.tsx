import { FolderBrowser } from "@/components/vault/folder-browser";
import { requireOwner } from "@/lib/auth/server";
import { getDatabase } from "@/lib/database";
import { findOwnedFolder } from "@/lib/auth/owned-resources";
import { notFound } from "next/navigation";

export default async function FolderPage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwner();
  const id = (await params).id;
  const folder = await findOwnedFolder(await getDatabase(), ownerId, id);
  if (!folder || folder.status !== "active") notFound();
  return <FolderBrowser parentId={id} />;
}
