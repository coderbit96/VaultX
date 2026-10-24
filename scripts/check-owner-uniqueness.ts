import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { MongoServerError } from "mongodb";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { modelIndexes } from "../src/lib/database/model-indexes";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const name = `bootstrap_index_check_${randomBytes(8).toString("hex")}`;
  let created = false;
  try {
    const collection = (await getDatabase()).collection(name);
    await collection.createIndexes(modelIndexes.owners);
    created = true;
    const attempts = await Promise.allSettled([
      collection.insertOne({ singletonKey: "vaultx-owner", username: "synthetic-one" }),
      collection.insertOne({ singletonKey: "vaultx-owner", username: "synthetic-two" }),
    ]);
    const successes = attempts.filter((result) => result.status === "fulfilled");
    const duplicate = attempts.find((result) => result.status === "rejected");
    if (successes.length !== 1 || duplicate?.status !== "rejected" ||
      !(duplicate.reason instanceof MongoServerError) || duplicate.reason.code !== 11000 ||
      await collection.countDocuments() !== 1) {
      throw new Error("Unique index check failed");
    }
    console.log("Atlas unique owner index rejected a concurrent second insert.");
  } catch {
    console.error("Owner uniqueness check failed. No owner account was created.");
    process.exitCode = 1;
  } finally {
    if (created) {
      try {
        await (await getDatabase()).collection(name).drop();
      } catch {
        console.error("Temporary index-check collection cleanup failed; inspect Atlas.");
        process.exitCode = 1;
      }
    }
    await closeDatabaseConnection().catch(() => undefined);
  }
}

void main();
