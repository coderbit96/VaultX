import { LoadingIndicator } from "@/components/ui/loading-indicator";

export default function Loading() {
  return <main className="page-safe-area flex min-h-[calc(100svh-3.5rem)] items-center justify-center">
    <LoadingIndicator label="Loading VaultX" showLabel />
  </main>;
}
