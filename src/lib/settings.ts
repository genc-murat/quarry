import type { PaletteId, ThemeMode } from "@/theme/themes";

/**
 * Settings are declared once, in `SETTINGS_REGISTRY`, and everything else —
 * the `AppSettings` type, the defaults, load-time coercion, the settings panel
 * and the dotted-path readers/writers — is derived from it. Adding a setting is
 * a single entry here (plus whatever consumes it); there is no second list to
 * keep in sync and no way for a stored blob from an older version to break the
 * app, because every value is coerced through its own field.
 */

export type SettingsValue = string | number | boolean;

export interface SettingsOption {
  value: string;
  label: string;
}

interface BaseField {
  label: string;
  description?: string;
}

export interface NumberField extends BaseField {
  kind: "number";
  default: number;
  min?: number;
  max?: number;
  step?: number;
  coerce: (raw: unknown) => number;
}

export interface BooleanField extends BaseField {
  kind: "boolean";
  default: boolean;
  coerce: (raw: unknown) => boolean;
}

export interface SelectField<T extends string = string> extends BaseField {
  kind: "select";
  default: T;
  options: { value: T; label: string }[];
  coerce: (raw: unknown) => T;
}

export type FieldSpec = NumberField | BooleanField | SelectField<string>;

function clamp(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function numberField(spec: {
  label: string;
  description?: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
}): NumberField {
  return {
    kind: "number",
    label: spec.label,
    description: spec.description,
    default: spec.default,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    coerce: (raw) => clamp(raw, spec.default, spec.min ?? -Infinity, spec.max ?? Infinity),
  };
}

function boolField(spec: { label: string; description?: string; default: boolean }): BooleanField {
  return {
    kind: "boolean",
    label: spec.label,
    description: spec.description,
    default: spec.default,
    coerce: (raw) => (typeof raw === "boolean" ? raw : spec.default),
  };
}

function selectField<T extends string>(spec: {
  label: string;
  description?: string;
  default: T;
  options: { value: T; label: string }[];
}): SelectField<T> {
  return {
    kind: "select",
    label: spec.label,
    description: spec.description,
    default: spec.default,
    options: spec.options,
    coerce: (raw) =>
      spec.options.some((option) => option.value === raw) ? (raw as T) : spec.default,
  };
}

export const SETTINGS_REGISTRY = {
  appearance: {
    density: selectField({
      label: "Density",
      description: "Row height in result grids.",
      default: "comfortable",
      options: [
        { value: "comfortable", label: "Comfortable" },
        { value: "compact", label: "Compact" },
      ],
    }),
    fontSize: numberField({
      label: "Monospace font size",
      description: "Text size for the editor and result grids.",
      default: 12,
      min: 10,
      max: 18,
    }),
    fontFamily: selectField({
      label: "Monospace font",
      description: "Typeface used by the editor and result grids.",
      default: "system",
      options: [
        { value: "system", label: "System default" },
        { value: "jetbrains", label: "JetBrains Mono" },
        { value: "menlo", label: "Menlo" },
        { value: "sfmono", label: "SF Mono" },
      ],
    }),
    rowStripes: boolField({
      label: "Alternating row colors",
      description: "Shade every other data row for readability.",
      default: true,
    }),
  },
  editor: {
    maxRows: numberField({
      label: "Row limit per statement",
      description: "Results beyond this limit are streamed but truncated for display.",
      default: 1000,
      min: 1,
      max: 1000000,
    }),
    timeoutMs: numberField({
      label: "Query timeout (ms)",
      description: "0 means no timeout.",
      default: 0,
      min: 0,
      max: 3600000,
      step: 500,
    }),
    wordWrap: boolField({ label: "Wrap long lines", default: false }),
    lineNumbers: boolField({ label: "Show line numbers", default: true }),
    highlightActiveLine: boolField({ label: "Highlight active line", default: true }),
    autocomplete: boolField({
      label: "Autocomplete tables and columns",
      description: "Suggest object names in addition to SQL keywords.",
      default: true,
    }),
    foldGutter: boolField({
      label: "Fold gutter",
      description: "Show fold markers next to the line numbers.",
      default: false,
    }),
    tabSize: selectField({
      label: "Tab size",
      description: "Spaces inserted for a tab and one indent level.",
      default: "2",
      options: [
        { value: "2", label: "2 spaces" },
        { value: "4", label: "4 spaces" },
        { value: "8", label: "8 spaces" },
      ],
    }),
  },
  results: {
    pageSize: numberField({
      label: "Preview page size",
      description: "Rows fetched per page when previewing a table.",
      default: 200,
      min: 10,
      max: 5000,
    }),
    nullDisplay: selectField({
      label: "NULL display",
      description: "How empty cells are rendered.",
      default: "NULL",
      options: [
        { value: "NULL", label: "NULL" },
        { value: "∅", label: "∅" },
        { value: "-", label: "-" },
        { value: "", label: "(blank)" },
      ],
    }),
    showColumnTypes: boolField({
      label: "Show column types",
      description: "Display each column's data type under its name.",
      default: true,
    }),
    copyFormat: selectField({
      label: "Cell copy format",
      description: "Format used by Copy row in the cell context menu.",
      default: "tsv",
      options: [
        { value: "tsv", label: "TSV" },
        { value: "csv", label: "CSV" },
        { value: "json", label: "JSON" },
      ],
    }),
  },
  safety: {
    confirmRowDelete: boolField({
      label: "Confirm row deletion",
      description: "Ask before deleting the selected grid rows.",
      default: true,
    }),
    warnUnsavedEdits: boolField({
      label: "Warn about unsaved edits",
      description: "Ask before leaving edit mode with pending changes.",
      default: true,
    }),
    requireWhereForWrites: boolField({
      label: "Require WHERE on UPDATE/DELETE",
      description: "Refuse to run UPDATE or DELETE statements that have no WHERE clause.",
      default: false,
    }),
  },
  general: {
    reconnectOnLaunch: boolField({
      label: "Reconnect on launch",
      description:
        "Reopen the connections that were still open when the app was closed.",
      default: true,
    }),
    requireTypedConfirmation: boolField({
      label: "Require typed confirmation",
      description: "Type the object name to confirm destructive drops and truncates.",
      default: true,
    }),
    toastDurationMs: numberField({
      label: "Notification duration (ms)",
      description: "How long a toast stays on screen.",
      default: 5200,
      min: 1000,
      max: 20000,
      step: 500,
    }),
  },
  assistant: {
    smartAutocomplete: boolField({
      label: "Rank suggestions with a local model",
      description:
        "Use a decision model on this machine (Ollama 0.35+) to lift the table you most likely mean to the top of the editor's suggestions, and to mark a statement the model reads as likely to destroy data.",
      default: false,
    }),
    model: selectField({
      label: "Decision model",
      description: "The Ollama model used to rank suggestions.",
      default: "nimble",
      options: [
        { value: "nimble", label: "nimble (9B, Bespoke Labs)" },
        { value: "tev1", label: "tev1 (4B, Together AI)" },
        { value: "tev1:0.8b", label: "tev1:0.8b (0.8B, Together AI)" },
      ],
    }),
  },
};

// A separate assignment keeps the registry honest without letting the
// constraint contextually widen the field types (which would collapse every
// select to plain `string`).
const registryIsValid: Record<string, Record<string, FieldSpec>> = SETTINGS_REGISTRY;
void registryIsValid;

type Registry = typeof SETTINGS_REGISTRY;
export type SettingsSectionId = keyof Registry;

type Coerced<F> = F extends { coerce: (raw: unknown) => infer T } ? T : never;

/** The full settings tree, derived from each field's coercion result type. */
export type AppSettings = {
  [S in SettingsSectionId]: {
    [K in keyof Registry[S]]: Coerced<Registry[S][K]>;
  };
};

type PathIn<S extends SettingsSectionId> = `${S}.${keyof Registry[S] & string}`;
export type SettingPath = { [S in SettingsSectionId]: PathIn<S> }[SettingsSectionId];

/**
 * Deep-merge an arbitrary stored blob over the defaults, coercing every value
 * through its field. Unknown keys are dropped and out-of-range values clamped.
 */
export function mergeSettings(raw: unknown): AppSettings {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const merged: Record<string, Record<string, SettingsValue>> = {};
  for (const section of Object.keys(SETTINGS_REGISTRY) as SettingsSectionId[]) {
    const fields = SETTINGS_REGISTRY[section] as Record<string, FieldSpec>;
    const stored = root[section];
    const sectionRaw =
      stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const target: Record<string, SettingsValue> = {};
    for (const key of Object.keys(fields)) {
      target[key] = fields[key].coerce(sectionRaw[key]);
    }
    merged[section] = target;
  }
  return merged as unknown as AppSettings;
}

/** A defensive, freshly-coerced copy of the defaults. */
export function cloneSettings(settings: AppSettings): AppSettings {
  return mergeSettings(settings);
}

export const DEFAULT_SETTINGS: AppSettings = mergeSettings(undefined);

/** Read a dotted setting path. */
export function readSetting(settings: AppSettings, path: SettingPath): SettingsValue {
  const [section, key] = path.split(".");
  return (settings as Record<string, Record<string, SettingsValue>>)[section][key];
}

/** Return a copy with one dotted setting replaced (and coerced/clamped). */
export function writeSetting(
  settings: AppSettings,
  path: SettingPath,
  value: SettingsValue,
): AppSettings {
  const [section, key] = path.split(".");
  const spec = (SETTINGS_REGISTRY as Record<string, Record<string, FieldSpec>>)[section]?.[key];
  const next: SettingsValue = spec ? spec.coerce(value) : value;
  const bag = (settings as Record<string, Record<string, SettingsValue>>)[section] ?? {};
  return {
    ...settings,
    [section]: { ...bag, [key]: next },
  } as unknown as AppSettings;
}

export interface PanelField {
  path: SettingPath;
  label: string;
  description?: string;
  kind: "number" | "boolean" | "select";
  options?: SettingsOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface SettingsSection {
  id: string;
  title: string;
  fields: PanelField[];
}

const SECTION_TITLES: Record<SettingsSectionId, string> = {
  appearance: "Appearance",
  editor: "Query editor",
  results: "Results",
  safety: "Safety",
  general: "General",
  assistant: "Assistant",
};

/** The panel renders from this; it is derived from the registry, never hand-kept. */
export const SETTINGS_SECTIONS: SettingsSection[] = (
  Object.keys(SETTINGS_REGISTRY) as SettingsSectionId[]
).map((section) => {
  const fields = SETTINGS_REGISTRY[section] as Record<string, FieldSpec>;
  return {
    id: section,
    title: SECTION_TITLES[section],
    fields: Object.keys(fields).map((key) => {
      const spec = fields[key];
      const panel: PanelField = {
        path: `${section}.${key}` as SettingPath,
        label: spec.label,
        description: spec.description,
        kind: spec.kind,
      };
      if (spec.kind === "select") panel.options = spec.options;
      if (spec.kind === "number") {
        panel.min = spec.min;
        panel.max = spec.max;
        panel.step = spec.step;
      }
      return panel;
    }),
  };
});

const MONO_STACKS: Record<string, string> = {
  system: '"SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  menlo: 'Menlo, ui-monospace, "SFMono-Regular", monospace',
  sfmono: '"SFMono-Regular", ui-monospace, Menlo, monospace',
};

/** Push the appearance settings onto the document as CSS variables/attributes. */
export function applyAppearance(settings: AppSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.density = settings.appearance.density;
  root.style.setProperty("--mono-font-size", `${settings.appearance.fontSize}px`);
  root.style.setProperty(
    "--app-mono",
    MONO_STACKS[settings.appearance.fontFamily] ?? MONO_STACKS.system,
  );
}

/** Shape persisted to disk (theme lives in its own store but travels with it). */
export interface PersistedSettings {
  theme: { mode: ThemeMode; palette: PaletteId };
  settings: AppSettings;
  /**
   * Which connections were open when the workspace was last saved, so the next
   * launch can reopen them. Profile ids rather than session ids: a session is a
   * live handle that does not survive the process, a profile is what the user
   * can be reconnected to.
   */
  connections?: { open?: string[] };
  /** Legacy field, only read for migration. */
  maxRows?: number;
}
