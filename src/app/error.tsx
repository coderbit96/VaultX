"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="page-safe-area flex min-h-[calc(100svh-3.5rem)] items-center justify-center">
    <section className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 text-center sm:p-9" role="alert">
      <h1 className="text-2xl font-semibold">VaultX could not open this page.</h1>
      <p className="mt-3 text-sm leading-6 text-muted">Please try again. If the problem continues, return to the unlock screen.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link href="/unlock" className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm text-accent focus-visible:outline-2 focus-visible:outline-accent">Open unlock</Link>
      </div>
    </section>
  </main>;
}
