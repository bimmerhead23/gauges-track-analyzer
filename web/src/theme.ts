import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "ta-theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

export function getTheme(): Theme {
  return read();
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
  listeners.forEach((fn) => fn());
}

export function toggleTheme() {
  setTheme(getTheme() === "light" ? "dark" : "light");
}

export function useTheme(): Theme {
  const [theme, set] = useState<Theme>(getTheme);
  useEffect(() => {
    const on = () => set(getTheme());
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  }, []);
  return theme;
}

export function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
