"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut as authJsSignOut } from "next-auth/react";
import { Images, LockKeyhole, LogOut, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { cn } from "@/lib/cn";
import { Breadcrumbs } from "./breadcrumbs";
import { LockManager } from "./lock-manager";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";
import { clearOfflineCopies, listOfflineCopies, removeOfflineCopy } from "@/lib/offline/copies";
import { onFileDeleting } from "@/lib/files/deletion-events";

const primaryNavigation = [
  { label: "Gallery", href: "/vault/gallery", icon: Images },
  { label: "Settings", href: "/vault/settings", icon: Settings2 },
] as const;

function isActive(pathname: string, href: string) {
  return pathname === href;
}

export function VaultShell({ children, autoLockMinutes }: { children: ReactNode; autoLockMinutes: number }) {
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const stop = onFileDeleting((id) => { void (id === "*" ? clearOfflineCopies() : removeOfflineCopy(id)).catch(() => undefined); });
    const reconcile = () => {
      void listOfflineCopies().then(async (copies) => {
        for (const copy of copies) {
          const response = await fetch(`/api/files/${copy.id}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
          if (response?.status === 404) await removeOfflineCopy(copy.id);
        }
      }).catch(() => undefined);
    };
    if (navigator.onLine) reconcile();
    window.addEventListener("online", reconcile);
    return () => { stop(); window.removeEventListener("online", reconcile); };
  }, []);

  async function signOut() {
    document.documentElement.dataset.vaultLocked = "true";
    clearVaultKeyMaterial();
    setSigningOut(true);
    try {
      await clearOfflineCopies();
      const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error("Sign-out failed");
      await authJsSignOut({ redirect: false });
      window.location.replace("/unlock");
    } catch {
      setSigningOut(false);
      window.alert("Could not clear offline copies or finish sign-out. Close other VaultX tabs, then try again.");
    }
  }

  return (
    <div id="vault-shell" className="min-h-screen bg-canvas md:flex">
      <a href="#vault-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-accent focus:px-4 focus:py-3 focus:text-accent-ink">Skip to content</a>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface/70 px-4 py-6 md:sticky md:top-0 md:flex md:h-screen">
        <Link href="/vault/gallery" className="mb-12 flex min-h-11 items-center gap-3 rounded-xl px-3 focus-visible:outline-2 focus-visible:outline-accent">
          <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><LockKeyhole size={20} /></span>
          <span><span className="block text-lg font-semibold tracking-tight">VaultX</span><span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Owner session</span></span>
        </Link>

        <nav aria-label="Desktop navigation" className="space-y-1">
          {primaryNavigation.map(({ label, href, icon: Icon }) => (
            <Link key={href} href={href} aria-current={isActive(pathname, href) ? "page" : undefined} className={cn(
              "flex min-h-12 items-center gap-3 rounded-xl px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none",
              isActive(pathname, href) ? "bg-accent/10 text-accent" : "text-muted hover:bg-raised hover:text-foreground",
            )}>
              <Icon aria-hidden="true" size={19} strokeWidth={1.8} />{label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="vault-header sticky z-30 border-b border-line bg-canvas/90 backdrop-blur-xl">
          <div className="page-inline-safe mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent md:hidden"><LockKeyhole size={19} /></span>
              <Breadcrumbs />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <LockManager autoLockMinutes={autoLockMinutes} />
              <Button variant="ghost" size="small" onClick={signOut} disabled={signingOut} aria-label="Sign out"><LogOut aria-hidden="true" size={17} /><span className="hidden sm:inline">{signingOut ? "Signing out…" : "Sign out"}</span></Button>
            </div>
          </div>
        </header>

        <main id="vault-main" tabIndex={-1} className="page-inline-safe mx-auto max-w-6xl pb-40 pt-8 outline-none sm:pt-12 md:pb-24">{children}</main>
      </div>

      <nav aria-label="Mobile navigation" className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 border-t border-line bg-surface/95 px-2 pt-2 backdrop-blur-xl md:hidden">
        {primaryNavigation.map(({ label, href, icon: Icon }) => (
          <Link key={href} href={href} aria-current={isActive(pathname, href) ? "page" : undefined} className={cn(
            "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none",
            isActive(pathname, href) ? "text-accent" : "text-muted hover:text-foreground",
          )}>
            <Icon aria-hidden="true" size={21} strokeWidth={1.8} />{label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
