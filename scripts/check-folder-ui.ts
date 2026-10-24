import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { MongoClient, MongoServerError, ObjectId, type Db } from "mongodb";
import { chromium, type Browser, type Page } from "playwright-core";
import { closeDatabaseConnection, getDatabase } from "../src/lib/database/client";
import { ensureModelIndexes } from "../src/lib/database/model-indexes";
import { fileSchema, ownerSchema, vaultKeyRecordSchema } from "../src/lib/database/models";
import { ownerHashOptions } from "../src/lib/auth/owner-bootstrap";
import { createVaultKeys } from "../src/lib/crypto/vault-keys";
import { deriveVaultPasswordKey } from "../src/lib/crypto/argon2-browser";
import { encryptFileName } from "../src/lib/crypto/file-names";
import { prepareEncryptedFile } from "../src/lib/crypto/file-container";
import { clearVaultKeyMaterial, installVaultRootKey } from "../src/lib/crypto/key-memory";

const base = "http://localhost:3102";
const syntheticOwnerEmail = "synthetic-owner@vaultx.invalid";
const localMongoUri = "mongodb://127.0.0.1:3103/?directConnection=true";
const screenshots = join(process.cwd(), "test-results");

async function readyServer(server: ChildProcess) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) break;
    try { if ((await fetch(`${base}/unlock`)).ok) return; } catch { /* Startup pending. */ }
    await delay(500);
  }
  throw new Error("Synthetic server did not start");
}

async function startLocalMongo(dbPath: string): Promise<ChildProcess> {
  const binary = "C:\\Program Files\\MongoDB\\Server\\9.0\\bin\\mongod.exe";
  const processHandle = spawn(binary, ["--dbpath", dbPath, "--port", "3103", "--bind_ip", "127.0.0.1",
    "--replSet", "vaultxFolderUiTest", "--logpath", join(dbPath, "mongod.log"), "--quiet"],
  { windowsHide: true, stdio: "ignore" });
  let client: MongoClient | undefined;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (processHandle.exitCode !== null) break;
      try {
        client = await new MongoClient(localMongoUri, { tls: false, serverSelectionTimeoutMS: 500 }).connect();
        break;
      } catch { await delay(250); }
    }
    if (!client) throw new Error("Local MongoDB did not start");
    await client.db("admin").command({ replSetInitiate: { _id: "vaultxFolderUiTest",
      members: [{ _id: 0, host: "127.0.0.1:3103" }] } });
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await client.db("admin").command({ hello: 1 })).isWritablePrimary) return processHandle;
      await delay(250);
    }
    throw new Error("Local MongoDB replica set did not become primary");
  } catch { processHandle.kill(); throw new Error("Local MongoDB setup failed"); }
  finally { await client?.close().catch(() => undefined); }
}

async function signInAndUnlock(page: Page, password: string, passphrase: string, mobile: boolean) {
  await page.goto(`${base}/unlock`);
  await page.getByLabel("Owner email").fill(syntheticOwnerEmail);
  await page.getByLabel("Owner password").fill(password);
  await page.getByRole("button", { name: "Unlock VaultX" }).click();
  await page.waitForURL(`${base}/vault`);
  const navigation = page.getByRole("navigation", { name: mobile ? "Mobile navigation" : "Desktop navigation" });
  await navigation.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Vault passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock encryption key" }).click();
  await page.getByText("Vault key unlocked on this device.", { exact: false }).waitFor();
  await navigation.getByRole("link", { name: "Files" }).click();
  await page.getByRole("heading", { name: "All folders" }).waitFor();
}

async function createFolder(page: Page, name: string, keyboard = false) {
  const trigger = page.getByRole("button", { name: "New folder" });
  if (keyboard) { await trigger.focus(); await page.keyboard.press("Enter"); }
  else await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.waitFor();
  const input = dialog.getByRole("textbox", { name: "Folder name" });
  await page.waitForFunction(() => document.activeElement?.id === "folder-dialog-name", undefined, { timeout: 3000 });
  await input.fill(name);
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("link", { name, exact: true }).waitFor();
}

