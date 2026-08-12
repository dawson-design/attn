import { readFileSync } from "node:fs";

// Parser for the installed-mode config file (~/.config/ghe-watch/env). Same
// `.env` dialect Bun auto-loads in dev mode, and deliberately the same
// semantics as gw_env_file_value() in scripts/lib.sh so shell installers and
// the runtime never disagree about what a line means: optional `export `,
// `#` comments, last assignment wins, one layer of paired quotes stripped.
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// Missing or unreadable file is normal (nothing configured yet) — never fatal.
export function loadConfigFileEnv(path: string | undefined): Record<string, string> {
  if (!path) return {};
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
