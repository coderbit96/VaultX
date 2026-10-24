import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";

type BrowserApi = typeof import("../tests/browser-image-entry");
type TestWindow = Window & { VaultXImage: BrowserApi };

async function main() {
  const bundle = await build({ entryPoints: ["tests/browser-image-entry.ts"], bundle: true, platform: "browser",
    format: "iife", globalName: "VaultXImage", write: false, tsconfig: "tsconfig.json" });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let stage = "startup";
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    // tsx names nested functions when it transforms page.evaluate callbacks.
    await page.addScriptTag({ content: "globalThis.__name = (target) => target;" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    stage = "strict encrypted byte boundaries";
    const boundary = await page.evaluate(() => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const metadata = { storedName: "test-only.jpg", extension: "jpg", mimeType: "image/jpeg" };
      const overhead = Number(api.estimateEncryptedFileBytes(0, metadata));
      const max = 999_999 - overhead;
      return { overhead, atMax: Number(api.estimateEncryptedFileBytes(max, metadata)), over: Number(api.estimateEncryptedFileBytes(max + 1, metadata)) };
    });
    assert.equal(boundary.atMax, 999_999);
    assert.equal(boundary.over, 1_000_000);

    stage = "small JPEG, metadata, and no upscale";
    const small = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
      const context = canvas.getContext("2d")!; context.fillStyle = "#937e61"; context.fillRect(0, 0, 120, 80);
      const source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg", 0.95));
      const result = await api.optimizeImage(new File([source], "TEST ONLY small.jpg", { type: "image/jpeg" }));
      return { width: result.width, height: result.height, type: result.blob.type,
        estimated: result.estimatedCiphertextBytes, size: result.blob.size };
    });
    assert.equal(small.width, 120);
    assert.equal(small.height, 80);
    assert.ok(small.estimated <= 950_000 && small.estimated < 1_000_000);

    stage = "transparent PNG";
    const transparent = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 90; canvas.height = 60;
      const context = canvas.getContext("2d")!; context.fillStyle = "#d84233"; context.fillRect(15, 12, 60, 36);
      const source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
      const result = await api.optimizeImage(new File([source], "TEST ONLY alpha.png", { type: "image/png" }));
      const bitmap = await createImageBitmap(result.blob);
      const output = document.createElement("canvas"); output.width = bitmap.width; output.height = bitmap.height;
      const outContext = output.getContext("2d")!; outContext.drawImage(bitmap, 0, 0); bitmap.close();
      return { type: result.blob.type, width: result.width, height: result.height,
        cornerAlpha: outContext.getImageData(0, 0, 1, 1).data[3], estimated: result.estimatedCiphertextBytes };
    });
    assert.equal(transparent.cornerAlpha, 0);
    assert.equal(transparent.width, 90);
    assert.equal(transparent.height, 60);
    assert.ok(["image/webp", "image/png"].includes(transparent.type));

    stage = "private gallery thumbnail on the device";
    const thumbnail = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#b24a3c"; context.fillRect(100, 100, 800, 600);
      const source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
      const result = await api.createLocalThumbnail(source);
      const bitmap = await createImageBitmap(result.blob);
      const output = document.createElement("canvas"); output.width = bitmap.width; output.height = bitmap.height;
      const outputContext = output.getContext("2d")!; outputContext.drawImage(bitmap, 0, 0); bitmap.close();
      const controller = new AbortController(); controller.abort();
      let cancelled = false;
      try { await api.createLocalThumbnail(source, controller.signal); } catch { cancelled = true; }
      return { width: result.width, height: result.height, type: result.blob.type,
        cornerAlpha: outputContext.getImageData(0, 0, 1, 1).data[3], cancelled,
        smaller: result.blob.size < source.size };
    });
    assert.deepEqual(thumbnail, { width: 320, height: 213, type: "image/webp", cornerAlpha: 0,
      cancelled: true, smaller: true });

    stage = "corrupt input, GIF/WebP animation, and HEIC fallback";
    const errors = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const code = async (file: File) => { try { await api.optimizeImage(file); return "unexpected_success"; }
        catch (error) { return (error as { code?: string }).code ?? "unknown"; } };
      const gif = new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,
        44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
      const webp = new Uint8Array([82,73,70,70,22,0,0,0,87,69,66,80,86,80,56,88,10,0,0,0,2,0,0,0,0,0,0,0,0,0]);
      const heic = new Uint8Array([0,0,0,20,102,116,121,112,104,101,105,99,0,0,0,0,104,101,105,99]);
      const corrupt = new Uint8Array([255,216,255,224,0,4,0,0,255,217]);
      return { gif: await code(new File([gif], "TEST ONLY animated.gif", { type: "image/gif" })),
        webp: await code(new File([webp], "TEST ONLY animated.webp", { type: "image/webp" })),
        heic: await code(new File([heic], "TEST ONLY sample.heic", { type: "image/heic" })),
        corrupt: await code(new File([corrupt], "TEST ONLY corrupt.jpg", { type: "image/jpeg" })) };
    });
    assert.deepEqual(errors, { gif: "animated", webp: "animated", heic: "unsupported_heic", corrupt: "corrupt" });

    stage = "EXIF orientation and metadata removal";
    const orientation = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 30; canvas.height = 20;
      const context = canvas.getContext("2d")!; context.fillStyle = "#ed2222"; context.fillRect(0, 0, 15, 20);
      const jpeg = new Uint8Array(await (await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg"))).arrayBuffer());
      const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,
        18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
      const source = new Uint8Array(jpeg.length + exif.length); source.set(jpeg.subarray(0, 2));
      source.set(exif, 2); source.set(jpeg.subarray(2), 2 + exif.length);
      const result = await api.optimizeImage(new File([source], "TEST ONLY oriented.jpg", { type: "image/jpeg" }));
      const output = new TextDecoder("latin1").decode(new Uint8Array(await result.blob.arrayBuffer()));
      return { width: result.width, height: result.height, containsExif: output.includes("Exif") };
    });
    assert.equal(orientation.width, 20);
    assert.equal(orientation.height, 30);
    assert.equal(orientation.containsExif, false);

    stage = "cancellation";
    const cancelled = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
      const source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg"));
      const abort = new AbortController();
      try { await api.optimizeImage(new File([source], "TEST ONLY cancel.jpg", { type: "image/jpeg" }),
        { signal: abort.signal, onProgress: (message) => { if (message.startsWith("Trying")) abort.abort(); } });
        return "unexpected_success";
      } catch (error) { return (error as { code?: string }).code ?? "unknown"; }
    });
    assert.equal(cancelled, "cancelled");

    stage = "quality floor rejection";
    const floor = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
      const source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg"));
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, mimeType) {
        callback(mimeType === "image/jpeg" ? new Blob([source, new Uint8Array(1_100_000)], { type: "image/jpeg" }) : null);
      };
      try { await api.optimizeImage(new File([source], "TEST ONLY impossible.jpg", { type: "image/jpeg" })); return "unexpected_success"; }
      catch (error) { return (error as { code?: string }).code ?? "unknown"; }
      finally { HTMLCanvasElement.prototype.toBlob = original; }
    });
    assert.equal(floor, "quality_floor");

    stage = "about 10 MB JPEG";
    const large = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).VaultXImage;
      const canvas = document.createElement("canvas"); canvas.width = 3200; canvas.height = 2400;
      const context = canvas.getContext("2d")!;
      const pixels = context.createImageData(canvas.width, canvas.height);
      let seed = 0x12345678;
      for (let index = 0; index < pixels.data.length; index += 4) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255;
        pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg", 0.98));
      const result = await api.optimizeImage(new File([source], "TEST ONLY large.jpg", { type: "image/jpeg" }));
      return { sourceBytes: source.size, outputBytes: result.blob.size, encryptedBytes: result.estimatedCiphertextBytes,
        width: result.width, height: result.height, preferred: result.preferredTargetMet };
    });
    assert.ok(large.sourceBytes >= 8_000_000 && large.sourceBytes <= 20_000_000, `Fixture size ${large.sourceBytes}`);
    assert.ok(large.encryptedBytes < 1_000_000);
    assert.ok(large.width <= 3200 && large.height <= 2400);

    console.log("Image optimizer browser checks passed: ~10 MB JPEG, small JPEG, transparent PNG, EXIF rotation, stripped metadata, corrupt input, GIF/WebP animation, HEIC fallback, cancellation, and strict ciphertext boundaries.");
    console.log(`Synthetic large JPEG ${large.sourceBytes} bytes -> ${large.outputBytes} optimized bytes; estimated encrypted object ${large.encryptedBytes} bytes.`);
  } catch (error) {
    console.error(`Image optimizer check failed at ${stage}: ${error instanceof Error ? error.message.split("\n").slice(0, 8).join(" | ") : "unknown"}`);
    process.exitCode = 1;
  } finally { await browser.close(); }
}

void main();
