import { useEffect } from "react";

import { ConnectionList } from "@/components/connections/ConnectionList";
import { ReconnectPrompt } from "@/components/connections/ReconnectPrompt";
import { ExplorerPanel } from "@/components/explorer/ExplorerPanel";
import { HistoryPanel } from "@/components/history/HistoryPanel";
import { ObjectDialogHost } from "@/components/objects/ObjectDialogHost";
import { ActivityRail } from "@/components/layout/ActivityRail";
import { StatusBar } from "@/components/layout/StatusBar";
import { TitleBar } from "@/components/layout/TitleBar";
import { QueryTabs } from "@/components/query/QueryTabs";
import { QueryWorkspace } from "@/components/query/QueryWorkspace";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { SchemaToolsPanel } from "@/components/schema/SchemaToolsPanel";
import { SnippetPanel } from "@/components/snippets/SnippetPanel";
import { Toaster } from "@/components/ui/toaster";
import { startRankProbe } from "@/lib/rankProbe";
import { applyAppearance } from "@/lib/settings";
import { applyTheme, useThemeStore } from "@/stores/theme";
import { useWorkspace } from "@/stores/workspace";

export default function App() {
  const bootstrap = useWorkspace((s) => s.bootstrap);
  const sidebar = useWorkspace((s) => s.sidebar);
  const mode = useThemeStore((s) => s.mode);
  const palette = useThemeStore((s) => s.palette);
  const appearance = useWorkspace((s) => s.settings.appearance);

  useEffect(() => {
    void bootstrap();
    // Inert unless the build asked for it; see src/lib/rankProbe.ts.
    startRankProbe();
  }, [bootstrap]);

  useEffect(() => {
    applyTheme(mode, palette);
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme(mode, palette);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [mode, palette]);

  // Appearance settings (density, monospace font) are pushed onto the document
  // so the grid, editor and CSS helpers read a single source of truth.
  useEffect(() => {
    applyAppearance(useWorkspace.getState().settings);
  }, [appearance]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <ActivityRail />

        <aside className="w-72 shrink-0 overflow-hidden border-r border-border bg-surface/40">
          {sidebar === "connections" ? <ConnectionList /> : null}
          {sidebar === "explorer" ? <ExplorerPanel /> : null}
          {sidebar === "schema" ? <SchemaToolsPanel /> : null}
          {sidebar === "history" ? <HistoryPanel /> : null}
          {sidebar === "snippets" ? <SnippetPanel /> : null}
          {sidebar === "settings" ? <SettingsPanel /> : null}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <QueryTabs />
          <div className="min-h-0 flex-1">
            <QueryWorkspace />
          </div>
        </main>
      </div>

      <StatusBar />
      <ObjectDialogHost />
      <ReconnectPrompt />
      <Toaster />
    </div>
  );
}
