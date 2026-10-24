"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { clearVaultKeyMaterial } from "@/lib/crypto/key-memory";
import { onFileDeleting } from "@/lib/files/deletion-events";

type Job = { id: string; targetId: string; targetType: "file" | "folder";
  folderCount: number; fileCount: number; status: "pending" | "running" | "retrying" | "failed" | "completed";
  phase: "inventorying" | "deleting" | "remote-delete-confirmed" | "metadata-removed" | "completed";
  attempts: number; remainingObjects: number; nextAttemptAt: string | null; lastErrorCode: string | null;
  createdAt: string; updatedAt: string };
type View = { state: "loading" | "ready" | "error"; jobs: Job[]; more: boolean };

function label(job: Job): string {
  if (job.status === "completed") return "Completed in active storage";
  if (job.status === "failed") return "Needs attention";
  if (job.status === "retrying") return "Waiting to retry";
  if (job.phase === "metadata-removed") return "Finalizing job";
  if (job.phase === "remote-delete-confirmed") return "Removing database record";
  if (job.status === "running") return "Checking Cloudinary";
  if (job.phase === "deleting" && job.attempts > 0) return "Removing encrypted objects";
  return "Queued";
}

export function DeletionJobs() {
  const [view, setView] = useState<View>({ state: "loading", jobs: [], more: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const [checking, setChecking] = useState(false);
  const request = useRef<AbortController | null>(null);
  const reconciling = useRef(false);
  const load = useCallback(async (quiet = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    if (!quiet) setView((previous) => ({ ...previous, state: "loading" }));
    try {
      const response = await fetch("/api/deletions", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (!response.ok) throw new Error("load_failed");
      const data = await response.json() as { deletions: Job[]; more: boolean };
      if (!controller.signal.aborted) setView({ state: "ready", jobs: data.deletions, more: data.more });
    } catch { if (!controller.signal.aborted) setView((previous) => ({ ...previous, state: "error" })); }
  }, []);
  const reconcile = useCallback(async () => {
    if (reconciling.current) return;
    reconciling.current = true;
    setChecking(true);
    try {
      const response = await fetch("/api/deletions/reconcile", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (!response.ok) throw new Error("Recovery check is unavailable. Saved jobs can be retried later.");
      await load(true);
    } catch (reason) { setRetryError(reason instanceof Error ? reason.message : "Recovery check failed."); await load(true); }
    finally { reconciling.current = false; setChecking(false); }
  }, [load]);
  useEffect(() => {
    queueMicrotask(() => { void load(); void reconcile(); });
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void reconcile(); }, 60_000);
    const stop = onFileDeleting(() => { void load(true); });
    return () => { window.clearInterval(interval); request.current?.abort(); stop(); };
  }, [load, reconcile]);
  async function retry(id: string) {
    setBusy(id); setRetryError("");
    try {
      const response = await fetch(`/api/deletions/${id}/retry`, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      if (response.status === 401) { clearVaultKeyMaterial(); window.location.replace("/unlock"); return; }
      if (!response.ok) throw new Error("Retry could not start. The job remains recorded; try again later.");
      await load(true);
    } catch (reason) { setRetryError(reason instanceof Error ? reason.message : "Retry could not start."); }
    finally { setBusy(null); }
  }
  return <div className="space-y-7">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Activity / Deletions</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Permanent deletion</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">A file or folder tree disappears from normal views when its durable job starts. Completion means its active Cloudinary objects and MongoDB records were confirmed removed.</p></div>
      <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={checking} onClick={() => void reconcile()}><RefreshCw size={17} aria-hidden="true" />{checking ? "Checking…" : "Check recovery now"}</Button>
        <Button type="button" variant="secondary" onClick={() => void load()}>Refresh status</Button></div></div>
    {retryError && <p role="alert" className="rounded-xl border border-danger/35 bg-danger/10 p-4 text-sm text-danger">{retryError}</p>}
    {view.state === "loading" && <div role="status" aria-label="Loading deletion jobs" className="space-y-3"><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-32 rounded-2xl" /></div>}
    {view.state === "error" && <EmptyState icon={<AlertCircle size={24} />} title="Deletion status is unavailable" description="Jobs stay in the database. Check your connection and try again." action={<Button type="button" onClick={() => void load()}>Try again</Button>} />}
    {view.state === "ready" && (view.jobs.length === 0 ? <EmptyState icon={<Trash2 size={24} />} title="No deletions yet" description="Use Delete permanently from a file or folder. A confirmation appears before the job starts." action={<Link href="/vault/files" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink">Browse files</Link>} /> :
      <ul className="space-y-3">{view.jobs.map((job) => <li key={job.id} className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised text-accent">{job.status === "completed" ? <CheckCircle2 size={21} /> : job.status === "failed" ? <AlertCircle size={21} /> : <Clock3 size={21} />}</span>
          <div><p className="font-medium">{job.targetType === "folder" ? "Folder tree" : "File"} · …{job.targetId.slice(-6)}</p><p className="mt-1 text-sm text-muted">{label(job)}</p></div></div>
          {(["failed", "pending", "retrying"] as Job["status"][]).includes(job.status) && <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void retry(job.id)}>{busy === job.id ? "Trying…" : "Retry now"}</Button>}
        </div>
        {job.status !== "completed" && <p className="mt-4 text-xs text-muted">{job.remainingObjects} Cloudinary object{job.remainingObjects === 1 ? "" : "s"} awaiting confirmation · Attempt {job.attempts}{job.nextAttemptAt ? ` · Next retry after ${new Date(job.nextAttemptAt).toLocaleString()}` : ""}</p>}
        {job.targetType === "folder" && <p className="mt-2 text-xs text-muted">{job.folderCount.toLocaleString()} folders · {job.fileCount.toLocaleString()} files in the recorded subtree</p>}
        {job.lastErrorCode && <p className="mt-2 text-xs text-danger">Last issue: {job.lastErrorCode.replace(/_/g, " ")}. The job remains saved.</p>}
      </li>)}</ul>)}
    {view.state === "ready" && view.more && <p className="text-xs text-muted">Showing the newest 100 jobs. Older jobs remain stored.</p>}
    <p className="rounded-2xl border border-line bg-surface p-4 text-xs leading-5 text-muted">Due jobs retry while this page is open. To recover while VaultX is closed, schedule the protected recovery script on a trusted server. Jobs that need manual attention remain saved. Cloudinary CDN invalidation can take time to propagate.</p>
  </div>;
}
