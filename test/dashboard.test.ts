import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhJsonRunner } from "../src/fetch";
import { emptyGithubCache, putSearch, saveGithubCache, type GithubCache } from "../src/github-cache";
import { createService } from "../src/lib/server/dashboard";
import type { AppState, Config, RawSearchItem, Snapshot } from "../src/types";

// These tests drive `createService` directly and never `getDashboardService`,
// which caches on globalThis and would leak one test's service into the next.

const REPO = "acme/api";
const PR_ID = `${REPO}#123:pr_review_request`;
const CHECKOUT = "/tmp/checkouts/api";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), "ghe-dashboard-"));
  tempDirs.push(dir);
  return {
    host: "ghe.example.com",
    workspace: dir,
    checkoutRoots: [dir],
    repoPathMap: {},
    port: 8765,
    pollSeconds: 3600,
    stateFile: join(dir, "state.json"),
    snapshotFile: join(dir, "snapshot.json"),
    cacheFile: join(dir, "github-cache.json"),
    repos: [],
    labels: [],
    limit: 50,
    issueLimit: 25,
    issueCommentItemLimit: 5,
    commentsPerIssue: 3,
    // Negative TTLs so a second refresh in the same test always re-runs the fake
    // runner instead of being served the entry the first refresh just cached.
    // Not 0: freshness is `age <= ttl * 1000`, so a 0 TTL still counts as fresh
    // for two refreshes landing in the same millisecond, which made these tests
    // flaky.
    prSearchTtlSeconds: -1,
    issueSearchTtlSeconds: -1,
    prViewTtlSeconds: -1,
    issueViewTtlSeconds: -1,
    rateLimitBackoffSeconds: 900,
    ...overrides,
  };
}

function rawPr(updatedAt = "2026-06-01T10:00:00.000Z"): RawSearchItem {
  return {
    repository: { name: "api", nameWithOwner: REPO },
    number: 123,
    title: "Update event handler",
    url: "https://ghe.example.com/acme/api/pull/123",
    author: { login: "octo" },
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt,
    labels: [],
    body: "Updates the event handler.",
  };
}

const DEFAULT_PR_VIEW = { body: "PR body", headRefName: "feature-x", baseRefName: "main" };

interface FakeRunner {
  calls: string[][];
  runner: GhJsonRunner;
  prSearchCount(): number;
}

function makeRunner(
  prSearch: () => RawSearchItem[],
  prView: object = DEFAULT_PR_VIEW,
  issueSearch: () => RawSearchItem[] = () => [],
): FakeRunner {
  const calls: string[][] = [];
  const runner: GhJsonRunner = async (_config, args) => {
    calls.push(args);
    if (args[0] === "search" && args[1] === "prs") return prSearch() as never;
    if (args[0] === "search" && args[1] === "issues") return issueSearch() as never;
    if (args[0] === "pr" && args[1] === "view") return prView as never;
    return {} as never;
  };
  return {
    calls,
    runner,
    prSearchCount: () => calls.filter((args) => args[0] === "search" && args[1] === "prs").length,
  };
}

