import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "test-results/**", "public/ffmpeg/**", "public/offline-vault.js", "public/offline-kdf.js", "next-env.d.ts"]),
]);
