import { SimpleGallery } from "@/components/vault/simple-gallery";
import { requireOwner } from "@/lib/auth/server";

export default async function GalleryPage() {
  await requireOwner();
  return <SimpleGallery />;
}
