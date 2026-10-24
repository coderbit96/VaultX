import { optimizeVideo } from "@/lib/video/optimize-video";
import { inspectVideoSignature, parseVideoProbe, planVideoPresets, videoMetadata,
  maxPlaintextForEncryptedTarget } from "@/lib/video/video-policy";
import { estimateEncryptedFileBytes } from "@/lib/crypto/file-container";
import { createLocalVideoThumbnail } from "@/lib/gallery/thumbnail";
import { LocalFFmpeg } from "@/lib/video/ffmpeg-local";
import { inspectFragmentedMp4 } from "@/lib/video/fmp4-structure";

Object.assign(window, { VaultXVideo: { optimizeVideo, inspectVideoSignature, parseVideoProbe,
  planVideoPresets, videoMetadata, maxPlaintextForEncryptedTarget, estimateEncryptedFileBytes,
  createLocalVideoThumbnail, LocalFFmpeg, inspectFragmentedMp4 } });
