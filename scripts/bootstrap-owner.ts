import { loadEnvConfig } from "@next/env";
import passwordPrompt from "@inquirer/password";
import { runOwnerBootstrapCli } from "../src/lib/auth/owner-bootstrap-cli";
import { createMongoOwnerBootstrapStore } from "../src/lib/auth/owner-bootstrap";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

  try {
    process.exitCode = await runOwnerBootstrapCli({
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      async getStore() {
        return createMongoOwnerBootstrapStore(await getDatabase());
      },
      promptPassword(message) {
        return passwordPrompt({ message, mask: false, toggleMask: false });
      },
      write(message, error) {
        if (error) console.error(message);
        else console.log(message);
      },
    });
  } finally {
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
