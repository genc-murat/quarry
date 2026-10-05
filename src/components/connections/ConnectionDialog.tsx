import { useEffect, useMemo, useState } from "react";
import { Plug, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ConnectionProfile, DriverDescriptor, SslMode } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

interface Props {
  open: boolean;
  onClose: () => void;
  editing?: ConnectionProfile | null;
}

function defaultsFor(driver?: DriverDescriptor): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  driver?.configFields.forEach((field) => {
    if (field.defaultValue !== undefined && field.defaultValue !== null) {
      values[field.key] = field.defaultValue;
    }
  });
  return values;
}

/** The connection form is generated entirely from `driver.configFields`, so a
 *  new engine needs zero UI changes. */
export function ConnectionDialog({ open, onClose, editing }: Props) {
  const drivers = useWorkspace((s) => s.drivers);
  const saveConnection = useWorkspace((s) => s.saveConnection);
  const connect = useWorkspace((s) => s.connect);
  const pushToast = useWorkspace((s) => s.pushToast);

  const [driverId, setDriverId] = useState<string>("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const driver = useMemo(() => drivers.find((d) => d.id === driverId), [drivers, driverId]);
  const isNew = !editing;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDriverId(editing.driver);
      setName(editing.name);
      setValues({
        host: editing.host,
        port: editing.port,
        username: editing.username,
        database: editing.database ?? "",
        sslMode: editing.sslMode,
        ...editing.options,
      });
      setPassword("");
      setClearPassword(false);
    } else {
      const first = drivers[0];
      setDriverId(first?.id ?? "");
      setName("");
      setValues(defaultsFor(first));
      setPassword("");
      setClearPassword(false);
    }
  }, [open, editing, drivers]);

  function changeDriver(nextId: string) {
    const next = drivers.find((d) => d.id === nextId);
    setDriverId(nextId);
    setValues(defaultsFor(next));
  }

  function buildPayload() {
    // Anything the form knows beyond the core fields travels in `options`, so
    // driver-specific extras are never silently dropped on save.
    const core = new Set(["host", "port", "username", "database", "sslMode", "password"]);
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!core.has(key)) options[key] = value;
    }
    return {
      host: String(values.host ?? ""),
      port: Number(values.port ?? driver?.defaultPort ?? 0),
      username: String(values.username ?? ""),
      database: String(values.database ?? ""),
      sslMode: (values.sslMode as SslMode) ?? "preferred",
      options,
    };
  }

  async function handleTest() {
    if (!driver) return;
    setTesting(true);
    try {
      const payload = buildPayload();
      const info = await ipc.testConnection({
        driver: driver.id,
        password: password || null,
        ...payload,
      });
      pushToast({
        title: "Connection successful",
        description: [info.version, info.currentUser].filter(Boolean).join(" · "),
        variant: "success",
      });
    } catch (error) {
      pushToast({ title: "Connection failed", description: errorMessage(error), variant: "error" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(alsoConnect: boolean) {
    if (!driver) return;
    setSaving(true);
    const payload = buildPayload();
    const profile = await saveConnection({
      id: editing?.id ?? null,
      name: name.trim() || `${payload.username}@${payload.host}`,
      driver: driver.id,
      ...payload,
      // `""` tells the backend to delete the stored secret, `undefined` means
      // "leave it alone", and `null` (new profile, no password) stores nothing.
      password: clearPassword ? "" : password ? password : editing ? undefined : null,
    });
    setSaving(false);
    if (!profile) return;
    onClose();
    if (alsoConnect) {
      await connect({ profileId: profile.id });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isNew ? "New connection" : "Edit connection"}
      description="Passwords are encrypted and stored locally in your Quarry config directory."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing || !driver}
          >
            <Zap className="h-3.5 w-3.5" />
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button size="sm" onClick={() => handleSave(false)} disabled={saving || !driver}>
            Save
          </Button>
          <Button size="sm" onClick={() => handleSave(true)} disabled={saving || !driver}>
            <Plug className="h-3.5 w-3.5" />
            Save & connect
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 flex flex-col gap-1.5">
          <Label>Engine</Label>
          <div className="flex flex-wrap gap-2">
            {drivers.map((d) => (
              <button
                key={d.id}
                onClick={() => changeDriver(d.id)}
                className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors"
                style={{
                  borderColor: driverId === d.id ? d.accentColor : "var(--border)",
                  background:
                    driverId === d.id
                      ? `color-mix(in oklch, ${d.accentColor} 14%, transparent)`
                      : "transparent",
                }}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.accentColor }} />
                {d.displayName}
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-2 flex flex-col gap-1.5">
          <Label htmlFor="conn-name">Display name</Label>
          <Input
            id="conn-name"
            value={name}
            placeholder="Production replica"
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {driver?.configFields.map((field) => (
          <div key={field.key} className="col-span-1">
            <Label className="mb-1.5 block" htmlFor={`field-${field.key}`}>
              {field.label}
              {field.required ? <span className="text-destructive"> *</span> : null}
            </Label>

            {field.key === "password" ? (
              <>
                <Input
                  id={`field-${field.key}`}
                  type="password"
                  value={password}
                  disabled={clearPassword}
                  placeholder={
                    clearPassword
                      ? "will be removed"
                      : editing?.hasPassword
                        ? "unchanged"
                        : field.placeholder ?? ""
                  }
                  onChange={(e) => setPassword(e.target.value)}
                />
                {editing?.hasPassword ? (
                  <button
                    type="button"
                    onClick={() => setClearPassword((value) => !value)}
                    className="mt-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive"
                  >
                    {clearPassword ? "Keep saved password" : "Remove saved password"}
                  </button>
                ) : null}
              </>
            ) : field.fieldType === "select" ? (
              <Select
                id={`field-${field.key}`}
                value={String(values[field.key] ?? "")}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id={`field-${field.key}`}
                type={field.fieldType === "number" ? "number" : "text"}
                value={String(values[field.key] ?? "")}
                placeholder={field.placeholder ?? ""}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    [field.key]: field.fieldType === "number" ? e.target.value : e.target.value,
                  }))
                }
              />
            )}

            {field.help ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{field.help}</p>
            ) : null}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
