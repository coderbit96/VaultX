import { VaultShell } from "@/components/vault/vault-shell";
import { requireOwner } from "@/lib/auth/server";
import { getModelCollections } from "@/models";
import { getDatabase } from "@/services/database";

export default async function VaultLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const ownerId = await requireOwner();
  const owner = await getModelCollections(await getDatabase()).owners.findOne({ _id: ownerId, singletonKey: "vaultx-owner" });
  if (!owner) throw new Error("Owner session is unavailable");
  return <VaultShell autoLockMinutes={owner.settings.autoLockMinutes}>{children}</VaultShell>;
}
