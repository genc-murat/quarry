import { create } from "zustand";

import { type PaletteId, type ThemeMode } from "@/theme/themes";

const STORAGE_KEY = "quarry.theme";

interface ThemeState {
  mode: ThemeMode;
  palette: PaletteId;
  setMode: (mode: ThemeMode) => void;
  setPalette: (palette: PaletteId) => void;
}

function readStored(): { mode: ThemeMode; palette: PaletteId } {
  const fallback = { mode: "system" as ThemeMode, palette: "default" as PaletteId };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<{ mode: ThemeMode; palette: PaletteId }>;
    return {
      mode: parsed.mode ?? fallback.mode,
      palette: parsed.palette ?? fallback.palette,
    };
  } catch {
    return fallback;
  }
}

const initial = readStored();

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: initial.mode,
  palette: initial.palette,
  setMode: (mode) => {
    set({ mode });
    persist(get());
  },
  setPalette: (palette) => {
    set({ palette });
    persist(get());
  },
}));

function persist(state: { mode: ThemeMode; palette: PaletteId }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures (private mode, etc).
  }
}

export function prefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve `system` to a concrete mode. */
export function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") return prefersDark() ? "dark" : "light";
  return mode;
}

/** Push the current theme onto the document element. */
export function applyTheme(mode: ThemeMode, palette: PaletteId) {
  const resolved = resolveMode(mode);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.setAttribute("data-palette", palette);
  root.style.colorScheme = resolved;
}
