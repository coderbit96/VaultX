import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VaultX | Foundation",
  description: "VaultX project foundation. Private vault features are not available yet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
