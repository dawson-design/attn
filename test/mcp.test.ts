import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AttnNotRunningError, type AttnApi } from "../src/attn-client";
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
    const api = new FakeApi(snapshot([item("a", "issue_mention"), item("b", "issue_mention")]));
    const client = await connect(api);
    await client.callTool({ name: "attn_ack", arguments: { ids: ["a", "b"] } });
    await client.callTool({ name: "attn_ack", arguments: { ids: ["a"], acknowledged: false } });
    expect(api.acks).toEqual([
      { ids: ["a", "b"], acknowledged: true },
      { ids: ["a"], acknowledged: false },
    ]);
  });

  test("attn_ack reports ids attn does not know instead of claiming them", async () => {
    const api = new FakeApi(snapshot([item("a", "issue_mention")]));
    const client = await connect(api);
    const body = JSON.parse(textOf(await client.callTool({ name: "attn_ack", arguments: { ids: ["a", "ghost"] } })));
    expect(body).toEqual({ acknowledged: true, matched: ["a"], unknown: ["ghost"] });
    expect(api.acks).toEqual([{ ids: ["a"], acknowledged: true }]);
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