function fakeClient() {
  const frames: string[] = [];
  const controller = {
    enqueue: (chunk: string) => {
      frames.push(chunk);
    },
  } as unknown as ReadableStreamDefaultController<string>;
  return { frames, controller };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("dashboard service refresh", () => {
  test("refresh builds a snapshot and persists state, snapshot, and cache", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });

    const snapshot = await service.refresh();

    expect(snapshot.items.map((item) => item.id)).toEqual([PR_ID]);
    expect(snapshot.cacheStatus).toBe("fresh");
    expect(snapshot.host).toBe("ghe.example.com");

    expect((await readJson<AppState>(config.stateFile)).items[PR_ID]).toBeDefined();
    expect((await readJson<Snapshot>(config.snapshotFile)).items).toHaveLength(1);
    expect((await readJson<GithubCache>(config.cacheFile)).searches["search:prs:review-requested"]).toBeDefined();

    service.dispose();
  });

  test("concurrent refreshes coalesce into a single fetch", async () => {
    const config = await tempConfig();
    const fake = makeRunner(() => [rawPr()]);
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);

    expect(fake.prSearchCount()).toBe(1);
    expect(first).toBe(second);

    service.dispose();
  });

  test("a rate-limited fetch records backoff in the snapshot and cache", async () => {
    const config = await tempConfig();
    const fake = makeRunner(() => {
      throw new Error("API rate limit exceeded");
    });
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    const snapshot = await service.refresh();

    expect(snapshot.cacheStatus).toBe("rate_limited");
    expect(snapshot.nextRefreshAllowedAt).toBeDefined();
    expect((await readJson<GithubCache>(config.cacheFile)).rateLimitUntil).toBeDefined();

    service.dispose();
  });

  test("refresh inside the backoff window short-circuits and keeps the previous items", async () => {
    const config = await tempConfig();
    let rateLimited = false;
    const fake = makeRunner(() => {
      if (rateLimited) throw new Error("API rate limit exceeded");
      return [rawPr()];
    });
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    await service.refresh();
    rateLimited = true;
    await service.refresh(); // trips the backoff
    const callsBefore = fake.prSearchCount();

    const skipped = await service.refresh();

    expect(fake.prSearchCount()).toBe(callsBefore); // never reached the runner
    expect(skipped.cacheStatus).toBe("rate_limited");
    expect(skipped.errors.some((error) => /Rate limit backoff active/.test(error))).toBe(true);
    expect(skipped.items.map((item) => item.id)).toEqual([PR_ID]);

    service.dispose();
  });

  test("a skipped refresh keeps unrelated errors and does not stack backoff notices", async () => {
    const config = await tempConfig();
    const fake = makeRunner(
      () => {
        throw new Error("API rate limit exceeded");
      },
      DEFAULT_PR_VIEW,
      () => {
        throw new Error("boom");
      },
    );
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    await service.refresh(); // trips the backoff, and records an unrelated failure
    const first = await service.refresh();
    const second = await service.refresh();

    const backoffNotices = (snapshot: typeof second) =>
      snapshot.errors.filter((error) => /Rate limit backoff active/.test(error));

    expect(first.errors.some((error) => /boom/.test(error))).toBe(true);
    expect(backoffNotices(first)).toHaveLength(1);
    expect(second.errors.some((error) => /boom/.test(error))).toBe(true);
    expect(backoffNotices(second)).toHaveLength(1);

    service.dispose();
  });

  test("a forced refresh bypasses the backoff window", async () => {
    const config = await tempConfig();
    const fake = makeRunner(() => {
      throw new Error("API rate limit exceeded");
    });
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    await service.refresh();
    const callsBefore = fake.prSearchCount();

    await service.refresh({ force: true });

    expect(fake.prSearchCount()).toBe(callsBefore + 1);

    service.dispose();
  });

  // The rule this guards: an item absent from a DEGRADED fetch must keep its
  // stored record. Dropping it would erase the acknowledgement, and the item
  // would come back as "new" and re-notify once the fetch recovered.
  test("an item missing from a partial fetch keeps its acknowledgement when it returns", async () => {
    const config = await tempConfig();
    let prsVisible = true;
    let issuesFailing = false;
    const fake = makeRunner(
      () => (prsVisible ? [rawPr()] : []),
      DEFAULT_PR_VIEW,
      () => {
        if (issuesFailing) throw new Error("boom");
        return [];
      },
    );
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    await service.refresh();
    await service.acknowledge([PR_ID], true);

    // A degraded refresh in which the PR is not returned.
    prsVisible = false;
    issuesFailing = true;
    const degraded = await service.refresh();
    expect(degraded.cacheStatus).toBe("partial");
    expect(degraded.items.find((item) => item.id === PR_ID)).toBeUndefined();
    expect((await readJson<AppState>(config.stateFile)).items[PR_ID]?.acknowledgedAt).toBeDefined();

    // The PR comes back: it must still read as acknowledged, not as new.
    prsVisible = true;
    issuesFailing = false;
    const recovered = await service.refresh();

    expect(recovered.cacheStatus).toBe("fresh");
    expect(recovered.items.find((item) => item.id === PR_ID)?.lifecycle).toBe("acknowledged");

    service.dispose();
  });
});

