"use client";

import { useEffect, useState } from "react";
import { clearVaultKeyMaterial, hasVaultRootKey, leaseVaultRootKey } from "@/lib/crypto/key-memory";

/** A volatile key is usable only after its encrypted backup exists server-side. */
export function useVaultKeyStatus() {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const clear = () => { sequence++; setUnlocked(false); };
    const verify = async () => {
      const current = ++sequence;
      setUnlocked(false);
      if (!hasVaultRootKey()) return;
      let vaultId: string;
      try {
        const lease = leaseVaultRootKey();
        vaultId = lease.vaultId;
        lease.release();
      } catch { return; }
      try {
        const response = await fetch("/api/vault/keys", { credentials: "same-origin", cache: "no-store" });
        if (!active || current !== sequence) return;
        if (response.status === 401) {
          clearVaultKeyMaterial();
          window.location.replace("/unlock");
          return;
        }
        if (!response.ok) return;
        const data = await response.json() as { status?: string; envelope?: { vaultId?: string } };
        if (!active || current !== sequence) return;
        if (data.status === "ready" && data.envelope?.vaultId === vaultId) setUnlocked(true);
        else clearVaultKeyMaterial();
      } catch { /* Keep uploads closed while key status is unavailable. */ }
    };
    window.addEventListener("vaultx:key-clear", clear);
    window.addEventListener("vaultx:key-ready", verify);
    queueMicrotask(() => { if (active) void verify(); });
    return () => {
      active = false;
      sequence++;
      window.removeEventListener("vaultx:key-clear", clear);
      window.removeEventListener("vaultx:key-ready", verify);
    };
  }, []);
  return unlocked;
}
