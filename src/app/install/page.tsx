import Link from "next/link";

export default function InstallHelp() {
  return <main className="page-safe-area mx-auto min-h-screen max-w-2xl space-y-8 pb-32">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">VaultX / Install</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Install VaultX</h1>
      <p className="mt-4 text-sm leading-6 text-muted">Install the vault on a phone or desktop from your browser. The installed app still requires your owner password and separate vault-key unlock. Cloud files need a connection.</p></div>
    <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="text-lg font-semibold">Android Chrome and desktop Chrome or Edge</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted"><li>Open your VaultX HTTPS address in the browser.</li><li>If an <strong>Install</strong> button appears in VaultX, use it. You can also open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li>Confirm the browser’s install dialog, then open the new VaultX icon.</li></ol></section>
    <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="text-lg font-semibold">iPhone or iPad Safari</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted"><li>Open your VaultX HTTPS address in Safari.</li><li>Tap <strong>Share</strong> (it may be under the page menu), then choose <strong>Add to Home Screen</strong>.</li><li>If offered, enable <strong>Open as Web App</strong>, then tap <strong>Add</strong>. Launch VaultX from its Home Screen icon.</li></ol>
      <p className="mt-3 text-xs leading-5 text-muted">Safari does not support VaultX’s in-page Install button. Browser labels vary by iOS version.</p></section>
    <div className="rounded-2xl border border-line bg-raised p-5 text-sm leading-6 text-muted">Offline mode shows a public connection screen only. VaultX does not save private pages, media, thumbnails, API responses, or decrypted files in the service worker. Reconnect to sign in and reach cloud content.</div>
    <Link href="/unlock" className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 text-sm font-medium text-accent-ink">Open VaultX</Link>
  </main>;
}