// Regression: a cache written against a different GitHub host was served as
// fresh data for the new host, so the dashboard showed the other host's PRs
// under the configured host's name.
describe("dashboard service cross-host cache", () => {
  const OTHER_HOST_PR: RawSearchItem = {
    repository: { name: "service", nameWithOwner: "globex/service" },
    number: 77,
    title: "From the other host",
    url: "https://github.com/globex/service/pull/77",
    author: { login: "someone" },
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    labels: [],
  };

  async function seedCacheForHost(config: Config, host: string): Promise<void> {
    const seeded = emptyGithubCache(host);
    putSearch(seeded, "search:prs:review-requested", [OTHER_HOST_PR], new Date().toISOString());
    putSearch(seeded, "search:issues:assigned", [], new Date().toISOString());
    putSearch(seeded, "search:issues:mentions", [], new Date().toISOString());
    await saveGithubCache(config.cacheFile, seeded);
  }

  test("a cache from another host is not served for the configured host", async () => {
    // Positive TTLs: the cache would be considered fresh if it were kept.
    const config = await tempConfig({
      host: "ghe.example.com",
      prSearchTtlSeconds: 600,
      issueSearchTtlSeconds: 600,
      prViewTtlSeconds: 1800,
      issueViewTtlSeconds: 3600,
    });
    await seedCacheForHost(config, "github.com");
    const fake = makeRunner(() => [rawPr()]);
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    const snapshot = await service.refresh();

    expect(fake.prSearchCount()).toBe(1); // had to go fetch, cache was discarded
    expect(snapshot.items.map((item) => item.id)).toEqual([PR_ID]);
    expect(snapshot.items.some((item) => item.repo.startsWith("globex/"))).toBe(false);

    service.dispose();
  });

  test("a cache from the same host is still reused", async () => {
    const config = await tempConfig({
      host: "ghe.example.com",
      prSearchTtlSeconds: 600,
      issueSearchTtlSeconds: 600,
      prViewTtlSeconds: 1800,
      issueViewTtlSeconds: 3600,
    });
    await seedCacheForHost(config, "ghe.example.com");
    const fake = makeRunner(() => [rawPr()]);
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });

    const snapshot = await service.refresh();

    expect(fake.prSearchCount()).toBe(0); // served from cache, no search issued
    expect(snapshot.items.some((item) => item.number === 77)).toBe(true);

    service.dispose();
  });
});

describe("dashboard service SSE fan-out", () => {
  test("addClient immediately sends the current snapshot as an SSE frame", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => []);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    const client = fakeClient();

    service.addClient(client.controller);

    expect(client.frames).toHaveLength(1);
    expect(client.frames[0].startsWith("event: snapshot\ndata: ")).toBe(true);
    expect(client.frames[0].endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(client.frames[0].slice("event: snapshot\ndata: ".length)) as Snapshot;
    expect(payload.host).toBe("ghe.example.com");

    service.dispose();
  });

  test("a refresh broadcasts to every registered client", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    const first = fakeClient();
    const second = fakeClient();
    service.addClient(first.controller);
    service.addClient(second.controller);

    await service.refresh();

    expect(first.frames).toHaveLength(2);
    expect(second.frames).toHaveLength(2);

    service.dispose();
  });

  test("a client that throws on enqueue is dropped and does not break the broadcast", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });

    let attempts = 0;
    const broken = {
      enqueue: () => {
        attempts += 1;
        if (attempts > 1) throw new Error("stream closed");
      },
    } as unknown as ReadableStreamDefaultController<string>;
    const healthy = fakeClient();
    service.addClient(broken); // attempt 1 succeeds
    service.addClient(healthy.controller);

    await service.refresh(); // attempt 2 throws, broken client is removed
    await service.refresh();

    expect(attempts).toBe(2);
    expect(healthy.frames).toHaveLength(3); // initial + two broadcasts

    service.dispose();
  });

  test("removeClient stops further delivery", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    const client = fakeClient();
    service.addClient(client.controller);

    service.removeClient(client.controller);
    await service.refresh();

    expect(client.frames).toHaveLength(1);

    service.dispose();
  });
});

