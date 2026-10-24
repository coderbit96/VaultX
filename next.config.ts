import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    const commonHeaders = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      ...(process.env.NODE_ENV === "production" ? [
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
      ] : []),
    ];
    const privateHeaders = ["/", "/unlock", "/vault/:path*", "/api/:path*"].map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
      ],
    }));
    return [{ source: "/:path*", headers: commonHeaders }, ...privateHeaders, { source: "/sw.js", headers: [
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      { key: "Service-Worker-Allowed", value: "/" },
    ] }, { source: "/offline.html", headers: [
      { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
      { key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ] }, { source: "/offline-vault.html", headers: [
      { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
      { key: "Content-Security-Policy", value: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ] }];
  },
};

export default nextConfig;
