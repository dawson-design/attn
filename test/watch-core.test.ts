import { describe, expect, test } from "bun:test";
import { emptyGithubCache } from "../src/github-cache";
import { emptyState } from "../src/state";
import type { Config, RawSearchItem, WatchItem } from "../src/types";
import {
  actionLabel,
  actionsForItem,
  buildAgentLaunch,
  isDependabotPr,
  refreshWatcherData,
  visibleItems,
} from "../src/cli/watch-core";

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
    repos: ["api"],
    labels: [],
    limit: 50,
    issueLimit: 25,
    issueCommentItemLimit: 5,
    commentsPerIssue: 3,
    prSearchTtlSeconds: 0,
    issueSearchTtlSeconds: 0,
    prViewTtlSeconds: 0,
    issueViewTtlSeconds: 0,
    rateLimitBackoffSeconds: 900,
  };
}

function raw(kind: "pr" | "issue", overrides: Partial<RawSearchItem> = {}): RawSearchItem {
  return {
    repository: { name: "api", nameWithOwner: "acme/api" },
    number: kind === "pr" ? 10 : 20,
    title: kind === "pr" ? "Review the API" : "Track the API issue",
    url: `https://ghe.example.com/acme/api/${kind === "pr" ? "pull" : "issues"}/${kind === "pr" ? 10 : 20}`,
    author: { login: "octo" },
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    labels: [],
    body: kind === "pr" ? "PR body." : "Issue body.",
    ...overrides,
  };
}

function item(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    id: "acme/api#10:pr_review_request",
    kind: "pr_review_request",
    lifecycle: "new",
    repo: "acme/api",
    repoName: "api",
    number: 10,
    title: "Review the API",
    actor: "octo",
    url: "https://ghe.example.com/acme/api/pull/10",
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    firstSeenAt: "2026-06-01T10:00:00.000Z",
    lastSeenAt: "2026-06-01T10:00:00.000Z",
    isDraft: false,
    labels: [],
    summary: "PR body.",
    localPath: "/tmp/api",
    baseBranch: "main",
    headBranch: "feature/review-api",
    ...overrides,
  };
}

describe("terminal watcher core", () => {
  test("refreshes PRs, comments, issues, and issue comments through the existing watch pipeline", async () => {
    const calls: string[][] = [];
    const result = await refreshWatcherData({
      config: config(),
      state: emptyState(),
      cache: emptyGithubCache(),
      localRepos: new Map([["acme/api", "/tmp/api"]]),
      now: new Date("2026-06-01T11:00:00.000Z"),
      runner: async (_config, args) => {
        calls.push(args);
        if (args[0] === "search" && args[1] === "prs") return [raw("pr")] as never;
        if (args[0] === "pr" && args[1] === "view") {
          return {
            body: "PR detail body.",
            headRefName: "feature/review-api",
            baseRefName: "main",
            comments: [
              {
                id: "comment-1",
                author: { login: "reviewer" },
                body: "Please review this.",
                url: "https://ghe.example.com/acme/api/pull/10#comment-1",
                createdAt: "2026-06-01T10:30:00.000Z",
                updatedAt: "2026-06-01T10:30:00.000Z",
              },
            ],
          } as never;
        }
        if (args[0] === "search" && args[1] === "issues" && args.includes("--assignee")) return [raw("issue")] as never;
        if (args[0] === "search" && args[1] === "issues" && args.includes("--mentions")) return [] as never;
        if (args[0] === "issue" && args[1] === "view") {
          return {
            body: "Issue detail body.",
            comments: [
              {
                id: "issue-comment-1",
                author: { login: "teammate" },
                body: "Issue update.",
                url: "https://ghe.example.com/acme/api/issues/20#issue-comment-1",
                createdAt: "2026-06-01T10:45:00.000Z",
                updatedAt: "2026-06-01T10:45:00.000Z",
              },
            ],
          } as never;
        }
        return [] as never;
      },
    });

    expect(calls.some((args) => args.join(" ").includes("search prs --review-requested @me"))).toBe(true);
    expect(result.snapshot.items.map((candidate) => candidate.kind).sort()).toEqual([
      "issue_assigned",
      "issue_comment",
      "pr_comment",
      "pr_review_request",
    ]);
    expect(result.snapshot.items.every((candidate) => candidate.localPath === "/tmp/api")).toBe(true);
  });

  test("groups by notification type and sorts newest first while hiding acknowledged by default", () => {
    const ordered = visibleItems([
      item({ id: "issue-newest", kind: "issue_assigned", lifecycle: "new", updatedAt: "2026-06-01T13:00:00.000Z" }),
      item({ id: "ack", lifecycle: "acknowledged", updatedAt: "2026-06-01T14:00:00.000Z" }),
      item({ id: "pr-older", kind: "pr_review_request", lifecycle: "active", updatedAt: "2026-06-01T10:00:00.000Z" }),
      item({ id: "pr-newer", kind: "pr_review_request", lifecycle: "unread", updatedAt: "2026-06-01T11:00:00.000Z" }),
      item({ id: "comment", kind: "pr_comment", lifecycle: "new", updatedAt: "2026-06-01T12:00:00.000Z" }),
    ]);

    expect(ordered.map((candidate) => candidate.id)).toEqual(["pr-newer", "pr-older", "comment", "issue-newest"]);
    expect(
      visibleItems([item({ id: "ack", lifecycle: "acknowledged" })], true).map((candidate) => candidate.id),
    ).toEqual(["ack"]);
  });

  test("exposes review actions only for PR notifications", () => {
    expect(actionsForItem(item()).map(actionLabel)).toEqual([
      "Open URL",
      "Launch Codex review",
      "Launch Claude review",
      "Acknowledge",
      "Back",
    ]);
    expect(actionsForItem(item({ kind: "issue_assigned" })).map(actionLabel)).toEqual([
      "Open URL",
      "Acknowledge",
      "Back",
    ]);
  });

  test("marks Dependabot PR notifications", () => {
    expect(isDependabotPr(item({ actor: "dependabot[bot]" }))).toBe(true);
    expect(isDependabotPr(item({ actor: "dependabot-preview" }))).toBe(true);
    expect(isDependabotPr(item({ actor: "octo" }))).toBe(false);
    expect(isDependabotPr(item({ actor: "dependabot[bot]", kind: "issue_assigned" }))).toBe(false);
  });

  test("builds agent launch commands for Codex and Claude", async () => {
    const codex = await buildAgentLaunch(config(), item(), "codex");
    expect(codex.command).toBe("codex");
    expect(codex.args.slice(0, 2)).toEqual(["-C", "/tmp/api"]);
    expect(codex.prompt).toContain("Review pull request acme/api #10 locally.");

    const claude = await buildAgentLaunch(config(), item(), "claude");
    expect(claude.command).toBe("claude");
    expect(claude.cwd).toBe("/tmp/api");
    expect(claude.args[0]).toContain("Review pull request acme/api #10 locally.");
  });

  test("rejects local review launch without a PR item and local checkout", async () => {
    await expect(buildAgentLaunch(config(), item({ kind: "issue_assigned" }), "codex")).rejects.toThrow(
      "only available for PR",
    );
    await expect(buildAgentLaunch(config(), item({ localPath: undefined }), "codex")).rejects.toThrow(
      "No local checkout path",
    );
  });
});
