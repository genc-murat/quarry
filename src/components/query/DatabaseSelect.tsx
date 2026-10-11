import { Select } from "@/components/ui/input";
import type { DatabaseInfo } from "@/lib/types";

/**
 * Reads as "no explicit database, the connection decides" rather than naming
 * one. `default` was the old label, and it is also a real database name —
 * ClickHouse ships one — so the toolbar listed two options reading `default`,
 * the first of them empty. The label is still disambiguated against the list,
 * because a database could itself be named after it.
 */
const PLACEHOLDER = "Connection default";

/** The placeholder label, suffixed if a database in the list already uses it. */
export function placeholderLabel(databases: { name: string }[]): string {
  const taken = new Set(databases.map((database) => database.name));
  let label = PLACEHOLDER;
  for (let suffix = 2; taken.has(label); suffix += 1) label = `${PLACEHOLDER} ${suffix}`;
  return label;
}

/**
 * The query toolbar's database picker. An empty value means "use whatever the
 * connection is on", which the caller stores as null.
 */
export function DatabaseSelect({
  databases,
  value,
  disabled,
  className,
  onChange,
}: {
  databases: DatabaseInfo[];
  value: string;
  disabled?: boolean;
  className?: string;
  onChange: (database: string | null) => void;
}) {
  return (
    <Select
      className={className}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">{placeholderLabel(databases)}</option>
      {databases.map((database) => (
        <option key={database.name} value={database.name}>
          {database.name}
        </option>
      ))}
    </Select>
  );
}
