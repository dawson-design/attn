import { describe, expect, test } from "bun:test";
import { attnServerEntry, claudeDesktopConfigPath, mergeDesktopConfig } from "../src/cli/claude-desktop";
import { parseCliArgs } from "../src/cli/main";

const entry = attnServerEntry("/opt/homebrew/opt/attn/bin/attn");

describe("mergeDesktopConfig", () => {
  test("creates the config when the file does not exist", () => {
    expect(mergeDesktopConfig(undefined, entry)).toEqual({
      kind: "write",
      config: { mcpServers: { attn: { command: "/opt/homebrew/opt/attn/bin/attn", args: ["mcp"] } } },
      replaced: undefined,
    });
  });

  test("keeps other servers and top-level settings", () => {
    const existing = { globalShortcut: "Cmd+Space", mcpServers: { other: { command: "other" } } };
    const change = mergeDesktopConfig(existing, entry);
    expect(change).toMatchObject({
      kind: "write",
      config: { globalShortcut: "Cmd+Space", mcpServers: { other: { command: "other" }, attn: entry } },
    });
  });

  test("reports no change when the entry is already there", () => {
    expect(mergeDesktopConfig({ mcpServers: { attn: entry } }, entry)).toEqual({ kind: "unchanged" });
  });

  test("names the entry it replaces", () => {
    const old = { command: "/old/attn", args: ["mcp"] };
    expect(mergeDesktopConfig({ mcpServers: { attn: old } }, entry)).toMatchObject({ kind: "write", replaced: old });
  });

  test("refuses shapes it does not understand", () => {
    expect(() => mergeDesktopConfig([], entry)).toThrow("not a JSON object");
    expect(() => mergeDesktopConfig({ mcpServers: [] }, entry)).toThrow("mcpServers");
  });

  test("lives in the Claude application support directory", () => {
    expect(claudeDesktopConfigPath("/Users/someone")).toBe(
      "/Users/someone/Library/Application Support/Claude/claude_desktop_config.json",
    );
  });
});

describe("setup arguments", () => {
  test("takes the word after setup as the target", () => {
    expect(parseCliArgs(["setup", "claude-desktop"])).toMatchObject({
      command: "setup",
      target: "claude-desktop",
      unknown: [],
    });
  });

  test("still rejects extra words on other commands", () => {
    expect(parseCliArgs(["status", "claude-desktop"]).unknown).toEqual(["claude-desktop"]);
  });
});
