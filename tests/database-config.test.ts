import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseConfigError, readDatabaseConfig } from "../src/lib/database/config";

test("accepts a valid Atlas connection string and database name", () => {
  const config = readDatabaseConfig({
    MONGODB_URI: "mongodb+srv://user:password@example.mongodb.net/",
    MONGODB_DB_NAME: "vaultx",
  });
  assert.equal(config.name, "vaultx");
});

test("requires both environment variables", () => {
  assert.throws(() => readDatabaseConfig({}), DatabaseConfigError);
  assert.throws(
    () => readDatabaseConfig({ MONGODB_URI: "mongodb+srv://user:password@example.mongodb.net/" }),
    /MONGODB_DB_NAME is missing/,
  );
});

test("rejects malformed values without echoing credentials", () => {
  const uri = " mongodb+srv://user:private-password@example.mongodb.net/";
  assert.throws(
    () => readDatabaseConfig({ MONGODB_URI: uri, MONGODB_DB_NAME: "vaultx" }),
    (error) =>
      error instanceof DatabaseConfigError && !error.message.includes("private-password"),
  );
  assert.throws(
    () => readDatabaseConfig({ MONGODB_URI: uri.trim(), MONGODB_DB_NAME: "invalid/name" }),
    /MONGODB_DB_NAME is not a valid/,
  );
});
