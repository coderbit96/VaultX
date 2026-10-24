import { LoadingIndicator } from "@/components/ui/loading-indicator";

export default function VaultLoading() {
  return <main className="flex min-h-64 items-center justify-center" aria-label="Loading vault page">
    <LoadingIndicator label="Loading vault page" showLabel />
  </main>;
}
