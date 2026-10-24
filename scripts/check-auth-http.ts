const base = "http://localhost:3100";

async function main(): Promise<void> {
  const privatePaths = ["/vault", "/vault/files", "/vault/folders/preview", "/vault/gallery", "/vault/files/preview", "/vault/uploads", "/vault/settings", "/vault/deletions"];
  for (const path of ["/", ...privatePaths, "/unlock", "/signup", "/api/auth/signup"]) {
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    if ((path === "/" || privatePaths.includes(path)) && (response.status !== 307 || response.headers.get("location") !== "/unlock")) throw new Error("Anonymous route access");
    if (privatePaths.includes(path) && !response.headers.get("cache-control")?.includes("no-store")) throw new Error("Private route caching enabled");
    if (path === "/unlock" && response.status !== 200) throw new Error("Unlock page unavailable");
    if ((path === "/signup" || path === "/api/auth/signup") && response.status !== 404) throw new Error("Unexpected signup route");
  }

  const incorrect = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "synthetic-wrong-password" }),
  });
  if (incorrect.status !== 401 || (await incorrect.json()).error?.code !== "invalid_credentials") throw new Error("Incorrect password response");

  const crossSite = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ password: "synthetic-wrong-password" }),
  });
  if (crossSite.status !== 403) throw new Error("Cross-site login was accepted");

  for (const path of ["/api/files/507f1f77bcf86cd799439011/access", "/api/files/507f1f77bcf86cd799439011/download"]) {
    const response = await fetch(`${base}${path}`);
    if (response.status !== 401 || !response.headers.get("cache-control")?.includes("no-store")) throw new Error("Anonymous media route was not denied");
  }
  const lockCrossSite = await fetch(`${base}/api/auth/lock`, { method: "POST", headers: { Origin: "https://attacker.example" } });
  if (lockCrossSite.status !== 403) throw new Error("Cross-site lock was accepted");

  const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Origin: base } });
  const cookie = logout.headers.get("set-cookie") ?? "";
  if (logout.status !== 200 || !cookie.includes("HttpOnly") || !cookie.includes("Secure") || !cookie.toLowerCase().includes("samesite=strict") || !cookie.toLowerCase().includes("max-age=0")) {
    throw new Error("Production logout cookie flags are incorrect");
  }
  console.log("Private route redirects, invalid login, CSRF check, and production cookie flags passed.");
}

main().catch(() => {
  console.error("HTTP auth check failed. Start the production app on port 3100 and retry.");
  process.exitCode = 1;
});
