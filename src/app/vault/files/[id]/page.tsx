import { FileDetails } from "@/components/vault/file-details";
import { requireOwner } from "@/lib/auth/server";
import { getDatabase } from "@/lib/database";
import { findReadyFileDetails } from "@/lib/database/files";
import { parseObjectId } from "@/lib/auth/request-validation";
import { notFound } from "next/navigation";

export default async function FilePage({ params }: { params: Promise<{ id: string }> }) {
  const ownerId = await requireOwner();
  const id = parseObjectId((await params).id);
  if (!id || !(await findReadyFileDetails(await getDatabase(), ownerId, id))) notFound();
  return <FileDetails id={id.toHexString()} />;
}
