"use client";

import { toast } from "sonner";
import {
  ArrowRight, Bell, Check, ChevronRight, CircleHelp, FolderOpen,
  Layers3, LockKeyhole, Palette, Plus, Search, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FileIcon, type FileCategory } from "@/components/ui/file-icon";
import { Input } from "@/components/ui/input";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { Skeleton } from "@/components/ui/skeleton";

const fileCategories: Array<{ category: FileCategory; label: string }> = [
  { category: "image", label: "Images" },
  { category: "video", label: "Videos" },
  { category: "audio", label: "Audio" },
  { category: "document", label: "Documents" },
  { category: "archive", label: "Archives" },
  { category: "other", label: "Other" },
];

const palette = [
  { name: "Canvas", value: "#0B0D0E", className: "bg-canvas" },
  { name: "Surface", value: "#121517", className: "bg-surface" },
  { name: "Raised", value: "#1A1E20", className: "bg-raised" },
  { name: "Line", value: "#30363A", className: "bg-line" },
  { name: "Accent", value: "#BEDFA9", className: "bg-accent" },
];

function SectionHeading({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="mb-6 flex flex-col gap-2 sm:mb-8 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-accent">{number} / Components</p>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h2>
      </div>
      <p className="max-w-sm text-sm leading-6 text-muted">{description}</p>
    </div>
  );
}

function previewToast(label: string) {
  toast.info(`${label} preview`, {
    description: "This is a local design demo. No vault action was performed.",
  });
}

