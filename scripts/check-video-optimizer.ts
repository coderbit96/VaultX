import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

async function main() {
  const bundle = await build({ entryPoints: ["tests/browser-video-entry.ts"], bundle: true,
    platform: "browser", format: "esm", target: "es2022", write: false, tsconfig: "tsconfig.json" });
  const script = bundle.outputFiles[0].contents;
  const assets = join(process.cwd(), "public", "ffmpeg");
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    if (path === "/") { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>VaultX video test</title>"); return; }
    if (path === "/bundle.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); return; }
    if (/^\/ffmpeg\/[a-z-]+\.(js|wasm)$/.test(path)) {
      try { const body = await readFile(join(assets, path.split("/").at(-1)!));
        response.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : "text/javascript"); response.end(body); }
      catch { response.writeHead(404).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server unavailable");
  const browser = await chromium.launch({ channel: "chrome", headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"] });
  let stage = "startup";
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.addScriptTag({ content: "globalThis.__name = (target) => target;" });
    await page.addScriptTag({ url: "/bundle.js", type: "module" });
    await page.waitForFunction(() => Boolean((window as Window & { VaultXVideo?: unknown }).VaultXVideo));
    stage = "budget boundaries and rotation parsing";
    const policy = await page.evaluate(() => {
      const api = (window as unknown as Window & { VaultXVideo: typeof import("../tests/browser-video-entry") &
        { videoMetadata: typeof import("../src/lib/video/video-policy").videoMetadata;
          maxPlaintextForEncryptedTarget: typeof import("../src/lib/video/video-policy").maxPlaintextForEncryptedTarget;
          estimateEncryptedFileBytes: typeof import("../src/lib/crypto/file-container").estimateEncryptedFileBytes;
          parseVideoProbe: typeof import("../src/lib/video/video-policy").parseVideoProbe;
          planVideoPresets: typeof import("../src/lib/video/video-policy").planVideoPresets } }).VaultXVideo;
      const metadata = api.videoMetadata("test-only.mov");
      const max = api.maxPlaintextForEncryptedTarget(99_999_999, metadata);
      const probe = api.parseVideoProbe(JSON.stringify({ format: { duration: "100" }, streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1",
          side_data_list: [{ rotation: -90 }] }, { codec_type: "audio", codec_name: "aac" }] }), "mov");
      const presets = api.planVideoPresets(probe, metadata);
      let longCode = "";
      try { api.planVideoPresets({ ...probe, durationSeconds: 86_400 }, metadata); }
      catch (error) { longCode = (error as { code?: string }).code ?? "unknown"; }
      let extraTrackCode = "";
      try { api.parseVideoProbe(JSON.stringify({ format: { duration: "100" }, streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
        { codec_type: "subtitle", codec_name: "mov_text" }] }), "mp4"); }
      catch (error) { extraTrackCode = (error as { code?: string }).code ?? "unknown"; }
      return { atMax: Number(api.estimateEncryptedFileBytes(max, metadata)),
        over: Number(api.estimateEncryptedFileBytes(max + 1, metadata)), rotation: probe.rotation,
        display: [probe.displayWidth, probe.displayHeight], first: presets[0].label, longCode, extraTrackCode };
    });
    assert.ok(policy.atMax <= 99_999_999 && policy.over > 99_999_999);
    assert.equal(policy.rotation, 270);
    assert.deepEqual(policy.display, [1080, 1920]);
    assert.equal(policy.longCode, "quality_floor");
    assert.equal(policy.extraTrackCode, "unsupported");

    stage = "unsupported, cancellation, and 500 MB device guard";
    const rejects = await page.evaluate(async () => {
      const api = (window as unknown as Window & { VaultXVideo: { optimizeVideo: typeof import("../src/lib/video/optimize-video").optimizeVideo } }).VaultXVideo;
      const code = async (file: File, signal?: AbortSignal) => { try { await api.optimizeVideo(file, { signal }); return "unexpected_success"; }
        catch (error) { return (error as { code?: string }).code ?? "unknown"; } };
      const invalid = await code(new File(["not a video"], "TEST ONLY invalid.mp4", { type: "video/mp4" }));
      const head = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109]);
      const abort = new AbortController(); abort.abort();
      const cancelled = await code(new File([head], "TEST ONLY cancel.mp4", { type: "video/mp4" }), abort.signal);
      const chunk = new Blob([new Uint8Array(1_000_000)]);
      Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 2 });
      const large = await code(new File([head, ...Array(500).fill(chunk)], "TEST ONLY 500mb.mp4", { type: "video/mp4" }));
      delete (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      return { invalid, cancelled, large };
    });
    assert.deepEqual(rejects, { invalid: "unsupported", cancelled: "cancelled", large: "device_limit" });

    stage = "WebM with video and audio to H.264/AAC MP4";
    const result = await page.evaluate(async () => {
      const api = (window as unknown as Window & { VaultXVideo: {
        optimizeVideo: typeof import("../src/lib/video/optimize-video").optimizeVideo;
        createLocalVideoThumbnail: typeof import("../src/lib/gallery/thumbnail").createLocalVideoThumbnail;
        LocalFFmpeg: typeof import("../src/lib/video/ffmpeg-local").LocalFFmpeg;
        inspectFragmentedMp4: typeof import("../src/lib/video/fmp4-structure").inspectFragmentedMp4 } }).VaultXVideo;
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext("2d")!;
      const stream = canvas.captureStream(15);
      const audio = new AudioContext();
      const oscillator = audio.createOscillator(); oscillator.frequency.value = 440;
      const destination = audio.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"].find((value) => MediaRecorder.isTypeSupported(value));
      if (!mimeType) return { error: "recorder_unavailable" };
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = []; recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const finished = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start();
      for (let frame = 0; frame < 50; frame++) {
        context.fillStyle = frame % 2 ? "#523f86" : "#b9d780";
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = "white"; context.fillRect(frame * 8 % 320, 55, 40, 40);
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      recorder.stop(); await finished;
      oscillator.stop(); await audio.close(); stream.getTracks().forEach((track) => track.stop());
      const input = new File(chunks, "TEST ONLY synthetic.webm", { type: "video/webm" });
      const abort = new AbortController();
      let cancelledCode = "unexpected_success";
      try { await api.optimizeVideo(input, { signal: abort.signal,
        onProgress: ({ stage }) => { if (stage === "transcoding") abort.abort(); } }); }
      catch (error) { cancelledCode = (error as { code?: string }).code ?? "unknown"; }
      if (cancelledCode !== "cancelled") return { error: `transcode cancellation ${cancelledCode}` };
      const progress: string[] = [];
      const output = await api.optimizeVideo(input, { onProgress: ({ stage }) => progress.push(stage) });
      const thumbnail = await api.createLocalVideoThumbnail(output.blob);
      const frame = await createImageBitmap(thumbnail);
      const thumbnailSize = [frame.width, frame.height]; frame.close();
      const url = URL.createObjectURL(output.blob);
      const video = document.createElement("video"); video.src = url; video.muted = true; video.playsInline = true;
      await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("playback metadata")); });
      const duration = video.duration;
      await video.play();
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("playback timeout")), 5000);
        video.ontimeupdate = () => { if (video.currentTime > 0.15) { clearTimeout(timer); resolve(); } }; });
      video.pause(); video.currentTime = Math.min(duration * 0.5, 1);
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("seek timeout")), 5000);
        video.onseeked = () => { clearTimeout(timer); resolve(); }; });
      video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
      const muxer = new api.LocalFFmpeg();
      let fragments = 0, fragmentedBytes = 0;
      try {
        await muxer.load(); await muxer.createDir("/remux");
        await muxer.mount("WORKERFS", { files: [new File([output.blob], "source.mp4", { type: "video/mp4" })] }, "/remux");
        const status = await muxer.exec(["-hide_banner", "-loglevel", "error", "-i", "/remux/source.mp4", "-c", "copy",
          "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000",
          "-f", "mp4", "/fragmented.mp4"]);
        if (status !== 0) return { error: "fragmented remux failed" };
        const bytes = await muxer.readFile("/fragmented.mp4");
        const structure = api.inspectFragmentedMp4(bytes);
        fragments = structure.fragments.length; fragmentedBytes = bytes.byteLength;
        if (structure.init.end >= fragmentedBytes || fragments < 1) return { error: "fragmented structure missing" };
      } finally { muxer.terminate(); }
      return { input: output.input, output: output.output, bytes: output.blob.size, thumbnailSize,
        encryptedBytes: output.estimatedCiphertextBytes, duration, progress, sourceBytes: input.size,
        fragments, fragmentedBytes };
    }, { timeout: 180_000 });
    if ("error" in result) throw new Error(result.error);
    assert.ok(result.input.audioCodec);
    assert.equal(result.output.videoCodec, "h264");
    assert.equal(result.output.audioCodec, "aac");
    assert.equal(result.output.rotation, 0);
    assert.deepEqual(result.thumbnailSize, [320, 180]);
    assert.ok(Math.abs(result.duration - result.input.durationSeconds) < 0.5);
    assert.ok(result.encryptedBytes < 100_000_000);
    assert.ok(result.fragments >= 1 && result.fragmentedBytes > 0);
    assert.ok(result.progress.includes("transcoding") && result.progress.includes("validating"));
    console.log("Video browser checks passed: signed byte budget, rotation, long-video and 500 MB device rejection, cancellation, real WebM+audio to H.264/AAC MP4 transcode, local thumbnail, duration, play, seek, and isolated fragmented MP4 remux structure.");
    console.log(`Synthetic media ${result.sourceBytes} bytes -> ${result.bytes} MP4 bytes; estimated encrypted object ${result.encryptedBytes} bytes.`);
  } catch (error) {
    console.error(`Video browser check failed at ${stage}: ${error instanceof Error ? error.message.split("\n").slice(0, 5).join(" | ") : "unknown"}`);
    process.exitCode = 1;
  } finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main();
