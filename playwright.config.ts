import { defineConfig } from "@playwright/test";

// Run after `npm run build`. These browser checks are read-only against the
// configured app; service mutations use separate disposable databases/assets.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3104",
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start -- -p 3104",
    url: "http://localhost:3104/unlock",
    reuseExistingServer: false,
    timeout: 45_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
