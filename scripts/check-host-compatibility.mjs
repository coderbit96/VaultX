// Vercel Functions currently cap request and response bodies at 4.5 MB.
// VaultX transfers up to 10 MB of ciphertext through its Node route, so a
// successful Vercel build would produce a vault with broken upload/download.
if (process.env.VERCEL === "1") {
  console.error("BLOCKED: Vercel Functions' 4.5 MB payload limit is below VaultX's encrypted transfer size. Review a browser-direct authenticated ciphertext upload and bounded download design before deploying here. See docs/DEPLOYMENT.md.");
  process.exitCode = 1;
} else {
  console.log("Host compatibility check: Node server build permitted. Verify the host's request/response, egress, and scheduling limits in docs/DEPLOYMENT.md.");
}
