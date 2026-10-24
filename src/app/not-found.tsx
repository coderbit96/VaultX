import Link from "next/link";

export default function NotFound() {
  return <main className="page-safe-area flex min-h-[calc(100svh-3.5rem)] items-center justify-center">
    <section className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 text-center sm:p-9">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">404</p>
      <h1 className="mt-3 text-2xl font-semibold">Page not found</h1>
      <p className="mt-3 text-sm leading-6 text-muted">This address does not lead to an available page.</p>
      <Link href="/unlock" className="mt-6 inline-flex min-h-11 items-center rounded-xl border border-line px-5 text-sm text-foreground hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent">Open unlock</Link>
    </section>
  </main>;
}
