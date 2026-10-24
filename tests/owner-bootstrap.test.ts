import assert from "node:assert/strict";
import test from "node:test";
import argon2 from "argon2";
import { MongoServerError } from "mongodb";
import { runOwnerBootstrapCli } from "../src/lib/auth/owner-bootstrap-cli";
import {
  bootstrapOwner,
  isAcceptableOwnerPassword,
  ownerHashOptions,
  type OwnerBootstrapStore,
} from "../src/lib/auth/owner-bootstrap";
import { ownerSchema, type Owner } from "../src/lib/database/models";
import { modelIndexes } from "../src/lib/database/model-indexes";

const privateTestPassword = "example-only-long-random-passphrase-78";

function memoryStore() {
  let owner: Owner | null = null;
  let indexesReady = false;
  const store: OwnerBootstrapStore = {
    async ensureUniqueOwnerIndexes() { indexesReady = true; },
    async hasOwner() { return owner !== null; },
    async insertOwner(next) {
      if (!indexesReady) throw new Error("Unique index was not initialized");
      if (owner !== null) {
        throw new MongoServerError({ ok: 0, code: 11000, errmsg: "duplicate singleton key" });
      }
      owner = next;
    },
  };
  return { store, getOwner: () => owner };
}

test("Argon2id stores a salted verifier with explicit cost parameters", async () => {
  const { store, getOwner } = memoryStore();
  assert.equal(await bootstrapOwner(store, privateTestPassword), "created");
  const owner = getOwner();
  assert.ok(owner);
  assert.equal(ownerSchema.safeParse(owner).success, true);
  assert.match(owner.passwordHash, /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
  assert.equal(await argon2.verify(owner.passwordHash, privateTestPassword), true);
  assert.equal(await argon2.verify(owner.passwordHash, "different-password"), false);
  assert.equal(owner.passwordHash.includes(privateTestPassword), false);
  assert.equal(ownerHashOptions.memoryCost, 65_536);
});

test("a rerun and concurrent attempts cannot create a second owner", async () => {
  const { store, getOwner } = memoryStore();
  const results = await Promise.all([
    bootstrapOwner(store, privateTestPassword),
    bootstrapOwner(store, `${privateTestPassword}-another`),
  ]);
  assert.deepEqual(results.sort(), ["already-exists", "created"]);
  const firstOwner = getOwner();
  assert.ok(firstOwner);
  assert.equal(await bootstrapOwner(store, `${privateTestPassword}-third`), "already-exists");
  assert.equal(getOwner(), firstOwner);
  assert.equal(modelIndexes.owners.find((index) => index.name === "singleton_owner_unique")?.unique, true);
});

test("short, empty, and control-character passwords are rejected before hashing", async () => {
  const { store, getOwner } = memoryStore();
  assert.equal(isAcceptableOwnerPassword("short"), false);
  assert.equal(isAcceptableOwnerPassword(" ".repeat(20)), false);
  assert.equal(isAcceptableOwnerPassword("valid-password-with\nnewline"), false);
  assert.equal(isAcceptableOwnerPassword("x".repeat(1025)), false);
  assert.equal(isAcceptableOwnerPassword("passwordpassword123"), false);
  assert.equal(isAcceptableOwnerPassword(privateTestPassword), true);
  assert.equal(await bootstrapOwner(store, "short"), "invalid-password");
  assert.equal(getOwner(), null);
});

test("CLI refuses reruns before asking for a password", async () => {
  const { store } = memoryStore();
  await bootstrapOwner(store, privateTestPassword);
  const lines: string[] = [];
  let prompts = 0;
  const code = await runOwnerBootstrapCli({
    interactive: true,
    async getStore() { return store; },
    async promptPassword() { prompts += 1; return privateTestPassword; },
    write(message) { lines.push(message); },
  });
  assert.equal(code, 1);
  assert.equal(prompts, 0);
  assert.equal(lines.join(" ").includes(privateTestPassword), false);
});

test("CLI output never includes a password or secret-bearing exception", async () => {
  const secret = "fake-secret-connection-uri";
  const lines: string[] = [];
  const code = await runOwnerBootstrapCli({
    interactive: true,
    async getStore() { throw new Error(secret); },
    async promptPassword() { return privateTestPassword; },
    write(message) { lines.push(message); },
  });
  assert.equal(code, 1);
  assert.equal(lines.join(" ").includes(secret), false);
  assert.equal(lines.join(" ").includes(privateTestPassword), false);

  const noninteractive = await runOwnerBootstrapCli({
    interactive: false,
    async getStore() { throw new Error("should not connect"); },
    async promptPassword() { throw new Error("should not prompt"); },
    write(message) { lines.push(message); },
  });
  assert.equal(noninteractive, 1);
});
