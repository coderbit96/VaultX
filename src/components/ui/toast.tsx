"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      className="vaultx-toaster"
      theme="dark"
      position="bottom-right"
      closeButton
      richColors={false}
      visibleToasts={3}
      mobileOffset={{ bottom: "calc(16px + env(safe-area-inset-bottom))", left: "16px", right: "16px" }}
    />
  );
}