export function DesignPreview() {
  return (
    <main className="preview-glow min-h-screen">
      <div className="page-safe-area mx-auto max-w-7xl">
        <header className="flex items-center justify-between gap-4 border-b border-line/70 pb-5 sm:pb-6">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="flex size-11 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
              <LockKeyhole size={20} strokeWidth={1.8} />
            </div>
            <div>
              <p className="text-lg font-semibold leading-none tracking-tight">VaultX</p>
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">Interface system</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 text-[11px] font-medium text-muted sm:px-4 sm:text-xs">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
            <span className="min-[400px]:hidden">Preview</span>
            <span className="hidden min-[400px]:inline">Visual preview only</span>
          </span>
        </header>

        <section className="grid gap-10 py-14 sm:py-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-16 lg:py-24" aria-labelledby="hero-title">
          <div>
            <p className="mb-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-accent">
              <span className="h-px w-8 bg-accent/60" /> Design foundation / 01
            </p>
            <h1 id="hero-title" className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.055em] sm:text-5xl lg:text-6xl">
              Quiet design for <span className="text-accent">a private place.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
              A focused visual language for VaultX: calm surfaces, precise controls, and clear states across phone and desktop.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href="#components" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none">
                Explore components <ArrowRight aria-hidden="true" size={17} />
              </a>
              <span className="text-xs text-muted">No files or accounts are connected.</span>
            </div>
          </div>
          <div className="relative min-h-72 overflow-hidden rounded-3xl border border-line bg-surface p-6 shadow-[0_30px_90px_rgba(0,0,0,0.26)] sm:min-h-80 sm:p-8" aria-label="Visual study of VaultX design tokens">
            <div aria-hidden="true" className="absolute -right-20 -top-20 size-72 rounded-full border border-accent/10" />
            <div aria-hidden="true" className="absolute -right-10 -top-10 size-56 rounded-full border border-accent/15" />
            <div className="relative flex items-start justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">Surface study</span>
              <Palette aria-hidden="true" size={18} className="text-accent" />
            </div>
            <div className="relative mt-14 max-w-xs rounded-2xl border border-line-strong bg-raised p-5 shadow-2xl sm:mt-20">
              <div className="flex items-center gap-4">
                <div className="flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent"><ShieldCheck aria-hidden="true" size={24} /></div>
                <div><p className="text-sm font-semibold">Designed for clarity</p><p className="mt-1 text-xs text-muted">Contrast · focus · calm</p></div>
              </div>
              <div className="mt-5 h-px bg-line" />
              <div className="mt-5 flex gap-2" aria-hidden="true">
                <span className="h-2.5 w-16 rounded-full bg-accent" /><span className="h-2.5 w-10 rounded-full bg-line-strong" /><span className="h-2.5 w-7 rounded-full bg-line" />
              </div>
            </div>
            <p className="absolute bottom-6 right-6 text-[11px] uppercase tracking-[0.2em] text-muted/80 sm:bottom-8 sm:right-8">VX / 001</p>
          </div>
        </section>

        <div id="components" className="space-y-16 border-t border-line/70 pt-12 sm:space-y-20 sm:pt-16">
          <section aria-label="Color palette">
            <SectionHeading number="01" title="Color & surface" description="Charcoal layers and a restrained sage accent keep attention on the content." />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {palette.map((color) => (
                <div key={color.name} className="overflow-hidden rounded-2xl border border-line bg-surface">
                  <div className={`h-24 border-b border-line sm:h-28 ${color.className}`} />
                  <div className="px-4 py-3"><p className="text-sm font-medium text-foreground">{color.name}</p><p className="mt-1 font-mono text-[11px] text-muted">{color.value}</p></div>
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Controls">
            <SectionHeading number="02" title="Controls" description="Generous touch targets, visible keyboard focus, and readable field states." />
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Buttons</CardTitle><CardDescription>Each button shows only a local toast preview.</CardDescription></CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => previewToast("Primary action")}><Plus aria-hidden="true" size={17} /> Primary</Button>
                  <Button variant="secondary" onClick={() => previewToast("Secondary action")}>Secondary</Button>
                  <Button variant="ghost" onClick={() => previewToast("Quiet action")}>Quiet <ChevronRight aria-hidden="true" size={17} /></Button>
                  <Button variant="danger" onClick={() => previewToast("Caution action")}>Caution</Button>
                  <Button disabled>Disabled</Button>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Inputs</CardTitle><CardDescription>Editable examples; no search or sign-in is connected.</CardDescription></CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <label htmlFor="example-search" className="mb-2 block text-sm font-medium text-foreground">Search style</label>
                    <div className="relative"><Search aria-hidden="true" size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" /><Input id="example-search" type="search" placeholder="Search preview" className="pl-11" aria-describedby="search-help" /></div>
                    <p id="search-help" className="mt-2 text-xs text-muted">Visual input only; nothing is searched.</p>
                  </div>
                  <div><label htmlFor="example-disabled" className="mb-2 block text-sm font-medium text-foreground">Unavailable state</label><Input id="example-disabled" placeholder="Not available yet" disabled /></div>
                  <div><label htmlFor="example-error" className="mb-2 block text-sm font-medium text-foreground">Validation style</label><Input id="example-error" defaultValue="Example input" aria-invalid="true" aria-describedby="error-help" /><p id="error-help" className="mt-2 text-xs text-danger">Example message for an invalid value.</p></div>
                </CardContent>
              </Card>
            </div>
          </section>

          <section aria-label="Files and states">
            <SectionHeading number="03" title="Files & states" description="Simple category marks and honest empty or loading states for future vault screens." />
            <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
              <Card>
                <CardHeader><CardTitle>File categories</CardTitle><CardDescription>Icons are examples, not stored files.</CardDescription></CardHeader>
                <CardContent className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3">
                  {fileCategories.map(({ category, label }) => (
                    <div key={category} className="flex items-center gap-3 rounded-xl border border-line bg-raised/50 p-3"><FileIcon category={category} /><span className="text-sm font-medium text-foreground">{label}</span></div>
                  ))}
                </CardContent>
              </Card>
              <EmptyState icon={<FolderOpen size={25} strokeWidth={1.7} />} title="Nothing to display yet" description="Empty states will explain what belongs here once the vault features are built." className="min-h-72 justify-center" />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Loading pattern</CardTitle><CardDescription>Structural placeholders do not invent progress percentages.</CardDescription></CardHeader>
                <CardContent className="flex items-center gap-4"><Skeleton className="size-12 shrink-0 rounded-xl" /><div className="flex-1 space-y-2.5"><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-4/5" /></div><LoadingIndicator label="Loading preview" /></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Status language</CardTitle><CardDescription>Labels remain readable without relying on color alone.</CardDescription></CardHeader>
                <CardContent className="flex flex-wrap gap-3">
                  <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-medium text-accent"><Check aria-hidden="true" size={14} /> Ready style</span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-raised px-3 py-2 text-xs font-medium text-muted"><Layers3 aria-hidden="true" size={14} /> Pending style</span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"><CircleHelp aria-hidden="true" size={14} /> Needs attention style</span>
                </CardContent>
              </Card>
            </div>
          </section>

          <section aria-label="Feedback and overlays">
            <SectionHeading number="04" title="Feedback & overlays" description="Dialogs manage focus and Escape; toasts announce brief local feedback." />
            <Card>
              <CardContent className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div><h3 className="text-lg font-semibold">Interaction previews</h3><p className="mt-2 max-w-lg text-sm leading-6 text-muted">These examples only demonstrate visual and keyboard behavior. They do not change vault data.</p></div>
                <div className="flex flex-wrap gap-3">
                  <Dialog>
                    <DialogTrigger asChild><Button variant="secondary"><Layers3 aria-hidden="true" size={17} /> Open dialog</Button></DialogTrigger>
                    <DialogContent>
                      <div aria-hidden="true" className="mb-5 flex size-12 items-center justify-center rounded-xl bg-accent/10 text-accent"><ShieldCheck size={23} /></div>
                      <DialogTitle>Dialog preview</DialogTitle>
                      <DialogDescription>This is an accessible overlay example. It has no connection to files, accounts, or settings.</DialogDescription>
                      <div className="mt-7 flex justify-end"><DialogClose asChild><Button variant="secondary">Close preview</Button></DialogClose></div>
                    </DialogContent>
                  </Dialog>
                  <Button onClick={() => previewToast("Notification")}><Bell aria-hidden="true" size={17} /> Show toast</Button>
                </div>
              </CardContent>
            </Card>
          </section>
        </div>
        <footer className="mt-16 flex flex-col gap-3 border-t border-line/70 pt-6 text-xs leading-5 text-muted sm:mt-20 sm:flex-row sm:items-center sm:justify-between">
          <span>VaultX interface system · visual foundation</span>
          <span>Authentication, encryption, uploads, and storage are not implemented.</span>
        </footer>
      </div>
    </main>
  );
}
