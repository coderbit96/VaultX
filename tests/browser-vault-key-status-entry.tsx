import { createRoot } from "react-dom/client";
import { useVaultKeyStatus } from "../src/hooks/use-vault-key-status";
import { hasVaultRootKey, installVaultRootKey } from "../src/lib/crypto/key-memory";

function KeyStatusProbe() {
  const ready = useVaultKeyStatus();
  return <output data-testid="stored-key-ready">{ready ? "ready" : "blocked"}</output>;
}

Object.assign(window, {
  vaultKeyStatusProbe: {
    install(vaultId: string) { installVaultRootKey(new Uint8Array(32).fill(7), vaultId); },
    hasKey: hasVaultRootKey,
  },
});

createRoot(document.getElementById("vault-key-status-probe")!).render(<KeyStatusProbe />);
