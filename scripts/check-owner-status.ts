import { loadEnvConfig } from "@next/env";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  try {
    const count = await (await getDatabase()).collection("owners").countDocuments({});
    if (count === 0) console.log("No owner account is initialized.");
    else if (count === 1) console.log("Exactly one owner account exists.");
    else {
      console.error("Owner count is invalid; stop and inspect Atlas before continuing.");
      process.exitCode = 1;
    }
  } catch {
    console.error("Could not check owner status. Check Atlas access and local configuration.");
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
