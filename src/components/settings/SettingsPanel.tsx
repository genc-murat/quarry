import { useEffect, useRef, useState } from "react";
import { Palette } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Label, Select } from "@/components/ui/input";
import { UpdateControl } from "@/components/settings/UpdateControl";
import { SETTINGS_SECTIONS, readSetting, type PanelField } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme";
import { useWorkspace } from "@/stores/workspace";
import { PALETTES, THEME_MODES } from "@/theme/themes";

/**
 * The panel is schema-driven: theme stays custom (swatches), everything else is
 * rendered from `SETTINGS_SECTIONS`, so a new setting is data, not markup.
 */
export function SettingsPanel() {
  const mode = useThemeStore((s) => s.mode);
  const palette = useThemeStore((s) => s.palette);
  const setMode = useThemeStore((s) => s.setMode);
  const setPalette = useThemeStore((s) => s.setPalette);
  const settings = useWorkspace((s) => s.settings);
  const updateSetting = useWorkspace((s) => s.updateSetting);
  const persistSettings = useWorkspace((s) => s.persistSettings);
  const resetSettings = useWorkspace((s) => s.resetSettings);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-3 pb-0 pt-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Settings
        </h2>
        <Button size="xs" variant="ghost" onClick={() => resetSettings()}>
          Restore defaults
        </Button>
      </div>

      <header className="px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Theme
        </h2>
      </header>

      <section className="px-3 pb-4">
        <Label className="mb-2 block">Mode</Label>
        <div className="grid grid-cols-3 gap-1.5">
          {THEME_MODES.map((option) => (
            <button
              key={option.id}
              onClick={() => {
                setMode(option.id);
                persistSettings();
              }}
              className={cn(
                "rounded-lg border px-2 py-1.5 text-xs transition-colors",
                mode === option.id
                  ? "border-primary bg-accent text-accent-foreground"
                  : "border-border hover:bg-accent/50",
              )}
            >
              {option.name}
            </button>
          ))}
        </div>

        <Label className="mb-2 mt-4 flex items-center gap-1.5">
          <Palette className="h-3.5 w-3.5" /> Accent palette
        </Label>
        <div className="grid grid-cols-5 gap-1.5">
          {PALETTES.map((option) => (
            <button
              key={option.id}
              title={option.name}
              onClick={() => {
                setPalette(option.id);
                persistSettings();
              }}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] transition-colors",
                palette === option.id
                  ? "border-primary bg-accent/60"
                  : "border-border hover:bg-accent/40",
              )}
            >
              <span
                className="h-5 w-5 rounded-full ring-2 ring-white/20"
                style={{ background: option.swatch }}
              />
              {option.name}
            </button>
          ))}
        </div>
      </section>

      {SETTINGS_SECTIONS.map((section) => (
        <div key={section.id}>
          <header className="px-3 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </h2>
          </header>
          <section className="space-y-3 px-3 pb-4">
            {section.fields.map((field) => (
              <SettingRow
                key={field.path}
                field={field}
                value={readSetting(settings, field.path)}
                onChange={(value) => updateSetting(field.path, value)}
              />
            ))}
          </section>
        </div>
      ))}

      <header className="px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          About
        </h2>
      </header>
      <section className="px-3 pb-6 text-[11px] text-muted-foreground">
        <p className="text-foreground/80">Quarry · 0.1.0</p>
        <p className="mt-1">
          A modular, themeable database studio. MySQL 5.6, PostgreSQL, SQLite and Redis ship today;
          the driver registry makes adding MongoDB, ClickHouse and more a matter of one adapter.
        </p>
        <UpdateControl />
      </section>
    </div>
  );
}

/**
 * Numbers are edited through a local draft so that typing a multi-digit value
 * that starts below the minimum is not clamped one keystroke at a time (which
 * would fight the controlled input). The store is still clamped on commit.
 */
function NumberSetting({
  field,
  value,
  onChange,
}: {
  field: PanelField;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);

  // Mirror external changes (restore defaults, a fresh load) unless the user is
  // mid-edit, so their in-progress text is not overwritten.
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  return (
    <Input
      id={`setting-${field.path}`}
      type="number"
      min={field.min}
      max={field.max}
      step={field.step}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const parsed = Number(raw);
        if (raw !== "" && Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(String(value));
      }}
    />
  );
}

function SettingRow({
  field,
  value,
  onChange,
}: {
  field: PanelField;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <Checkbox
        label={field.label}
        checked={Boolean(value)}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }

  return (
    <div>
      <Label className="mb-1.5 block" htmlFor={`setting-${field.path}`}>
        {field.label}
      </Label>
      {field.kind === "select" ? (
        <Select
          id={`setting-${field.path}`}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : (
        <NumberSetting field={field} value={Number(value)} onChange={onChange} />
      )}
      {field.description ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{field.description}</p>
      ) : null}
    </div>
  );
}