describe("dashboard service local-state actions", () => {
  test("acknowledge updates lifecycle and persists without re-fetching", async () => {
    const config = await tempConfig();
    const fake = makeRunner(() => [rawPr()]);
    const service = await createService({
      config,
      runner: fake.runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });
    await service.refresh();
    const client = fakeClient();
    service.addClient(client.controller);
    const callsBefore = fake.calls.length;

    await service.acknowledge([PR_ID], true);

    expect(fake.calls.length).toBe(callsBefore); // fast path, no gh calls
    expect(service.getSnapshot().items.find((item) => item.id === PR_ID)?.lifecycle).toBe("acknowledged");
    expect((await readJson<AppState>(config.stateFile)).items[PR_ID]?.acknowledgedAt).toBeDefined();
    expect(client.frames).toHaveLength(2); // initial + broadcast

    service.dispose();
  });

  test("unacknowledge reverses the acknowledgement", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    await service.refresh();

    await service.acknowledge([PR_ID], true);
    await service.acknowledge([PR_ID], false);

    expect(service.getSnapshot().items.find((item) => item.id === PR_ID)?.lifecycle).toBe("active");
    expect((await readJson<AppState>(config.stateFile)).items[PR_ID]?.acknowledgedAt).toBeUndefined();

    service.dispose();
  });
});

describe("dashboard service item details and review prompt", () => {
  test("getItemDetails returns details for a known item and caches them", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()], {
      ...DEFAULT_PR_VIEW,
      comments: [
        {
          id: "c1",
          body: "Please rebase.",
          url: "https://ghe.example.com/acme/api/pull/123#c1",
          author: { login: "reviewer" },
          createdAt: "2026-06-01T10:30:00.000Z",
          updatedAt: "2026-06-01T10:30:00.000Z",
        },
      ],
    });
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    await service.refresh();

    const result = await service.getItemDetails(PR_ID);

    expect(result.ok).toBe(true);
    expect(result.details.body).toBe("PR body");
    expect(result.details.comments.map((comment) => comment.body)).toContain("Please rebase.");
    expect((await readJson<GithubCache>(config.cacheFile)).views[`details:${PR_ID}`]).toBeDefined();

    service.dispose();
  });

  test("getItemDetails rejects an id that is not in the snapshot", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    await service.refresh();

    await expect(service.getItemDetails("nope")).rejects.toThrow(/was not found/);

    service.dispose();
  });

  test("buildAgentReviewPrompt uses the item's local checkout path", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({
      config,
      runner,
      discoverRepos: async () => new Map([[REPO, CHECKOUT]]),
      startPolling: false,
    });
    await service.refresh();

    const result = await service.buildAgentReviewPrompt(PR_ID);

    expect(result.ok).toBe(true);
    expect(result.prompt).toContain(CHECKOUT);
    expect(result.prompt).toContain("123");

    service.dispose();
  });

  test("buildAgentReviewPrompt re-discovers the checkout when the item has no local path", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    let discoveries = 0;
    const service = await createService({
      config,
      runner,
      discoverRepos: async () => {
        discoveries += 1;
        // Empty during the refresh, so the snapshot item has no localPath.
        return discoveries === 1 ? new Map() : new Map([[REPO, CHECKOUT]]);
      },
      startPolling: false,
    });
    await service.refresh();

    const result = await service.buildAgentReviewPrompt(PR_ID);

    expect(discoveries).toBe(2);
    expect(result.prompt).toContain(CHECKOUT);

    service.dispose();
  });

  test("buildAgentReviewPrompt rejects an unknown id", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({ config, runner, discoverRepos: async () => new Map(), startPolling: false });
    await service.refresh();

    await expect(service.buildAgentReviewPrompt("nope")).rejects.toThrow(/was not found/);

    service.dispose();
  });
});