async function assertLayout(page: Page, mobile: boolean) {
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.documentWidth <= dimensions.width, "Folder page should not scroll horizontally");
  const mobileNav = page.getByRole("navigation", { name: "Mobile navigation" });
  assert.equal(await mobileNav.isVisible(), mobile);
  const desktopNav = page.getByRole("navigation", { name: "Desktop navigation" });
  assert.equal(await desktopNav.isVisible(), !mobile);
  const create = page.getByRole("button", { name: "New folder" });
  const box = await create.boundingBox();
  assert.ok(box && box.height >= 44, "Create control needs a touch-size target");
}

async function main() {
  const databaseName = `vaultx_folder_ui_check_${randomBytes(8).toString("hex")}`;
  let db: Db | undefined;
  let server: ChildProcess | undefined;
  let localMongo: ChildProcess | undefined;
  let browser: Browser | undefined;
  let debugPage: Page | undefined;
  let dbPath: string | undefined;
  let stage = "database setup";
  try {
    dbPath = await mkdtemp(join(tmpdir(), "vaultx-folder-ui-"));
    localMongo = await startLocalMongo(dbPath);
    process.env.MONGODB_URI = localMongoUri;
    process.env.MONGODB_DB_NAME = databaseName;
    process.env.VAULTX_LOCAL_MONGO_TEST = "1";
    db = await getDatabase();
    stage = "temporary index setup";
    await ensureModelIndexes(db);
    stage = "synthetic key generation";
    const ownerId = new ObjectId();
    const password = randomBytes(24).toString("base64url");
    const passphrase = randomBytes(32).toString("base64url");
    const keys = await createVaultKeys(passphrase, deriveVaultPasswordKey);
    stage = "synthetic owner insert";
    const now = new Date();
    await db.collection("owners").insertOne(ownerSchema.parse({ _id: ownerId, singletonKey: "vaultx-owner", username: "owner",
      passwordHash: await argon2.hash(password, ownerHashOptions), initializedAt: now,
      settings: { autoLockMinutes: 15, requireLockOnOpen: true } }));
    stage = "synthetic vault-key insert";
    await db.collection("vaultKeys").insertOne(vaultKeyRecordSchema.parse({ ...keys.envelope, _id: new ObjectId(), ownerId,
      createdAt: now, recoveryConfirmedAt: now }));
    installVaultRootKey(keys.rootKey, keys.envelope.vaultId);
    const dummyId = new ObjectId();
    const sample = await prepareEncryptedFile(new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])]),
      { storedName: "TEST ONLY sample.jpg", extension: "jpg", mimeType: "image/jpeg" }, "image");
    sample.dispose();
    await db.collection("files").insertOne(fileSchema.parse({ _id: dummyId, ownerId, folderId: null,
      nameEncrypted: await encryptFileName(dummyId.toHexString(), "TEST ONLY sample.jpg"), extension: "jpg",
      category: "image", mimeType: "image/jpeg", storedSizeBytes: Number(sample.manifest.objectBytes),
      cloudinary: { publicId: `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`, assetId: "synthetic-no-cloud-object", resourceType: "raw", deliveryType: "authenticated", format: "dat" },
      encryptedFileKey: sample.manifest.wrappedKey.ciphertext, encryptionManifest: sample.manifest,
      status: "ready", createdAt: now, updatedAt: now }));
    const deletingId = new ObjectId();
    await db.collection("files").insertOne(fileSchema.parse({ _id: deletingId, ownerId, folderId: null,
      nameEncrypted: await encryptFileName(deletingId.toHexString(), "TEST ONLY deleting.jpg"), extension: "jpg",
      category: "image", mimeType: "image/jpeg", storedSizeBytes: 32_000,
      cloudinary: { publicId: "dummy-deleting-no-cloudinary-object", resourceType: "raw", deliveryType: "authenticated" },
      encryptedFileKey: "A".repeat(16), encryptionManifest: { version: 1, algorithm: "AES-256-GCM", chunkCount: 1, chunkSizeBytes: 64 },
      status: "deleting", createdAt: now, updatedAt: now }));
    keys.rootKey.fill(0);

    stage = "server startup";
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3102"], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", AUTH_OWNER_EMAIL: syntheticOwnerEmail,
        AUTH_SECRET: randomBytes(48).toString("base64url"), NEXTAUTH_URL: base }, windowsHide: true, stdio: "ignore",
    });
    await readyServer(server);
    stage = "browser startup";
    browser = await chromium.launch({ channel: "chrome", headless: true });
    await mkdir(screenshots, { recursive: true });

    stage = "anonymous file API";
    assert.equal((await fetch(`${base}/api/files`)).status, 401);
    assert.equal((await fetch(`${base}/api/files/${dummyId.toHexString()}`)).status, 401);

    stage = "desktop explorer";
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const desktopPage = await desktop.newPage();
    if (process.argv.includes("--security-only")) await desktopPage.addInitScript(() => {
      const observed = window as typeof window & { vaultxCspViolations?: string[] };
      observed.vaultxCspViolations = [];
      window.addEventListener("securitypolicyviolation", (event) => observed.vaultxCspViolations?.push(
        `${event.effectiveDirective}:${["inline", "eval"].includes(event.blockedURI) ? event.blockedURI
          : event.blockedURI.startsWith("blob:") ? "blob" : "other"}:${(() => {
          try { return new URL(event.sourceFile).pathname; } catch { return "unknown"; }
        })()}:${event.lineNumber}`));
    });
    debugPage = desktopPage;
    await signInAndUnlock(desktopPage, password, passphrase, false);
    if (process.argv.includes("--security-only")) {
      stage = "authenticated browser CSP";
      await desktopPage.getByRole("navigation", { name: "Activity navigation" }).getByRole("link", { name: "Uploads" }).click();
      await desktopPage.getByRole("heading", { name: "Upload to VaultX" }).waitFor();
      assert.deepEqual(await desktopPage.evaluate(() => (window as typeof window & { vaultxCspViolations?: string[] }).vaultxCspViolations), []);
      console.log("Synthetic Chrome login, vault-key unlock, private navigation, and enforced CSP passed.");
      return;
    }
    stage = "gallery album create, edit, and remove";
    await desktopPage.getByRole("navigation", { name: "Desktop navigation" }).getByRole("link", { name: "Gallery" }).click();
    await desktopPage.getByRole("heading", { name: "Your gallery" }).waitFor();
    await desktopPage.getByRole("button", { name: "New album" }).click();
    const createAlbum = desktopPage.getByRole("dialog", { name: "Create album" });
    await createAlbum.getByRole("textbox", { name: "Album name" }).fill("TEST ONLY album");
    await createAlbum.getByRole("textbox", { name: /Description/ }).fill("Synthetic description");
    await createAlbum.getByRole("button", { name: "Save album" }).click();
    const albumCard = desktopPage.locator("article").filter({ hasText: "TEST ONLY album" });
    await albumCard.waitFor();
    assert.equal(await albumCard.getByText("Synthetic description").count(), 1);
    await albumCard.getByRole("button", { name: "Edit" }).click();
    const editAlbum = desktopPage.getByRole("dialog", { name: "Edit album" });
    await editAlbum.getByRole("textbox", { name: "Album name" }).fill("TEST ONLY renamed album");
    await editAlbum.getByRole("button", { name: "Save album" }).click();
    const renamedAlbumCard = desktopPage.locator("article").filter({ hasText: "TEST ONLY renamed album" });
    await renamedAlbumCard.waitFor();
    await renamedAlbumCard.getByRole("button", { name: "Remove TEST ONLY renamed album" }).click();
    await desktopPage.getByRole("dialog", { name: "Remove album?" }).getByRole("button", { name: "Remove album" }).click();
    await renamedAlbumCard.waitFor({ state: "detached" });
    assert.equal(await db.collection("files").countDocuments({ _id: dummyId, status: "ready" }), 1);
    // The historical standalone optimizer panels are no longer mounted on
    // Uploads. Keep this path opt-in until it is rewritten for the queue UI;
    // folder acceptance uses the real explorer below.
    let fixtureBytes: number[] = [];
    if (process.argv.includes("--legacy-optimizer-ui")) {
    stage = "local image optimizer UI";
    fixtureBytes = await desktopPage.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
      const context = canvas.getContext("2d")!; context.fillStyle = "#8b755b"; context.fillRect(0, 0, 120, 80);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/jpeg", 0.95));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    let uploadRequests = 0;
    desktopPage.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/uploads")) uploadRequests++; });
    await desktopPage.getByRole("navigation", { name: "Activity navigation" }).getByRole("link", { name: "Uploads" }).click();
    await desktopPage.getByRole("button", { name: "Choose image" }).waitFor();
    await desktopPage.getByLabel("Choose a still image").setInputFiles({ name: "TEST ONLY image.jpg", mimeType: "image/jpeg", buffer: Buffer.from(fixtureBytes) });
    await desktopPage.getByRole("heading", { name: "Local result" }).waitFor();
    assert.equal(uploadRequests, 0);
    await desktopPage.screenshot({ path: join(screenshots, "image-optimizer.png"), fullPage: true });
    stage = "local video optimizer UI";
    const videoFixtureBytes = await desktopPage.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const context = canvas.getContext("2d")!;
      const stream = canvas.captureStream(12);
      const audio = new AudioContext();
      const oscillator = audio.createOscillator(); oscillator.frequency.value = 440;
      const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
      const chunks: Blob[] = []; recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const finished = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start();
      for (let frame = 0; frame < 18; frame++) {
        context.fillStyle = frame % 2 ? "#7955aa" : "#aad877";
        context.fillRect(0, 0, 160, 90);
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      recorder.stop(); await finished;
      oscillator.stop(); await audio.close(); stream.getTracks().forEach((track) => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    await desktopPage.getByLabel("Choose a video").setInputFiles({ name: "TEST ONLY video.webm",
      mimeType: "video/webm", buffer: Buffer.from(videoFixtureBytes) });
    await desktopPage.getByRole("heading", { name: "Local MP4 result" }).waitFor({ timeout: 30_000 }).catch(async () => {
      const alerts = await desktopPage.getByRole("alert").allTextContents();
      const statuses = await desktopPage.getByRole("status").allTextContents();
      throw new Error(`Video UI state: ${JSON.stringify({ alerts, statuses })}`);
    });
    assert.equal(uploadRequests, 0);
    await desktopPage.screenshot({ path: join(screenshots, "video-optimizer.png"), fullPage: true });
    }
    await desktopPage.getByRole("navigation", { name: "Desktop navigation" }).getByRole("link", { name: "Files" }).click();
    await desktopPage.getByRole("heading", { name: "All folders" }).waitFor();
    await assertLayout(desktopPage, false);
    stage = "file listing and details";
    await desktopPage.getByRole("link", { name: /TEST ONLY sample.jpg/ }).waitFor();
    assert.equal(await desktopPage.getByText("TEST ONLY deleting.jpg").count(), 0);
    const wire = await desktopPage.evaluate(async () => (await fetch("/api/files", { cache: "no-store" })).json());
    assert.equal(wire.files.length, 1);
    assert.equal(JSON.stringify(wire).includes("dummy-fixture-no-cloudinary-object"), false);
    assert.equal(JSON.stringify(wire).includes("encryptedFileKey"), false);
    assert.equal(await desktopPage.evaluate(async () => (await fetch("/api/files/not-an-id")).status), 404);
    assert.equal(await desktopPage.evaluate(async () => (await fetch("/api/files?ownerId=forged")).status), 400);
    await desktopPage.getByRole("link", { name: /TEST ONLY sample.jpg/ }).focus();
    await desktopPage.keyboard.press("Enter");
    await desktopPage.getByRole("heading", { name: "TEST ONLY sample.jpg" }).waitFor();
    await desktopPage.getByRole("link", { name: "Back to files" }).click();
    await desktopPage.getByRole("heading", { name: "All folders" }).waitFor();
    stage = "desktop keyboard create";
    await createFolder(desktopPage, "Folder A", true);
    const folderHref = await desktopPage.getByRole("link", { name: "Folder A", exact: true }).getAttribute("href");
    assert.ok(folderHref);
    const folderId = new ObjectId(folderHref.split("/").at(-1));
    const nestedId = new ObjectId();
    const nested = await prepareEncryptedFile(new Blob(["%PDF-1.4\nTEST ONLY\n"]),
      { storedName: "TEST ONLY nested.pdf", extension: "pdf", mimeType: "application/pdf" }, "document");
    nested.dispose();
    await db.collection("files").insertOne(fileSchema.parse({ _id: nestedId, ownerId, folderId,
      nameEncrypted: await encryptFileName(nestedId.toHexString(), "TEST ONLY nested.pdf"), extension: "pdf",
      category: "document", mimeType: "application/pdf", storedSizeBytes: Number(nested.manifest.objectBytes),
      cloudinary: { publicId: `vaultx/ciphertext/${randomBytes(24).toString("hex")}.dat`, assetId: "synthetic-no-cloud-object", resourceType: "raw", deliveryType: "authenticated", format: "dat" },
      encryptedFileKey: nested.manifest.wrappedKey.ciphertext, encryptionManifest: nested.manifest,
      status: "ready", createdAt: new Date(), updatedAt: new Date() }));
    stage = "client-side global filename search";
    await desktopPage.getByRole("textbox", { name: "Search filenames" }).fill("nested.pdf");
    await desktopPage.getByRole("link", { name: /TEST ONLY nested.pdf/ }).waitFor();
    assert.equal(await desktopPage.getByRole("link", { name: /TEST ONLY sample.jpg/ }).count(), 0);
    await desktopPage.getByRole("textbox", { name: "Search filenames" }).fill("");
    await desktopPage.getByRole("link", { name: /TEST ONLY sample.jpg/ }).waitFor();
    stage = "desktop pointer create";
    await createFolder(desktopPage, "Sibling B");
    await desktopPage.screenshot({ path: join(screenshots, "folders-desktop.png"), fullPage: true });
    await desktopPage.getByRole("button", { name: "New folder" }).click();
    await desktopPage.keyboard.press("Escape");
    assert.equal(await desktopPage.getByRole("dialog").isVisible(), false, "Escape should close the dialog");
    await desktopPage.getByRole("link", { name: "Folder A", exact: true }).click();
    await desktopPage.getByRole("heading", { name: "Folder A" }).waitFor();
    await createFolder(desktopPage, "Child");
    await desktopPage.getByRole("link", { name: "Child", exact: true }).waitFor();
    await desktopPage.getByRole("link", { name: "Back to parent folder" }).click();
    await desktopPage.getByRole("heading", { name: "All folders" }).waitFor();

    stage = "rename and move";
    await desktopPage.getByLabel("Actions for Sibling B").focus();
    await desktopPage.keyboard.press("Enter");
    await desktopPage.getByRole("button", { name: "Rename", exact: true }).focus();
    await desktopPage.keyboard.press("Enter");
    const rename = desktopPage.getByRole("dialog", { name: "Rename folder" });
    await rename.getByRole("textbox", { name: "Folder name" }).fill("Renamed B");
    await desktopPage.keyboard.press("Enter");
    await desktopPage.getByRole("link", { name: "Renamed B", exact: true }).waitFor();
    await desktopPage.getByLabel("Actions for Renamed B").click();
    await desktopPage.getByRole("button", { name: "Move", exact: true }).click();
    const move = desktopPage.getByRole("dialog", { name: "Move folder" });
    await move.getByRole("button", { name: "Folder A" }).click();
    await move.getByText("Destination: Folder A").waitFor();
    await move.getByRole("button", { name: "Move here" }).click();
    await desktopPage.getByRole("link", { name: "Renamed B", exact: true }).waitFor({ state: "hidden" });
    await desktopPage.getByRole("link", { name: "Folder A", exact: true }).click();
    await desktopPage.getByRole("link", { name: "Renamed B", exact: true }).waitFor();
    await desktop.close();

    stage = "phone explorer";
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      deviceScaleFactor: 2, reducedMotion: "reduce" });
    const phonePage = await phone.newPage();
    debugPage = phonePage;
    await signInAndUnlock(phonePage, password, passphrase, true);
    await phonePage.getByRole("link", { name: /TEST ONLY sample.jpg/ }).waitFor();
    await assertLayout(phonePage, true);
    await phonePage.screenshot({ path: join(screenshots, "folders-phone.png"), fullPage: true });
    await phonePage.getByRole("link", { name: /TEST ONLY sample.jpg/ }).click();
    await phonePage.getByRole("heading", { name: "TEST ONLY sample.jpg" }).waitFor();
    await phonePage.getByRole("link", { name: "Back to files" }).click();
    await phonePage.getByRole("button", { name: "New folder" }).click();
    const dialogBox = await phonePage.getByRole("dialog", { name: "New folder" }).boundingBox();
    assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 390, "Dialog should fit phone viewport");
    await phonePage.getByRole("dialog").getByRole("textbox", { name: "Folder name" }).fill("Mobile folder");
    await phonePage.getByRole("dialog").getByRole("button", { name: "Create folder" }).click();
    await phonePage.getByRole("link", { name: "Mobile folder", exact: true }).waitFor();
    if (process.argv.includes("--legacy-optimizer-ui")) {
    stage = "phone image optimizer layout";
    await phonePage.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Home" }).click();
    await phonePage.getByRole("link", { name: "Uploads" }).click();
    await phonePage.getByLabel("Choose a still image").setInputFiles({ name: "TEST ONLY image.jpg", mimeType: "image/jpeg", buffer: Buffer.from(fixtureBytes) });
    await phonePage.getByRole("heading", { name: "Local result" }).waitFor();
    assert.equal(await phonePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      "Image optimizer must fit the phone viewport");
    await phonePage.screenshot({ path: join(screenshots, "image-optimizer-phone.png"), fullPage: true });
    }
    await phonePage.getByRole("button", { name: "Lock vault now" }).click();
    await phonePage.waitForURL(`${base}/unlock`);
    assert.equal((await phonePage.locator("body").innerText()).includes("Mobile folder"), false);
    assert.equal((await phonePage.request.get(`${base}/api/files`)).status(), 401);
    await phone.close();
    console.log("Synthetic desktop and phone folder/file UI, album create/edit/remove, owner-only file APIs, local search, keyboard dialog, nested navigation, rename, move, and lock checks passed.");
    console.log("Screenshots: test-results/folders-desktop.png and folders-phone.png");
  } catch (error) {
    const code = error instanceof MongoServerError ? `${error.codeName ?? "MongoDB"}/${error.code}` : error instanceof Error ? error.name : "unknown";
    console.error(`Synthetic folder UI check failed at ${stage} (${code}). The real Atlas database was not used.`);
    if (error instanceof Error) console.error(error.message.split("\n").slice(0, 4).join(" | "));
    if (error instanceof Error) console.error(error.stack?.split("\n").slice(1, 5).join(" | "));
    if (debugPage && !debugPage.isClosed()) {
      const statuses = await debugPage.evaluate(async () => ({
        folders: (await fetch("/api/folders", { cache: "no-store" })).status,
        summary: (await fetch("/api/vault/summary", { cache: "no-store" })).status,
      })).catch(() => null);
      if (statuses) console.error(`Private list response statuses: ${JSON.stringify(statuses)}`);
    }
    if (debugPage && !debugPage.isClosed()) await debugPage.screenshot({ path: join(screenshots, "folders-failure.png"), fullPage: true }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    clearVaultKeyMaterial();
    await browser?.close().catch(() => undefined);
    server?.kill();
    await closeDatabaseConnection().catch(() => undefined);
    localMongo?.kill();
    if (localMongo) await new Promise<void>((done) => { if (localMongo?.exitCode !== null) done(); else localMongo?.once("exit", () => done()); });
    if (dbPath) {
      const target = resolve(dbPath);
      const baseDirectory = resolve(tmpdir()) + sep;
      if (target.startsWith(baseDirectory) && basename(target).startsWith("vaultx-folder-ui-")) {
        await rm(target, { recursive: true, force: true }).catch(() => { console.error("Local test directory cleanup failed."); process.exitCode = 1; });
      } else { console.error("Local test directory path was invalid; cleanup skipped."); process.exitCode = 1; }
    }
  }
}

void main();
