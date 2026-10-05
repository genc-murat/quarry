export type ThemeMode = "light" | "dark" | "system";
export type PaletteId = "default" | "ocean" | "sunset" | "forest" | "rose";

export interface PaletteDefinition {
  id: PaletteId;
  name: string;
  /** Preview color shown in the settings picker. */
  swatch: string;
}

export const PALETTES: PaletteDefinition[] = [
  { id: "default", name: "Indigo", swatch: "#5b6ef5" },
  { id: "ocean", name: "Ocean", swatch: "#2196d6" },
  { id: "sunset", name: "Sunset", swatch: "#f2762e" },
  { id: "forest", name: "Forest", swatch: "#2ea36f" },
  { id: "rose", name: "Rose", swatch: "#e0559b" },
];

export const THEME_MODES: { id: ThemeMode; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "system", name: "System" },
];
