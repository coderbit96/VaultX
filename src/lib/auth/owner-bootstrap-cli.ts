import type { OwnerBootstrapStore } from "./owner-bootstrap";
import { bootstrapOwner, isAcceptableOwnerPassword } from "./owner-bootstrap";

export interface BootstrapCliDependencies {
  interactive: boolean;
  getStore(): Promise<OwnerBootstrapStore>;
  promptPassword(message: string): Promise<string>;
  write(message: string, error?: boolean): void;
}

export async function runOwnerBootstrapCli(deps: BootstrapCliDependencies): Promise<number> {
  if (!deps.interactive) {
    deps.write("Run owner bootstrap in an interactive VS Code terminal.", true);
    return 1;
  }

  try {
    const store = await deps.getStore();
    await store.ensureUniqueOwnerIndexes();
    if (await store.hasOwner()) {
      deps.write("Owner setup is already complete. No account was changed.", true);
      return 1;
    }

    const first = await deps.promptPassword("Create owner password");
    if (!isAcceptableOwnerPassword(first)) {
      deps.write("Use a private, randomly chosen passphrase of at least 16 characters (maximum 1024 UTF-8 bytes). Avoid common words and patterns.", true);
      return 1;
    }
    const confirmation = await deps.promptPassword("Confirm owner password");
    if (first !== confirmation) {
      deps.write("Passwords did not match. No account was created.", true);
      return 1;
    }

    const result = await bootstrapOwner(store, first);
    if (result === "created") {
      deps.write("Owner account created. Keep your password safe. Open /unlock to sign in.");
      return 0;
    }
    if (result === "already-exists") {
      deps.write("Owner setup is already complete. No account was changed.", true);
      return 1;
    }
    deps.write("Password did not meet the requirements. No account was created.", true);
    return 1;
  } catch {
    // MongoDB and native-library exceptions may include sensitive connection details.
    deps.write("Owner setup stopped or failed. Run npm run owner:status before retrying.", true);
    return 1;
  }
}
