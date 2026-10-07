import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeAgentCredentials } from "../src/agent-token";
import { AttnNotRunningError, httpAttnApi, type AttnApi } from "../src/mcp/api";
import { createAttnMcpServer } from "../src/mcp/server";
import type { Snapshot, WatchItem } from "../src/types";

function item(id: string, kind: WatchItem["kind"], overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    id,
    kind,
    lifecycle: "new",
    repo: "acme/api",
    repoName: "api",
    number: 7,
    title: `Title ${id}`,
    actor: "someone",
    url: "https://github.com/acme/api/pull/7",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    firstSeenAt: "2026-10-01T00:00:00Z",
    lastSeenAt: "2026-10-01T00:00:00Z",
    isDraft: false,
    labels: [],
    summary: "Summary",
    ...overrides,
  };
}

function snapshot(items: WatchItem[]): Snapshot {
  return { generatedAt: "2026-10-02T00:00:00Z", host: "github.com", items, errors: [], cacheStatus: "fresh" };
}

class FakeApi implements AttnApi {
  acks: Array<{ ids: string[]; acknowledged: boolean }> = [];
  refreshes = 0;
  constructor(
    private readonly snap: Snapshot,
    private readonly failure?: Error,
  ) {}
  async items() {
    if (this.failure) throw this.failure;
    return this.snap;
  }
  async acknowledge(ids: string[], acknowledged: boolean) {
    if (this.failure) throw this.failure;
    this.acks.push({ ids, acknowledged });
  }
  async reviewPrompt(id: string) {
    if (this.failure) throw this.failure;
    return `Review ${id}`;
  }
  async refresh() {
    if (this.failure) throw this.failure;
    this.refreshes += 1;
    return this.snap;
  }
}

async function connect(api: AttnApi): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createAttnMcpServer(api, "0.0.0-test").connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

describe("attn mcp tools", () => {
  test("marks only attn_ack as a write", async () => {
    const client = await connect(new FakeApi(snapshot([])));
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
    expect(hints).toEqual({ attn_items: true, attn_ack: false, attn_review_prompt: true, attn_refresh: true });
    expect(tools.find((tool) => tool.name === "attn_ack")?.annotations?.destructiveHint).toBe(false);
  });

  test("attn_items returns waiting items with review requests first", async () => {
    const api = new FakeApi(
      snapshot([
        item("mention", "issue_mention", { updatedAt: "2026-10-03T00:00:00Z" }),
        item("review", "pr_review_request", { localPath: "/src/api" }),
        item("done", "pr_review_request", { lifecycle: "acknowledged" }),
      ]),
    );
    const client = await connect(api);
    const body = JSON.parse(textOf(await client.callTool({ name: "attn_items", arguments: {} })));
    expect(body.items.map((entry: { id: string }) => entry.id)).toEqual(["review", "mention"]);
    expect(body.items[0]).toMatchObject({ kind: "pr_review_request", localPath: "/src/api" });
    expect(body.cacheStatus).toBe("fresh");
  });

  test("attn_items filters by kind and can include acknowledged items", async () => {
    const api = new FakeApi(
      snapshot([
        item("review", "pr_review_request"),
        item("done", "pr_review_request", { lifecycle: "acknowledged" }),
        item("mention", "issue_mention"),
      ]),
    );
    const client = await connect(api);
    const result = await client.callTool({
      name: "attn_items",
      arguments: { kind: "pr_review_request", include_acknowledged: true },
    });
    const ids = JSON.parse(textOf(result)).items.map((entry: { id: string }) => entry.id);
    expect(ids.sort()).toEqual(["done", "review"]);
  });

  test("attn_ack forwards ids and defaults to acknowledging", async () => {
    const api = new FakeApi(snapshot([]));
    const client = await connect(api);
    await client.callTool({ name: "attn_ack", arguments: { ids: ["a", "b"] } });
    await client.callTool({ name: "attn_ack", arguments: { ids: ["a"], acknowledged: false } });
    expect(api.acks).toEqual([
      { ids: ["a", "b"], acknowledged: true },
      { ids: ["a"], acknowledged: false },
    ]);
  });

  test("attn_ack rejects an empty id list", async () => {
    const api = new FakeApi(snapshot([]));
    const client = await connect(api);
    const result = await client.callTool({ name: "attn_ack", arguments: { ids: [] } });
    expect(result.isError).toBe(true);
    expect(api.acks).toEqual([]);
  });

  test("attn_review_prompt returns the prompt and the local checkout", async () => {
    const client = await connect(
      new FakeApi(snapshot([item("review", "pr_review_request", { localPath: "/src/api" })])),
    );
    const body = JSON.parse(textOf(await client.callTool({ name: "attn_review_prompt", arguments: { id: "review" } })));
    expect(body).toEqual({ id: "review", localPath: "/src/api", prompt: "Review review" });
  });

  test("attn_refresh asks the server to refresh", async () => {
    const api = new FakeApi(snapshot([item("review", "pr_review_request")]));
    const client = await connect(api);
    const body = JSON.parse(textOf(await client.callTool({ name: "attn_refresh", arguments: {} })));
    expect(api.refreshes).toBe(1);
    expect(body).toMatchObject({ waiting: 1, cacheStatus: "fresh" });
  });

  test("tools report a stopped server as a tool error", async () => {
    const client = await connect(new FakeApi(snapshot([]), new AttnNotRunningError()));
    const result = await client.callTool({ name: "attn_items", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("attn is not running");
  });

  test("the triage prompt waits for confirmation", async () => {
    const client = await connect(new FakeApi(snapshot([])));
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(["triage"]);
    const prompt = await client.getPrompt({ name: "triage" });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toContain("Make no changes until I confirm");
  });
});

describe("httpAttnApi", () => {
  let dir: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => {
    server?.stop(true);
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function credentialsFor(port: number, token = "secret"): Promise<string> {
    dir = await mkdtemp(`${tmpdir()}/attn-mcp-`);
    const path = `${dir}/agent.json`;
    await writeAgentCredentials(path, { port, token });
    return path;
  }

  test("sends the bearer token and the request body", async () => {
    const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push({
          method: request.method,
          path: url.pathname,
          auth: request.headers.get("authorization"),
          body: await request.text(),
        });
        if (url.pathname === "/api/review-prompt") return Response.json({ ok: true, prompt: "P" });
        return Response.json({ ok: true });
      },
    });
    const api = httpAttnApi(await credentialsFor(server.port!));
    await api.acknowledge(["a"], true);
    expect(await api.reviewPrompt("a")).toBe("P");
    expect(seen[0]).toEqual({
      method: "POST",
      path: "/api/ack",
      auth: "Bearer secret",
      body: '{"ids":["a"],"acknowledged":true}',
    });
    expect(seen[1]).toMatchObject({ path: "/api/review-prompt", body: '{"id":"a"}' });
  });

  test("surfaces the server's error message", async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: false, error: "Unknown item" }, { status: 400 }) });
    const api = httpAttnApi(await credentialsFor(server.port!));
    await expect(api.reviewPrompt("x")).rejects.toThrow("Unknown item");
  });

  test("reports not running when agent.json is missing", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-mcp-`);
    await expect(httpAttnApi(`${dir}/agent.json`).items()).rejects.toBeInstanceOf(AttnNotRunningError);
  });

  test("reports not running when nothing listens on the port", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    await expect(httpAttnApi(await credentialsFor(port)).items()).rejects.toBeInstanceOf(AttnNotRunningError);
  });
});
