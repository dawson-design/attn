import { describe, expect, test } from "bun:test";
import { fetchWatchItems, type GhJsonRunner } from "../src/fetch";
import { emptyGithubCache, putSearch, putView } from "../src/github-cache";
import type { Config, RawSearchItem } from "../src/types";

function config(): Config {
  return {
    host: "ghe.example.com",
    workspace: "/tmp",
    checkoutRoots: ["/tmp"],
    repoPathMap: {},
    port: 8765,
    pollSeconds: 900,
    stateFile: "/tmp/state.json",
    snapshotFile: "/tmp/snapshot.json",
    cacheFile: "/tmp/github-cache.json",
    repos: ["api", "docs"],
    labels: [],
    limit: 50,
    issueLimit: 25,
    issueCommentItemLimit: 5,
    commentsPerIssue: 3,
    prSearchTtlSeconds: 600,
    issueSearchTtlSeconds: 1200,
    prViewTtlSeconds: 1800,
    issueViewTtlSeconds: 3600,
    rateLimitBackoffSeconds: 900,
  };
}

function rawPr(updatedAt = "2026-06-01T10:00:00.000Z"): RawSearchItem {
  return {
    repository: { name: "api", nameWithOwner: "acme/api" },
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

function freshEmptyIssueSearches(cache: ReturnType<typeof emptyGithubCache>): void {
  const now = new Date().toISOString();
  putSearch(cache, "search:issues:assigned", [], now);
  putSearch(cache, "search:issues:mentions", [], now);
}

describe("fetch cache pipeline", () => {
  test("fresh search cache avoids gh search", async () => {
    const cache = emptyGithubCache();
    putSearch(cache, "search:prs:review-requested", [], new Date().toISOString());
    freshEmptyIssueSearches(cache);
    const calls: string[][] = [];
    const runner: GhJsonRunner = async (_config, args) => {
      calls.push(args);
      return [] as never;
    };

    await fetchWatchItems(config(), new Map(), cache, runner);

    expect(calls.find((args) => args[0] === "search" && args[1] === "prs")).toBeUndefined();
  });

  test("expired search cache triggers gh search", async () => {
    const cache = emptyGithubCache();
    putSearch(cache, "search:prs:review-requested", [], "2026-05-01T10:00:00.000Z");
    freshEmptyIssueSearches(cache);
    const calls: string[][] = [];
    const runner: GhJsonRunner = async (_config, args) => {
      calls.push(args);
      return [] as never;
    };

    await fetchWatchItems(config(), new Map(), cache, runner);

    expect(calls.find((args) => args[0] === "search" && args[1] === "prs")).toBeDefined();
  });

  test("unchanged PR updatedAt reuses cached pr view", async () => {
    const cache = emptyGithubCache();
    const pr = rawPr();
    putSearch(cache, "search:prs:review-requested", [pr], new Date().toISOString());
    putView(cache, "pr:acme/api#123", pr.updatedAt, { headRefName: "feat-cached" }, new Date().toISOString());
    freshEmptyIssueSearches(cache);
    const calls: string[][] = [];
    const runner: GhJsonRunner = async (_config, args) => {
      calls.push(args);
      return [] as never;
    };

    const result = await fetchWatchItems(config(), new Map(), cache, runner);

    expect(calls.find((args) => args[0] === "pr" && args[1] === "view")).toBeUndefined();
    expect(result.items[0].headBranch).toBe("feat-cached");
  });

  test("changed PR updatedAt refreshes pr view", async () => {
    const cache = emptyGithubCache();
    const pr = rawPr("2026-06-01T11:00:00.000Z");
    putSearch(cache, "search:prs:review-requested", [pr], new Date().toISOString());
    putView(
      cache,
      "pr:acme/api#123",
      "2026-06-01T10:00:00.000Z",
      { headRefName: "feat-stale" },
      new Date().toISOString(),
    );
    freshEmptyIssueSearches(cache);
    const calls: string[][] = [];
    const runner: GhJsonRunner = async (_config, args) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view") return { headRefName: "feat-fresh" } as never;
      return [] as never;
    };

    const result = await fetchWatchItems(config(), new Map(), cache, runner);

    expect(calls.find((args) => args[0] === "pr" && args[1] === "view")).toBeDefined();
    expect(result.items[0].headBranch).toBe("feat-fresh");
  });

  test("rate limit returns cached data and marks result rate limited", async () => {
    const cache = emptyGithubCache();
    const pr = rawPr();
    putSearch(cache, "search:prs:review-requested", [pr], "2026-05-01T10:00:00.000Z");
    putView(cache, "pr:acme/api#123", pr.updatedAt, { headRefName: "feat-rl" }, new Date().toISOString());
    freshEmptyIssueSearches(cache);
    const runner: GhJsonRunner = async (_config, args) => {
      if (args[0] === "search" && args[1] === "prs") throw new Error("HTTP 403: API rate limit exceeded");
      return [] as never;
    };

    const result = await fetchWatchItems(config(), new Map(), cache, runner);

    expect(result.cacheStatus).toBe("rate_limited");
    expect(result.rateLimited).toBe(true);
    expect(result.items[0].headBranch).toBe("feat-rl");
    expect(result.errors.join("\n")).toContain("Showing cached pr search results");
  });

  test("PR comment items are capped and review submissions become items", async () => {
    const cache = emptyGithubCache();
    const pr = rawPr();
    putSearch(cache, "search:prs:review-requested", [pr], new Date().toISOString());
    freshEmptyIssueSearches(cache);
    const comments = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      body: `comment ${i}`,
      author: { login: "octo" },
      createdAt: "2026-06-01T09:30:00.000Z",
      updatedAt: "2026-06-01T09:30:00.000Z",
    }));
    const runner: GhJsonRunner = async (_config, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          body: "Body.",
          comments,
          reviews: [
            { id: "r1", state: "COMMENTED", body: "", author: { login: "quiet" } },
            {
              id: "r2",
              state: "CHANGES_REQUESTED",
              body: "Please add a test.",
              author: { login: "reviewer" },
              submittedAt: "2026-06-01T09:45:00.000Z",
            },
          ],
        } as never;
      }
      return [] as never;
    };

    const result = await fetchWatchItems(config(), new Map(), cache, runner);

    const commentItems = result.items.filter((candidate) => candidate.kind === "pr_comment");
    expect(commentItems).toHaveLength(3); // commentsPerIssue, latest only
    expect(commentItems.map((candidate) => candidate.summary)).toEqual(["comment 7", "comment 8", "comment 9"]);

    const reviewItems = result.items.filter((candidate) => candidate.kind === "pr_review_comment");
    // The body-less COMMENTED review is noise and is dropped.
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0].actor).toBe("reviewer");
    expect(reviewItems[0].summary).toBe("Review changes requested: Please add a test.");
  });

  test("commentsPerIssue of 0 surfaces no comment or review items", async () => {
    const cache = emptyGithubCache();
    const pr = rawPr();
    putSearch(cache, "search:prs:review-requested", [pr], new Date().toISOString());
    freshEmptyIssueSearches(cache);
    const runner: GhJsonRunner = async (_config, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          body: "Body.",
          comments: [{ id: "c1", body: "hi", author: { login: "octo" } }],
          reviews: [{ id: "r1", state: "CHANGES_REQUESTED", body: "fix", author: { login: "rev" } }],
        } as never;
      }
      return [] as never;
    };

    const cfg = { ...config(), commentsPerIssue: 0 };
    const result = await fetchWatchItems(cfg, new Map(), cache, runner);

    // 0 means "none": slice(-0) must not fall back to returning everything.
    expect(result.items.filter((candidate) => candidate.kind === "pr_comment")).toHaveLength(0);
    expect(result.items.filter((candidate) => candidate.kind === "pr_review_comment")).toHaveLength(0);
    expect(result.items.some((candidate) => candidate.kind === "pr_review_request")).toBe(true);
  });

  test("a non-rate-limit view failure is reported, not silently treated as fresh", async () => {
    const cache = emptyGithubCache();
    const pr = rawPr();
    putSearch(cache, "search:prs:review-requested", [pr], new Date().toISOString());
    freshEmptyIssueSearches(cache);
    const runner: GhJsonRunner = async (_config, args) => {
      if (args[0] === "pr" && args[1] === "view") throw new Error("HTTP 500: server error");
      return [] as never;
    };

    const result = await fetchWatchItems(config(), new Map(), cache, runner);

    // A swallowed view error would leave errors empty and cacheStatus "fresh",
    // which makes the caller drop (and re-notify) this PR's ack state.
    expect(result.errors.join("\n")).toContain("server error");
    expect(result.cacheStatus).not.toBe("fresh");
    expect(result.cacheStatus).toBe("partial");
  });

  test("empty repos and labels keep every searched item", async () => {
    const cache = emptyGithubCache();
    const unrelated: RawSearchItem = {
      repository: { name: "unrelated-service", nameWithOwner: "acme/unrelated-service" },
      number: 5,
      title: "Anything",
      url: "https://ghe.example.com/acme/unrelated-service/pull/5",
      author: { login: "octo" },
      createdAt: "2026-06-01T09:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      labels: [],
      body: "No matching repo or label.",
    };
    const now = new Date().toISOString();
    putSearch(cache, "search:prs:review-requested", [unrelated], now);
    freshEmptyIssueSearches(cache);

    const cfg = { ...config(), repos: [], labels: [] };
    const result = await fetchWatchItems(cfg, new Map(), cache, async () => [] as never);

    expect(result.items.some((candidate) => candidate.number === 5)).toBe(true);
  });

  test("repos filter is an exact match: a sibling under the same family is excluded", async () => {
    const cache = emptyGithubCache();
    // config().repos is ["api"]. A sibling that merely shares the
    // "api-" family must NOT slip through (this is the prefix->exact fix).
    const sibling: RawSearchItem = {
      repository: { name: "api-docs", nameWithOwner: "acme/api-docs" },
      number: 6,
      title: "Sibling repo",
      url: "https://ghe.example.com/acme/api-docs/pull/6",
      author: { login: "octo" },
      createdAt: "2026-06-01T09:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      labels: [],
      body: "Shares the family prefix but is not in the allowlist.",
    };
    const now = new Date().toISOString();
    putSearch(cache, "search:prs:review-requested", [sibling], now);
    freshEmptyIssueSearches(cache);

    const result = await fetchWatchItems(config(), new Map(), cache, async () => [] as never);

    expect(result.items.some((candidate) => candidate.number === 6)).toBe(false);
  });

  test("repos filter matches on fully-qualified owner/repo too", async () => {
    const cache = emptyGithubCache();
    const pr: RawSearchItem = {
      repository: { name: "api", nameWithOwner: "acme/api" },
      number: 8,
      title: "Qualified match",
      url: "https://ghe.example.com/acme/api/pull/8",
      author: { login: "octo" },
      createdAt: "2026-06-01T09:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      labels: [],
      body: "Matched by owner/repo.",
    };
    const now = new Date().toISOString();
    putSearch(cache, "search:prs:review-requested", [pr], now);
    freshEmptyIssueSearches(cache);

    const cfg = { ...config(), repos: ["acme/api"] };
    const result = await fetchWatchItems(cfg, new Map(), cache, async () => [] as never);

    expect(result.items.some((candidate) => candidate.number === 8)).toBe(true);
  });

  test("an issue that is both assigned and mentioned appears once", async () => {
    const cache = emptyGithubCache();
    const issue: RawSearchItem = {
      repository: { name: "docs", nameWithOwner: "acme/docs" },
      number: 7,
      title: "Document the worker",
      url: "https://ghe.example.com/acme/docs/issues/7",
      author: { login: "octo" },
      createdAt: "2026-06-01T09:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
      labels: [],
      body: "We should document the worker end to end.",
    };
    const now = new Date().toISOString();
    putSearch(cache, "search:prs:review-requested", [], now);
    putSearch(cache, "search:issues:assigned", [issue], now);
    putSearch(cache, "search:issues:mentions", [issue], now);

    const result = await fetchWatchItems(config(), new Map(), cache, async () => [] as never);

    const issueItems = result.items.filter((candidate) => candidate.number === 7);
    expect(issueItems).toHaveLength(1);
    expect(issueItems[0].kind).toBe("issue_assigned");
  });
});
