import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "VaultX Private Vault",
    short_name: "VaultX",
    description: "Private, single-owner encrypted file vault.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0d0e",
    theme_color: "#0b0d0e",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
