import { UploadManager } from "@/components/vault/upload-manager";
import { requireOwner } from "@/lib/auth/server";

export default async function UploadsPage() {
  await requireOwner();
  return <UploadManager />;
}
