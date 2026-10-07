// `attn setup claude-desktop`: add attn's MCP server to Claude Desktop's
// claude_desktop_config.json. Claude Desktop extensions (.mcpb) must bundle
// their server, and attn's runs from the Homebrew install, so the config entry
// is the supported route. GUI apps do not inherit the shell PATH, so the entry
// uses the absolute path of the attn wrapper.

export interface McpServerEntry {
  command: string;
  args: string[];
}

export type DesktopConfigChange =
  { kind: "unchanged" } | { kind: "write"; config: Record<string, unknown>; replaced: McpServerEntry | undefined };

export function claudeDesktopConfigPath(home: string): string {
  return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
}

export function attnServerEntry(attnBin: string): McpServerEntry {
  return { command: attnBin, args: ["mcp"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameEntry(existing: unknown, entry: McpServerEntry): boolean {
  return JSON.stringify(existing) === JSON.stringify(entry);
}

// Adds or replaces mcpServers.attn and keeps every other key as it was. Throws
// on a shape it does not understand rather than guessing, so a config the user
// edited by hand is never rewritten into something else.
export function mergeDesktopConfig(existing: unknown, entry: McpServerEntry): DesktopConfigChange {
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error("claude_desktop_config.json is not a JSON object; edit it by hand");
  }
  const config = existing ?? {};
  const servers = config.mcpServers ?? {};
  if (!isRecord(servers)) {
    throw new Error("mcpServers in claude_desktop_config.json is not an object; edit it by hand");
  }
  if (sameEntry(servers.attn, entry)) return { kind: "unchanged" };
  return {
    kind: "write",
    config: { ...config, mcpServers: { ...servers, attn: entry } },
    replaced: servers.attn as McpServerEntry | undefined,
  };
}
