import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { discoverWorkspaceRepos } from "../src/workspace";
import type { Config } from "../src/types";

function config(roots: string[], repoPathMap: Record<string, string> = {}, host = "ghe.example.com"): Config {
  return {
    host,
    workspace: roots[0] || "/tmp",
    checkoutRoots: roots,
    repoPathMap,
    port: 8765,
    pollSeconds: 900,
    stateFile: "/tmp/state.json",
    snapshotFile: "/tmp/snapshot.json",
    cacheFile: "/tmp/github-cache.json",
    repos: ["docs"],
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

function git(path: string, args: string[]): void {
  const result = spawnSync("git", ["-C", path, ...args], { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe("workspace discovery", () => {
  test("maps repos from configured checkout roots", async () => {
    const root = await mkdtemp(`${tmpdir()}/ghe-workspace-`);
    const repoPath = `${root}/docs`;
    try {
      await mkdir(repoPath);
      git(repoPath, ["init"]);
      git(repoPath, ["remote", "add", "origin", "git@ghe.example.com:acme/docs.git"]);

      const repos = await discoverWorkspaceRepos(config(["/missing/root", root]));

      expect(repos.get("acme/docs")).toBe(repoPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("discovers repos on any configured host, org, and dotted repo name", async () => {
    const root = await mkdtemp(`${tmpdir()}/ghe-workspace-`);
    const repoPath = `${root}/docs.wiki`;
    try {
      await mkdir(repoPath);
      git(repoPath, ["init"]);
      git(repoPath, ["remote", "add", "origin", "https://ghe.example.com/acme/docs.wiki.git"]);

      const repos = await discoverWorkspaceRepos(config([root], {}, "ghe.example.com"));

      expect(repos.get("acme/docs.wiki")).toBe(repoPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores remotes that do not match the configured host", async () => {
    const root = await mkdtemp(`${tmpdir()}/ghe-workspace-`);
    const repoPath = `${root}/other`;
    try {
      await mkdir(repoPath);
      git(repoPath, ["init"]);
      git(repoPath, ["remote", "add", "origin", "git@github.com:acme/other.git"]);

      const repos = await discoverWorkspaceRepos(config([root], {}, "ghe.example.com"));

      expect(repos.has("acme/other")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a lookalike host that merely contains the configured host", async () => {
    const root = await mkdtemp(`${tmpdir()}/ghe-workspace-`);
    const repoPath = `${root}/api`;
    try {
      await mkdir(repoPath);
      git(repoPath, ["init"]);
      // Substring-matching "ghe.example.com" would wrongly accept this remote and
      // map the attacker's checkout as the real acme/api.
      git(repoPath, ["remote", "add", "origin", "https://ghe.example.com.attacker.net/acme/api.git"]);

      const repos = await discoverWorkspaceRepos(config([root], {}, "ghe.example.com"));

      expect(repos.has("acme/api")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses configured repo path map before scanned roots", async () => {
    const repos = await discoverWorkspaceRepos(
      config(["/missing/root"], {
        "acme/worker": "/Users/dev/work/acme/worker",
      }),
    );

    expect(repos.get("acme/worker")).toBe("/Users/dev/work/acme/worker");
  });
});
