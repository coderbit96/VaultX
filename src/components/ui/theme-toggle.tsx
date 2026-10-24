"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "./button";

const STORAGE = "vaultx:theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const preference = localStorage.getItem(STORAGE);
      const next = preference === "dark" || preference === "light" ? preference : media.matches ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE, next);
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };
  return <Button type="button" variant="ghost" size="small" onClick={toggle}
    aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"} title={theme === "dark" ? "Use light mode" : "Use dark mode"}>
    {theme === "dark" ? <Sun aria-hidden="true" size={18} /> : <Moon aria-hidden="true" size={18} />}
  </Button>;
}
