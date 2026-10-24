# Local video optimization feasibility (Prompt 20)

## What is implemented

`src/lib/video/optimize-video.ts` dynamically loads only after the owner chooses a video on the authorized `/vault/uploads` page. The browser loads pinned ffmpeg.wasm 0.12.15 and its single-thread core 0.12.10 from this app's own `/ffmpeg/` assets. `predev`, `prebuild`, and `prevideo:check` copy those assets from installed npm packages. A small typed local client speaks this pinned worker's message protocol because the package wrapper's dynamic Worker URL fails the installed Next.js Turbopack build; upgrading ffmpeg.wasm requires retesting this adapter. FFmpeg executes in a Web Worker; input uses `WORKERFS` so the original Blob is not first copied into a main-thread byte array. No browser or server route sends plaintext to an external encoder. The user filename is replaced with a fixed worker path; no raw FFmpeg logs are registered.

The source signature must be MP4, MOV, or WebM. The worker inspects video and audio codecs, track counts, duration, resolution, frame rate when known, and container rotation. It refuses multiple video/audio, subtitle, or other extra tracks rather than silently dropping them. It calculates the maximum MP4 plaintext size from the **same v1 encryption framing arithmetic** used by the file container, then reserves 2% or at least 500,000 bytes for MP4/container variation, and 128 kb/s for an audio track. It attempts 1080p, 720p, 480p, then 360p without upscaling and with documented minimum video bitrates of 2.5, 1.2, 0.65, and 0.4 Mb/s respectively. A shorter original can keep its original dimensions. Sources whose duration leaves no preset above its quality floor fail before encoding.

The output command actually decodes/re-encodes to H.264 baseline/yuv420p video and AAC audio when the input has audio. It applies FFmpeg's automatic rotation, scales the displayed dimensions, removes metadata/chapters/subtitles/data, and writes a fast-start MP4. It probes the new object and requires H.264, matching AAC audio presence, zero rotation, planned dimensions, audio duration aligned with output duration, and output duration close to the input. The actual MP4 byte count is fed into the shared v1 encryption estimator. The preferred target is `≤95,000,000` encrypted bytes and the hard cap is **`<100,000,000`**. An oversized attempt is discarded and a smaller preset is tried. The UI displays the local MP4 preview, output details, progress, cancel, and actionable errors. Cancelling terminates the worker. This step does **not** encrypt, upload, or save the video.

## Verified and unverified

| Gate | Result |
| --- | --- |
| Byte budget | Synthetic browser test proves the maximum plaintext boundary below `100,000,000` encrypted bytes, including v1 framing. Actual Cloudinary reported size remains unverified. |
| Real transcode | Chrome on the development machine converted a generated WebM with Opus audio to H.264/AAC MP4. The resulting file played and sought in an HTML video element; probed input/output durations were compared. |
| Audio and rotation | Browser test checks audio stream presence and output audio duration. A synthetic probe checks rotated display dimensions. A real rotated MOV/MP4 has **not** been tested, so rotation preservation on actual devices remains unverified. |
| Cancellation and rejection | Browser tests cover pre-abort, abort at transcode start, invalid signature, a long video whose budget violates the floor, and a simulated 500 MB file on a 2 GB device. No file is uploaded. |
| 500 MB source | **Unverified.** Files over 600 MB are refused. Inputs over 256 MB are refused if `navigator.deviceMemory` is unknown or below 8 GB; inputs over 128 MB are refused below 4 GB. A nominal 8 GB device may still run out of browser/WASM memory or exceed the 30-minute timeout. The app reports failure, never success, in that case. |
| Other browsers/phones | **Unverified.** Chrome desktop is tested. Edge, Firefox, Android Chrome, iOS Safari/Home Screen, and actual phone playback/seek need device tests. A browser unable to start the encoder fails with an explicit error. |
| Private storage | **Blocked for upload.** The local MP4 is not encrypted or stored. Cloudinary's currently reported raw-object cap is below a near-100 MB object; provider capacity/private retrieval and authenticated streaming still need resolution. |

The installed ffmpeg.wasm `ffprobe()` wrapper returned `-1` while writing complete valid JSON for the synthetic WebM. The implementation requires readable, parseable, schema-validated probe output rather than treating that return value alone as success or failure. Missing, truncated, or invalid probe data fails closed. Real output is also checked by codec, audio, duration, bytes, and browser playback in the synthetic test.

## Browser and release considerations

The local core download is about 32 MB and transcoding uses substantial CPU and WASM memory. `WORKERFS` avoids an initial full main-thread copy, but output is read into memory for preview; this is **not** a proven bounded-memory path for large output. The ffmpeg.wasm upstream states a 2 GB WebAssembly input limit and documents `WORKERFS` and worker termination. Its core package is GPL-licensed; distribution obligations need review before a public release. The app does not load code from a third-party CDN at runtime.

References: [ffmpeg.wasm usage](https://ffmpegwasm.netlify.app/docs/getting-started/usage/), [FFmpeg class API](https://ffmpegwasm.netlify.app/docs/api/ffmpeg/classes/ffmpeg/), [ffmpeg.wasm FAQ](https://ffmpegwasm.netlify.app/docs/faq/), [Media Capabilities API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capabilities_API), and [ffprobe documentation](https://ffmpeg.org/ffprobe.html).
