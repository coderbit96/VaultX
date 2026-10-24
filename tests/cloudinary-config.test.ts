import assert from "node:assert/strict";
import test from "node:test";
import { CloudinaryConfigError, readCloudinaryConfig } from "../src/lib/cloudinary/config";

const valid = {
  CLOUDINARY_CLOUD_NAME: "vaultx-example",
  CLOUDINARY_API_KEY: "1234567890",
  CLOUDINARY_API_SECRET: "synthetic-secret-only",
};

test("accepts three explicit server-side credentials", () => {
  assert.deepEqual(readCloudinaryConfig(valid), {
    cloudName: valid.CLOUDINARY_CLOUD_NAME,
    apiKey: valid.CLOUDINARY_API_KEY,
    apiSecret: valid.CLOUDINARY_API_SECRET,
  });
});

test("requires all Cloudinary variables", () => {
  for (const name of Object.keys(valid)) {
    const env: Record<string, string | undefined> = { ...valid, [name]: undefined };
    assert.throws(() => readCloudinaryConfig(env), new RegExp(`${name} is missing`));
  }
});

test("invalid values never appear in validation errors", () => {
  const secret = "private-value-with-space ";
  assert.throws(
    () => readCloudinaryConfig({ ...valid, CLOUDINARY_API_SECRET: secret }),
    (error) => error instanceof CloudinaryConfigError && !error.message.includes(secret),
  );
  assert.throws(
    () => readCloudinaryConfig({ ...valid, CLOUDINARY_CLOUD_NAME: "bad/name" }),
    /CLOUDINARY_CLOUD_NAME has an invalid format/,
  );
});
