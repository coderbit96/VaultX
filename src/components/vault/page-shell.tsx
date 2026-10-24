import Link from "next/link";
import { ArrowUpRight, CircleDashed, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type PreviewLink = { label: string; href: string; description: string };

type PageShellProps = {
  eyebrow: string;
  title: string;
  description: string;
  planned: string[];
  links?: PreviewLink[];
};

export function PageShell({ eyebrow, title, description, planned, links = [] }: PageShellProps) {
  return (
    <div className="space-y-7">
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-accent">{eyebrow} / Route shell</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-muted sm:text-base">{description}</p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-accent/25 bg-accent/5 p-4 text-sm leading-6 text-muted sm:p-5" role="note">
        <ShieldAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-accent" />
        <p><strong className="font-semibold text-foreground">Feature preview.</strong> Owner authentication protects this page. File access and storage actions are not connected yet.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Planned for this screen</CardTitle>
            <CardDescription>These capabilities are requirements, not active controls.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {planned.map((item) => (
                <li key={item} className="flex items-start gap-3 rounded-xl border border-line bg-raised/50 px-4 py-3 text-sm leading-6 text-muted">
                  <CircleDashed aria-hidden="true" size={17} className="mt-1 shrink-0 text-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Explore the shell</CardTitle>
            <CardDescription>These links open other placeholder routes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="flex min-h-16 items-center justify-between gap-3 rounded-xl border border-line bg-raised/50 px-4 py-3 transition-colors hover:border-line-strong hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none">
                <span><span className="block text-sm font-medium text-foreground">{link.label}</span><span className="mt-1 block text-xs leading-5 text-muted">{link.description}</span></span>
                <ArrowUpRight aria-hidden="true" size={18} className="shrink-0 text-accent" />
              </Link>
            ))}
            {links.length === 0 ? <p className="text-sm leading-6 text-muted">Use the navigation to inspect another route shell.</p> : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
