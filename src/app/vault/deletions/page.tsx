import { DeletionJobs } from "@/components/vault/deletion-jobs";
import { requireOwner } from "@/lib/auth/server";

export default async function DeletionsPage() {
  await requireOwner();
  return <DeletionJobs />;
}
