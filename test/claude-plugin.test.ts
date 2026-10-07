import { describe, expect, test } from "bun:test";
// @ts-expect-error plain .mjs hook script shipped in the Claude Code plugin
import { contextLine } from "../claude-plugin/hooks/session-start.mjs";

const zero = { pr_review_request: 0, pr_comment: 0, issue_assigned: 0, issue_mention: 0, issue_comment: 0 };

describe("session-start hook line", () => {
  test("names each waiting kind with its count", () => {
    const line = contextLine({
      host: "github.com",
      waiting: 4,
      waitingByKind: { ...zero, pr_review_request: 1, issue_assigned: 3 },
    });
    expect(line).toBe(
      "attn: 1 review request, 3 assigned issues waiting on github.com. Use the attn MCP tools or /attn:triage to work through them.",
    );
  });

  test("stays silent when nothing is waiting or the status is malformed", () => {
    expect(contextLine({ host: "github.com", waiting: 0, waitingByKind: zero })).toBe("");
    expect(contextLine(undefined)).toBe("");
    expect(contextLine({ host: "github.com", waiting: "3" })).toBe("");
  });
});

// CI has no `claude` CLI to run `claude plugin validate`, so check the parts a
// release can break: the marketplace path, the names, and the version.
describe("plugin manifests", () => {
  const root = new URL("..", import.meta.url).pathname;
  const read = async (path: string) => JSON.parse(await Bun.file(`${root}${path}`).text());

  test("the marketplace entry points at the plugin directory", async () => {
    const marketplace = await read(".claude-plugin/marketplace.json");
    const [entry] = marketplace.plugins;
    const plugin = await read(`${entry.source.replace(/^\.\//, "")}/.claude-plugin/plugin.json`);
    expect(plugin.name).toBe(entry.name);
  });

  test("the plugin version matches the package version", async () => {
    const plugin = await read("claude-plugin/.claude-plugin/plugin.json");
    const pkg = await read("package.json");
    expect(plugin.version).toBe(pkg.version);
  });

  test("the plugin's MCP server runs attn mcp", async () => {
    const mcp = await read("claude-plugin/.mcp.json");
    expect(mcp.mcpServers.attn).toMatchObject({ command: "attn", args: ["mcp"] });
  });
});
