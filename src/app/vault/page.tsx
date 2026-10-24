import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/server";

export default async function VaultHomePage() {
  await requireOwner();
  redirect("/vault/gallery");
}
