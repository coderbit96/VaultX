import assert from "node:assert/strict";
import test from "node:test";
import { apiError, isEnabledPrivateApiMethod, isEnabledPrivateApiPath, isPrivateApiPath } from "../src/lib/auth/api-policy";

test("gallery route is explicitly enabled for reads only", () => {
  assert.equal(isPrivateApiPath("/api/vault/gallery"), true);
  assert.equal(isEnabledPrivateApiPath("/api/vault/gallery"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/gallery", "GET"), true);
  assert.equal(isEnabledPrivateApiMethod("/api/vault/gallery", "POST"), false);
});

test("private API error envelope is no-store", async () => {
  const response = apiError(401, "unauthorized");
  assert.equal(response.status, 401);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { error: { code: "unauthorized", message: "Authentication required." } });
});
