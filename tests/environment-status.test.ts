import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEnvironment } from "../src/lib/config/environment";

test("configuration check reports missing variable names without values", () => {
  const result = checkEnvironment({});
  assert.equal(result.mongodb, "invalid");
  assert.equal(result.cloudinary, "invalid");
  assert.equal(result.auth, "invalid");
  assert.deepEqual(result.issues, [
    "Check MONGODB_URI and MONGODB_DB_NAME in .env.local.",
    "Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in .env.local.",
    "Set a valid AUTH_OWNER_EMAIL in .env.local.",
    "Set AUTH_SECRET to at least 32 random bytes in .env.local.",
  ]);
});

test("configuration check accepts existing service variable names", () => {
  const result = checkEnvironment({
    MONGODB_URI: "mongodb+srv://user:example@cluster.example.mongodb.net/",
    MONGODB_DB_NAME: "vaultx",
    CLOUDINARY_CLOUD_NAME: "existing-cloud",
    CLOUDINARY_API_KEY: "1234567890",
    CLOUDINARY_API_SECRET: "example-secret",
    AUTH_OWNER_EMAIL: "owner@example.test",
    AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
  });
  assert.deepEqual(result, { mongodb: "configured", cloudinary: "configured", auth: "configured", issues: [] });
});

test("configuration check never echoes malformed secret inputs", () => {
  const secret = "private-value-that-must-not-appear";
  const result = checkEnvironment({ MONGODB_URI: secret, CLOUDINARY_API_SECRET: secret });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
