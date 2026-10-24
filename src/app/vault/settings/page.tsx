import { AutoLockSetting } from "@/components/vault/auto-lock-setting";
import { VaultKeySettings } from "@/components/vault/vault-key-settings";
import { LoginPasswordSetting, SessionSettings } from "@/components/vault/security-controls";
import { DeviceSecuritySettings } from "@/components/vault/device-security-settings";
import { OfflineSettings } from "@/components/vault/offline-settings";
import { requireOwner } from "@/lib/auth/server";
import { getDatabase } from "@/lib/database";
import { getModelCollections } from "@/models";
import { getStorageSummary } from "@/lib/database/summary";

export default async function SettingsPage() {
  const ownerId = await requireOwner();
  const db = await getDatabase();
  const owner = await getModelCollections(db).owners.findOne({ _id: ownerId, singletonKey: "vaultx-owner" });
  if (!owner) throw new Error("Owner settings are unavailable");
  const storage = await getStorageSummary(db, ownerId, null).catch(() => null);
  return <main className="max-w-2xl">
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Settings</p>
    <h1 className="mt-3 text-3xl font-semibold tracking-tight">Security preferences</h1>
    <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="lock-heading">
      <h2 id="lock-heading" className="text-xl font-semibold">Automatic lock</h2>
      <AutoLockSetting initialMinutes={owner.settings.autoLockMinutes} />
    </section>
    <SessionSettings />
    <DeviceSecuritySettings />
    <LoginPasswordSetting />
    <VaultKeySettings />
    <OfflineSettings />
    <section className="mt-8 rounded-3xl border border-line bg-surface p-6 sm:p-8" aria-labelledby="storage-heading">
      <h2 id="storage-heading" className="text-xl font-semibold">Storage and provider limits</h2>
      {storage ? <p className="mt-3 text-sm leading-6">{storage.fileCount} ready files use {new Intl.NumberFormat("en", { style: "unit", unit: "byte", unitDisplay: "short", notation: "compact", maximumFractionDigits: 1 }).format(storage.storedBytes)} of encrypted Cloudinary objects, including {storage.thumbnailBytes.toLocaleString()} thumbnail bytes.</p>
        : <p className="mt-3 text-sm text-muted">Storage totals are unavailable right now. Try reloading.</p>}
      <p className="mt-3 text-sm leading-6 text-muted">VaultX requires encrypted images below 1,000,000 bytes and encrypted videos below 100,000,000 bytes. This Cloudinary Free account last reported a 10,485,760-byte raw-object cap, so large videos may be rejected well before the VaultX video limit. Current plan quota, bandwidth and billing are available in your Cloudinary Console; VaultX does not read live remaining quota here.</p>
      <p className="mt-3 text-xs leading-5 text-muted">Totals count ready, owner-scoped ciphertext objects recorded in MongoDB. Pending or failed uploads do not count. The provider may use different billing measurements.</p>
    </section>
    <p className="mt-6 text-sm leading-6 text-muted">Browser and operating system memory cannot be guaranteed erased immediately.</p>
  </main>;
}
