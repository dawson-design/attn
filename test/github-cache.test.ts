import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyGithubCache,
  getFreshSearch,
  getFreshView,
  loadGithubCache,
  pruneCache,
  putSearch,
  putView,
  saveGithubCache,
} from "../src/github-cache";
import type { RawSearchItem } from "../src/types";

const raw: RawSearchItem = {
  repository: { name: "api", nameWithOwner: "acme/api" },
  number: 123,
  title: "Test PR",
  url: "https://ghe.example.com/acme/api/pull/123",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("github cache", () => {
  test("fresh search cache is returned", () => {
    const cache = emptyGithubCache();
    putSearch(cache, "search:prs:review-requested", [raw], "2026-06-01T10:00:00.000Z");

    const result = getFreshSearch(cache, "search:prs:review-requested", 600, new Date("2026-06-01T10:05:00.000Z"));

    expect(result).toEqual([raw]);
  });

  test("expired search cache is skipped", () => {
    const cache = emptyGithubCache();
    putSearch(cache, "search:prs:review-requested", [raw], "2026-06-01T10:00:00.000Z");

    const result = getFreshSearch(cache, "search:prs:review-requested", 600, new Date("2026-06-01T10:11:00.000Z"));

    expect(result).toBeUndefined();
  });

  test("fresh view requires matching updatedAt", () => {
    const cache = emptyGithubCache();
    putView(cache, "pr:acme/api#123", raw.updatedAt, { changedFiles: 1 }, "2026-06-01T10:00:00.000Z");

    expect(
      getFreshView<{ changedFiles: number }>(
        cache,
        "pr:acme/api#123",
        raw.updatedAt,
        1800,
        new Date("2026-06-01T10:10:00.000Z"),
      ),
    ).toEqual({ changedFiles: 1 });
    expect(
      getFreshView(cache, "pr:acme/api#123", "2026-06-01T10:01:00.000Z", 1800, new Date("2026-06-01T10:10:00.000Z")),
    ).toBeUndefined();
  });

  test("cache written for one host is discarded when loaded for another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghe-cache-host-"));
    tempDirs.push(dir);
    const path = join(dir, "github-cache.json");
    const cache = emptyGithubCache("github.com");
    putSearch(cache, "search:prs:review-requested", [raw], "2026-06-01T10:00:00.000Z");
    await saveGithubCache(path, cache);

    const other = await loadGithubCache(path, "ghe.example.com");

    expect(other.searches["search:prs:review-requested"]).toBeUndefined();
    expect(other.host).toBe("ghe.example.com");
  });

  test("cache is reused when the host matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghe-cache-host-"));
    tempDirs.push(dir);
    const path = join(dir, "github-cache.json");
    const cache = emptyGithubCache("ghe.example.com");
    putSearch(cache, "search:prs:review-requested", [raw], "2026-06-01T10:00:00.000Z");
    await saveGithubCache(path, cache);

    const same = await loadGithubCache(path, "ghe.example.com");

    expect(same.searches["search:prs:review-requested"]?.payload).toEqual([raw]);
    expect(same.host).toBe("ghe.example.com");
  });

  test("a cache file predating the host field is discarded once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghe-cache-host-"));
    tempDirs.push(dir);
    const path = join(dir, "github-cache.json");
    const legacy = emptyGithubCache();
    putSearch(legacy, "search:prs:review-requested", [raw], "2026-06-01T10:00:00.000Z");
    await saveGithubCache(path, legacy);

    const loaded = await loadGithubCache(path, "ghe.example.com");

    expect(loaded.searches["search:prs:review-requested"]).toBeUndefined();
    expect(loaded.host).toBe("ghe.example.com");
  });

  test("prune removes old entries and keeps recent entries", () => {
    const cache = emptyGithubCache();
    putSearch(cache, "old-search", [raw], "2026-05-01T10:00:00.000Z");
    putSearch(cache, "new-search", [raw], "2026-06-01T10:00:00.000Z");
    putView(cache, "old-view", raw.updatedAt, { body: "old" }, "2026-05-01T10:00:00.000Z");
    putView(cache, "new-view", raw.updatedAt, { body: "new" }, "2026-06-01T10:00:00.000Z");

    pruneCache(cache, 7, new Date("2026-06-02T10:00:00.000Z"));

    expect(cache.searches["old-search"]).toBeUndefined();
    expect(cache.searches["new-search"]).toBeDefined();
    expect(cache.views["old-view"]).toBeUndefined();
    expect(cache.views["new-view"]).toBeDefined();
  });
});
