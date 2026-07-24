import { describe, expect, test } from "bun:test";
import { fetchItemDetails, type ItemDetailsRunner } from "../src/item-details";
import { emptyGithubCache } from "../src/github-cache";
import type { Config, WatchItem } from "../src/types";

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
    prSearchTtlSeconds: 600,
    issueSearchTtlSeconds: 1200,
    prViewTtlSeconds: 1800,
    issueViewTtlSeconds: 3600,
    rateLimitBackoffSeconds: 900,
  };
}

function item(kind: WatchItem["kind"] = "pr_review_request"): WatchItem {
  return {
    id: `acme/api#42:${kind}`,
    kind,
    lifecycle: "new",
    repo: "acme/api",
    repoName: "api",
    number: 42,
    title: "Add retry",
    actor: "octo",
    url: "https://ghe.example.com/acme/api/pull/42",
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T10:00:00Z",
    firstSeenAt: "",
    lastSeenAt: "",
    isDraft: false,
    labels: [],
    summary: "Add retry.",
  };
}

describe("fetchItemDetails", () => {
  test("fetches PR body and comments lazily", async () => {
    const calls: string[][] = [];
    const runner: ItemDetailsRunner = async (_config, args) => {
      calls.push(args);
      return {
        body: "PR body.",
        comments: [
          {
            id: "comment-1",
            author: { login: "reviewer" },
            body: "Looks good.",
            url: "https://ghe.example.com/comment/1",
            createdAt: "2026-06-01T10:10:00Z",
            updatedAt: "2026-06-01T10:10:00Z",
          },
        ],
      } as never;
    };

    const details = await fetchItemDetails(config(), item(), emptyGithubCache(), runner);

    expect(calls[0]).toEqual(["pr", "view", "42", "--repo", "acme/api", "--json", "body,comments,reviews"]);
    expect(details.body).toBe("PR body.");
    expect(details.comments[0]).toMatchObject({ author: "reviewer", body: "Looks good." });
  });

  test("uses issue view for issue notifications", async () => {
    const calls: string[][] = [];
    const runner: ItemDetailsRunner = async (_config, args) => {
      calls.push(args);
      return { body: "Issue body.", comments: [] } as never;
    };

    await fetchItemDetails(config(), item("issue_assigned"), emptyGithubCache(), runner);

    expect(calls[0]).toEqual(["issue", "view", "42", "--repo", "acme/api", "--json", "body,comments"]);
  });

  test("reuses cached details while updatedAt is unchanged", async () => {
    const cache = emptyGithubCache();
    let calls = 0;
    const runner: ItemDetailsRunner = async () => {
      calls += 1;
      return { body: `Body ${calls}.`, comments: [] } as never;
    };

    const first = await fetchItemDetails(config(), item(), cache, runner);
    const second = await fetchItemDetails(config(), item(), cache, runner);

    expect(first.body).toBe("Body 1.");
    expect(second.body).toBe("Body 1.");
    expect(calls).toBe(1);
  });

  test("falls back to stale cached details when refresh fails", async () => {
    const cache = emptyGithubCache();
    const staleItem = item("pr_review_request");
    const runner: ItemDetailsRunner = async () => ({ body: "Cached body.", comments: [] }) as never;
    await fetchItemDetails(config(), staleItem, cache, runner);

    const changed = { ...staleItem, updatedAt: "2026-06-01T11:00:00Z" };
    const details = await fetchItemDetails(config(), changed, cache, async () => {
      throw new Error("rate limit exceeded");
    });

    expect(details.body).toBe("Cached body.");
  });

  test("focuses comment notification details on the matching comment", async () => {
    const commentItem = {
      ...item("pr_comment"),
      id: "acme/api#42:pr_comment:comment-2",
      url: "https://ghe.example.com/comment/2",
      actor: "casey",
      summary: "Made suggested changes. Ready for re-review",
    };
    const details = await fetchItemDetails(config(), commentItem, emptyGithubCache(), async () => {
      return {
        body: "Parent PR body.",
        comments: [
          {
            id: "comment-1",
            author: { login: "someone" },
            body: "Older comment.",
            url: "https://ghe.example.com/comment/1",
            createdAt: "2026-06-01T10:00:00Z",
            updatedAt: "2026-06-01T10:00:00Z",
          },
          {
            id: "comment-2",
            author: { login: "casey" },
            body: "Made suggested changes. Ready for re-review",
            url: "https://ghe.example.com/comment/2",
            createdAt: "2026-06-01T10:10:00Z",
            updatedAt: "2026-06-01T10:10:00Z",
          },
        ],
      } as never;
    });

    expect(details.body).toBe("");
    expect(details.comments).toHaveLength(1);
    expect(details.comments[0]).toMatchObject({
      author: "casey",
      body: "Made suggested changes. Ready for re-review",
    });
  });

  test("review-comment details resolve from the reviews field, not issue comments", async () => {
    const reviewItem = {
      ...item("pr_review_comment"),
      id: "acme/api#42:pr_review_comment:r2",
      url: "https://ghe.example.com/acme/api/pull/42#pullrequestreview-2",
      actor: "reviewer",
      summary: "Review changes requested: Please add a test for the retry path.",
    };
    const calls: string[][] = [];
    const details = await fetchItemDetails(config(), reviewItem, emptyGithubCache(), async (_config, args) => {
      calls.push(args);
      return {
        body: "Parent PR body.",
        comments: [
          {
            id: "comment-1",
            author: { login: "someone" },
            body: "An unrelated conversation comment.",
            url: "https://ghe.example.com/comment/1",
            updatedAt: "2026-06-01T10:00:00Z",
          },
        ],
        reviews: [
          {
            id: "r2",
            state: "CHANGES_REQUESTED",
            author: { login: "reviewer" },
            body: "Please add a test for the retry path, and confirm the backoff cap.",
            url: "https://ghe.example.com/acme/api/pull/42#pullrequestreview-2",
            submittedAt: "2026-06-01T10:20:00Z",
          },
        ],
      } as never;
    });

    // The full review body is shown, not the truncated list summary, and the
    // unrelated issue comment is excluded.
    expect(calls[0]).toContain("body,comments,reviews");
    expect(details.comments).toHaveLength(1);
    expect(details.comments[0]).toMatchObject({
      author: "reviewer",
      body: "Please add a test for the retry path, and confirm the backoff cap.",
    });
  });
});
