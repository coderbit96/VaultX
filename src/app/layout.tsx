import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Toaster } from "@/components/ui/toast";
import { PwaManager } from "@/components/pwa/pwa-manager";
import "./globals.css";

export const metadata: Metadata = {
  title: "VaultX | Private Owner Vault",
  description: "Private, single-owner encrypted file vault.",
  appleWebApp: { capable: true, title: "VaultX", statusBarStyle: "black-translucent" },
  icons: { icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d0e",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonced scripts require a fresh server render for each document request.
  await headers();
  return (
    <html lang="en">
      <body>
        <PwaManager />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
