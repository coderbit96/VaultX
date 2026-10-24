"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

type Crumb = { label: string; href?: string };

function crumbsFor(pathname: string): Crumb[] {
  const home: Crumb = { label: "Gallery", href: "/vault/gallery" };
  const files: Crumb = { label: "Files", href: "/vault/files" };

  if (pathname === "/vault" || pathname === "/vault/gallery") return [{ label: "Gallery" }];
  if (pathname === "/vault/files") return [home, { label: "Files" }];
  if (pathname.startsWith("/vault/folders/")) return [home, files, { label: "Folder" }];
  if (pathname.startsWith("/vault/files/")) return [home, files, { label: "File shell" }];

  const labels: Record<string, string> = {
    "/vault/gallery": "Gallery",
    "/vault/uploads": "Uploads",
    "/vault/settings": "Settings",
    "/vault/deletions": "Deletions",
  };
  return [home, { label: labels[pathname] ?? "Page shell" }];
}

export function Breadcrumbs() {
  const pathname = usePathname();
  const crumbs = crumbsFor(pathname);

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex min-w-0 items-center gap-1.5 text-xs text-muted sm:text-sm">
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <ChevronRight aria-hidden="true" size={14} className="shrink-0 text-line-strong" /> : null}
            {crumb.href ? (
              <Link href={crumb.href} className="truncate rounded px-1 py-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current="page" className="truncate px-1 py-2 font-medium text-foreground">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
