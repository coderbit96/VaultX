import { loadEnvConfig } from "@next/env";
import { closeDatabaseConnection, pingDatabase } from "../src/lib/database/client";
import { DatabaseConfigError } from "../src/lib/database/config";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

  try {
    await pingDatabase();
    console.log("MongoDB connection OK. Atlas responded to ping.");
  } catch (error) {
    console.error(
      error instanceof DatabaseConfigError
        ? error.message
        : "MongoDB connection failed. Check the Atlas cluster, database user, URI, and IP access list.",
    );
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