describe("dashboard service review terminal", () => {
  test("writes a 0700 .command script and hands it to the launcher on macOS", async () => {
    const config = await tempConfig({ terminalApp: "Ghostty" });
    const { runner } = makeRunner(() => [rawPr()]);
    const launched: Array<{ path: string; app?: string }> = [];
    const service = await createService({
      config,
      runner,
      discoverRepos: async () => new Map([[REPO, CHECKOUT]]),
      platform: "darwin",
      launchTerminal: async (path, app) => {
        launched.push({ path, app });
      },
      startPolling: false,
    });
    await service.refresh();

    const result = await service.openReviewTerminal(PR_ID);

    expect(result.ok).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0].app).toBe("Ghostty");
    expect(launched[0].path.endsWith("review-api-123.command")).toBe(true);

    const script = await readFile(launched[0].path, "utf8");
    expect(script.startsWith("#!/bin/zsh")).toBe(true);
    expect(script).toContain(CHECKOUT);
    expect((await stat(launched[0].path)).mode & 0o777).toBe(0o700);

    service.dispose();
  });

  test("refuses to open a review terminal off macOS", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const launched: string[] = [];
    const service = await createService({
      config,
      runner,
      discoverRepos: async () => new Map([[REPO, CHECKOUT]]),
      platform: "linux",
      launchTerminal: async (path) => {
        launched.push(path);
      },
      startPolling: false,
    });
    await service.refresh();

    await expect(service.openReviewTerminal(PR_ID)).rejects.toThrow(/only supported on macOS/);
    expect(launched).toHaveLength(0);

    service.dispose();
  });

  test("rejects an unknown id before launching anything", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const launched: string[] = [];
    const service = await createService({
      config,
      runner,
      discoverRepos: async () => new Map([[REPO, CHECKOUT]]),
      platform: "darwin",
      launchTerminal: async (path) => {
        launched.push(path);
      },
      startPolling: false,
    });
    await service.refresh();

    await expect(service.openReviewTerminal("nope")).rejects.toThrow(/was not found/);
    expect(launched).toHaveLength(0);

    service.dispose();
  });
});

describe("dashboard service startup and failure handling", () => {
  test("a failing scheduled refresh surfaces the error on the snapshot instead of throwing", async () => {
    const config = await tempConfig();
    const { runner } = makeRunner(() => [rawPr()]);
    const service = await createService({
      config,
      runner,
      discoverRepos: async () => {
        throw new Error("workspace scan failed");
      },
      startPolling: true, // the startup refresh fires on a 0ms timer
    });

    for (let attempt = 0; attempt < 50 && service.getSnapshot().errors.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(service.getSnapshot().errors.some((error) => /workspace scan failed/.test(error))).toBe(true);

    service.dispose();
  });
});

describe("dispose", () => {
  test("ends every event stream so the server can exit", async () => {
    const config = await tempConfig();
    const service = await createService({
      config,
      runner: makeRunner(() => []).runner,
      discoverRepos: async () => new Map(),
      startPolling: false,
    });
    let closed = 0;
    const client = {
      enqueue: () => undefined,
      close: () => (closed += 1),
    } as unknown as ReadableStreamDefaultController<string>;
    service.addClient(client);
    service.dispose();
    expect(closed).toBe(1);
  });
});
