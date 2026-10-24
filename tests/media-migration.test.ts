import assert from "node:assert/strict";
import test from "node:test";
import { ObjectId } from "mongodb";
import { inspectMediaCandidate, providerIdentity } from "../src/lib/migrations/media-audit";

test("legacy media is classified for client-side re-encryption without exposing filename fields", () => {
  const candidate = inspectMediaCandidate("legacyMedia", { _id: new ObjectId(), public_id: "private/legacy-photo", resource_type: "image",
    secure_url: "https://example.invalid/private/legacy-photo", original_filename: "private-photo.jpg", display_name: "Private photo", tags: ["family"] });
  assert.equal(candidate?.disposition, "requires-client-reencryption");
  assert.equal(candidate?.kind, "image");
  assert.equal(candidate?.fields.originalFilename, true);
  assert.equal(candidate?.fields.displayName, true);
  assert.equal(candidate?.fields.tags, true);
  assert.equal(JSON.stringify(candidate).includes("private-photo"), false);
  assert.equal(JSON.stringify(candidate).includes("legacy-photo"), false);
});

test("media-like metadata with no provider reference is never treated as migrated", () => {
  const candidate = inspectMediaCandidate("photos", { _id: new ObjectId(), mimeType: "image/jpeg", display_name: "missing asset" });
  assert.equal(candidate?.disposition, "missing-asset-reference");
  assert.equal(candidate?.provider, null);
});

test("provider identity distinguishes delivery mode for duplicate detection", () => {
  assert.notEqual(providerIdentity({ publicId: "same", resourceType: "image", deliveryType: "upload" }),
    providerIdentity({ publicId: "same", resourceType: "image", deliveryType: "authenticated" }));
});
