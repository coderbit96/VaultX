import { notFound } from "next/navigation";
import { DesignPreview } from "@/components/design-preview";

export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return <DesignPreview />;
}
