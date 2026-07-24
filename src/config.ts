import type { Config } from "./types";
import { loadReviewPromptTemplate } from "./review-prompt";

function stringFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Like numberFromEnv but 0 is a valid value ("none"), e.g. to disable
// comment enrichment entirely.
function countFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapFromEnv(name: string, fallback: Record<string, string>): Record<string, string> {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([repo, path]) => [repo.trim(), path.trim()])
        .filter(([repo, path]) => repo && path),
    );
  } catch {
    return fallback;
  }
}

export function loadConfig(): Config {
  const workspace = process.env.GHE_WATCH_WORKSPACE || process.cwd();
  // Default to scanning the current workspace for local checkouts; deployments
  // with clones elsewhere point GHE_WATCH_CHECKOUT_ROOTS at them.
  const checkoutRoots = listFromEnv("GHE_WATCH_CHECKOUT_ROOTS", [workspace]);

  return {
    // Defaults to public GitHub (also `gh`'s default host). Point at a GitHub
    // Enterprise host with GHE_WATCH_HOST, e.g. `ghe.example.com`.
    host: stringFromEnv("GHE_WATCH_HOST", "github.com"),
    workspace,
    checkoutRoots: Array.from(new Set(checkoutRoots)),
    repoPathMap: mapFromEnv("GHE_WATCH_REPO_PATH_MAP", {}),
    port: numberFromEnv("GHE_WATCH_PORT", 8765),
    pollSeconds: numberFromEnv("GHE_WATCH_POLL_SECONDS", 900),
    stateFile: process.env.GHE_WATCH_STATE_FILE || `${process.cwd()}/.local-state/ghe-notification-watch/state.json`,
    snapshotFile:
      process.env.GHE_WATCH_SNAPSHOT_FILE || `${process.cwd()}/.local-state/ghe-notification-watch/snapshot.json`,
    cacheFile:
      process.env.GHE_WATCH_CACHE_FILE || `${process.cwd()}/.local-state/ghe-notification-watch/github-cache.json`,
    // Relevance filters. Left empty by default: every review-requested PR and
    // assigned/mentioned issue is shown. Narrow with GHE_WATCH_REPOS (exact
    // repo names, either "repo" or "owner/repo") and/or GHE_WATCH_LABELS.
    repos: listFromEnv("GHE_WATCH_REPOS", []),
    labels: listFromEnv("GHE_WATCH_LABELS", []),
    // Loaded once at startup; edit prompts/review.md (or point
    // GHE_WATCH_REVIEW_PROMPT_FILE elsewhere) and restart to pick up changes.
    reviewPromptTemplate: loadReviewPromptTemplate(
      process.env.GHE_WATCH_REVIEW_PROMPT_FILE || `${process.cwd()}/prompts/review.md`,
    ),
    terminalApp: process.env.GHE_WATCH_TERMINAL_APP?.trim() || undefined,
    limit: numberFromEnv("GHE_WATCH_LIMIT", 50),
    issueLimit: numberFromEnv("GHE_WATCH_ISSUE_LIMIT", 25),
    issueCommentItemLimit: countFromEnv("GHE_WATCH_ISSUE_COMMENT_ITEM_LIMIT", 5),
    commentsPerIssue: countFromEnv("GHE_WATCH_COMMENTS_PER_ISSUE", 3),
    // Search TTLs must stay below the poll interval (default 900s), or a poll
    // serves the previous search from cache and new PRs/issues surface a whole
    // extra interval late — defeating the timeliness this tool exists for. View
    // TTLs can be longer: views are keyed on the item's updatedAt, so changed
    // items re-fetch regardless of TTL.
    prSearchTtlSeconds: numberFromEnv("GHE_WATCH_PR_SEARCH_TTL_SECONDS", 600),
    issueSearchTtlSeconds: numberFromEnv("GHE_WATCH_ISSUE_SEARCH_TTL_SECONDS", 600),
    prViewTtlSeconds: numberFromEnv("GHE_WATCH_PR_VIEW_TTL_SECONDS", 1800),
    issueViewTtlSeconds: numberFromEnv("GHE_WATCH_ISSUE_VIEW_TTL_SECONDS", 3600),
    rateLimitBackoffSeconds: numberFromEnv("GHE_WATCH_RATE_LIMIT_BACKOFF_SECONDS", 900),
  };
}
