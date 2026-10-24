import { LockKeyhole, ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { lockCurrentSession } from "@/lib/auth/server";

export default async function UnlockPage() {
  await lockCurrentSession();

  return (
    <main className="preview-glow page-safe-area flex min-h-[calc(100svh-3.5rem)] items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-10 flex items-center gap-3">
          <div aria-hidden="true" className="flex size-12 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
            <LockKeyhole size={22} strokeWidth={1.8} />
          </div>
          <div>
            <p className="text-xl font-semibold tracking-tight">VaultX</p>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">Private owner access</p>
          </div>
        </div>

        <section aria-labelledby="unlock-title" className="rounded-3xl border border-line bg-surface p-6 shadow-[0_25px_90px_rgba(0,0,0,0.28)] sm:p-9">
          <div aria-hidden="true" className="mb-7 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <ShieldCheck size={23} strokeWidth={1.8} />
          </div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-accent">Owner sign-in</p>
          <h1 id="unlock-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">Unlock your vault.</h1>
          <p className="mt-4 text-sm leading-7 text-muted">
            First, enter your sign-in password. Then enter your separate file password to open your photos and videos.
          </p>
          <LoginForm />
        </section>
      </div>
    </main>
  );
}
