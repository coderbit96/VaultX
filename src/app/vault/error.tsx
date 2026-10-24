"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function VaultError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="rounded-3xl border border-line bg-surface p-6 sm:p-9" role="alert">
    <h1 className="text-xl font-semibold">This vault page is unavailable.</h1>
    <p className="mt-3 text-sm leading-6 text-muted">Try loading it again. You may need to unlock VaultX if your session ended.</p>
    <div className="mt-6 flex flex-wrap gap-3">
      <Button onClick={reset}>Try again</Button>
      <Link href="/unlock" className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm text-accent focus-visible:outline-2 focus-visible:outline-accent">Open unlock</Link>
    </div>
  </main>;
}
