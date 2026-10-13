import { useEffect, useMemo, useState } from "react";
import { Plug, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { errorMessage, ipc } from "@/lib/ipc";
import type { ConnectionProfile, DriverDescriptor, SslMode } from "@/lib/types";
import { useWorkspace } from "@/stores/workspace";

/**
 * How the dialog was opened. A discriminated union rather than a pair of
 * optional props, so "edit this profile" and "start from these values" cannot
 * be passed at once: `editing` only exists on the edit arm and `prefill` only
 * on the create arm, and each is required on the arm that has it.
 */
export type ConnectionDialogMode =
  | {
      mode: "create";
      /**
       * Starting values for a **new** connection — what a session being saved as
       * a connection was opened with.
       */
      prefill?: Partial<ConnectionProfile> | null;
    }
  | {
      mode: "edit";
      /** The stored profile the form rewrites in place. */
      editing: ConnectionProfile;
    };

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with the profile that was just written, before the dialog closes. */
  onSaved?: (profile: ConnectionProfile) => void;
} & ConnectionDialogMode;

function defaultsFor(driver?: DriverDescriptor): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  driver?.configFields.forEach((field) => {
    if (field.defaultValue !== undefined && field.defaultValue !== null) {
      values[field.key] = field.defaultValue;
    }
  });
  return values;
}

/**
 * The connection form is generated entirely from `driver.configFields`, so a new
 * engine needs zero UI changes. It can also open a server without writing a
 * profile at all (the **Save this connection** box): useful for a one-off look
 * at a server, and the reason the ad-hoc `connect` path exists on the backend.
 */
export function ConnectionDialog(props: Props) {
  const { open, onClose, onSaved } = props;
  // The form works with just two values: the profile being edited (null while
  // creating) and the values a new connection starts from. The mode only decides
  // which of them exists, so it is narrowed once here instead of at every use.
  const editing = props.mode === "edit" ? props.editing : null;
  const prefill = props.mode === "create" ? props.prefill ?? null : null;
  const drivers = useWorkspace((s) => s.drivers);
  const saveConnection = useWorkspace((s) => s.saveConnection);
  const connect = useWorkspace((s) => s.connect);
  const pushToast = useWorkspace((s) => s.pushToast);

  const [driverId, setDriverId] = useState<string>("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  // Whether this connection should exist after the dialog closes at all.
  const [saveProfile, setSaveProfile] = useState(true);
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
      // A new connection starts from the driver's own defaults, or from what a
      // session being saved as a connection was opened with.
      const start = (prefill?.driver && drivers.find((d) => d.id === prefill.driver)) || drivers[0];
      setDriverId(start?.id ?? "");
      setName(prefill?.name ?? "");
      setValues({
        ...defaultsFor(start),
        ...(prefill
          ? {
              host: prefill.host ?? "",
              port: prefill.port ?? start?.defaultPort ?? 0,
              username: prefill.username ?? "",
              database: prefill.database ?? "",
              sslMode: prefill.sslMode ?? "preferred",
              ...(prefill.options ?? {}),
            }
          : {}),
      });
      setPassword("");
      setClearPassword(false);
    }
    setSaveProfile(true);
  }, [open, editing, prefill, drivers]);

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

  /**
   * Open the server as it stands on the form without writing anything. The
   * session is ad-hoc — the backend is given a config rather than a profile id —
   * so it is not remembered for the next launch and the password is used for
   * this connection only.
   */
  async function handleQuickConnect() {
    if (!driver) return;
    setSaving(true);
    const payload = buildPayload();
    const session = await connect(
      { config: { driver: driver.id, password: password || null, ...payload } },
      // Nothing else would carry the display name: an ad-hoc session is named
      // `user@host` by the backend.
      name.trim() || undefined,
    );
    setSaving(false);
    if (session) onClose();
  }

  async function handleSave(alsoConnect: boolean) {
    if (!driver) return;
    setSaving(true);
    const payload = buildPayload();
    // Server drivers default to `user@host`; file-backed ones to their path.
    const defaultName = payload.username
      ? `${payload.username}@${payload.host}`
      : String(values.path ?? driver.displayName);
    const profile = await saveConnection({
      id: editing?.id ?? null,
      name: name.trim() || defaultName,
      driver: driver.id,
      ...payload,
      // `""` tells the backend to delete the stored secret, `undefined` means
      // "leave it alone", and `null` (new profile, no password) stores nothing.
      password: clearPassword ? "" : password ? password : editing ? undefined : null,
    });
    setSaving(false);
    if (!profile) return;
    onSaved?.(profile);
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
          {saveProfile ? (
            <>
              <Button size="sm" onClick={() => handleSave(false)} disabled={saving || !driver}>
                Save
              </Button>
              <Button size="sm" onClick={() => handleSave(true)} disabled={saving || !driver}>
                <Plug className="h-3.5 w-3.5" />
                Save & connect
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={handleQuickConnect} disabled={saving || !driver}>
              <Plug className="h-3.5 w-3.5" />
              {saving ? "Connecting…" : "Connect"}
            </Button>
          )}
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

        <div className="col-span-2 mt-1 border-t border-border/60 pt-3">
          <Checkbox
            id="conn-save"
            checked={saveProfile}
            onChange={(event) => setSaveProfile(event.target.checked)}
            label="Save this connection"
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {saveProfile
              ? "Stored locally, so it appears in the connection list and can be reopened on the next launch."
              : "Used for this session only — nothing is written, so it will not appear in the connection list."}
          </p>
        </div>
      </div>
    </Dialog>
  );
}
