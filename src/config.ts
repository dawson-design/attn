import { homedir } from "node:os";
import type { Config } from "./types";
import { loadConfigFileEnv } from "./config-file";
import { parseAllowedHostsEnv } from "./host-guard";
import { resolveAppPaths } from "./paths";
import { loadReviewPromptTemplate } from "./review-prompt";

// All values are read from a single merged env map. Precedence, highest first:
// process env > installed-mode config file (~/.config/attn/env) > mode
// default. In dev mode Bun auto-loads `${cwd}/.env` into process.env before we
// run, so dev behavior is byte-identical to the historical cwd-relative setup;
// see paths.ts for the two modes.
type Env = Record<string, string | undefined>;

function stringFrom(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

function numberFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Like numberFrom but 0 is a valid value ("none"), e.g. to disable
// comment enrichment entirely.
function countFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function listFrom(env: Env, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapFrom(env: Env, name: string, fallback: Record<string, string>): Record<string, string> {
  const raw = env[name];
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
  const paths = resolveAppPaths(process.env, homedir(), process.cwd());
  const env: Env = { ...loadConfigFileEnv(paths.configFile), ...process.env };

  const workspace = stringFrom(env, "ATTN_WORKSPACE", paths.workspaceDefault);
  // Default to scanning the current workspace for local checkouts in dev mode.
  // Installed mode defaults to no scan at all — walking $HOME uninvited would
  // be slow and surprising — so `attn init` asks for roots explicitly.
  const checkoutRoots = listFrom(env, "ATTN_CHECKOUT_ROOTS", paths.mode === "dev" ? [workspace] : []);

  return {
    // Defaults to public GitHub (also `gh`'s default host). Point at a GitHub
    // Enterprise host with ATTN_HOST, e.g. `ghe.example.com`.
    host: stringFrom(env, "ATTN_HOST", "github.com"),
    workspace,
    checkoutRoots: Array.from(new Set(checkoutRoots)),
    repoPathMap: mapFrom(env, "ATTN_REPO_PATH_MAP", {}),
    port: numberFrom(env, "ATTN_PORT", 8765),
    pollSeconds: numberFrom(env, "ATTN_POLL_SECONDS", 900),
    stateFile: stringFrom(env, "ATTN_STATE_FILE", paths.stateFile),
    snapshotFile: stringFrom(env, "ATTN_SNAPSHOT_FILE", paths.snapshotFile),
    cacheFile: stringFrom(env, "ATTN_CACHE_FILE", paths.cacheFile),
    // Relevance filters. Left empty by default: every review-requested PR and
    // assigned/mentioned issue is shown. Narrow with ATTN_REPOS (exact
    // repo names, either "repo" or "owner/repo") and/or ATTN_LABELS.
    repos: listFrom(env, "ATTN_REPOS", []),
    labels: listFrom(env, "ATTN_LABELS", []),
    // Loaded once at startup; edit prompts/review.md in dev mode,
    // ~/.config/attn/review.md installed (or point
    // ATTN_REVIEW_PROMPT_FILE elsewhere) and restart to pick up changes.
    reviewPromptTemplate: loadReviewPromptTemplate(stringFrom(env, "ATTN_REVIEW_PROMPT_FILE", paths.reviewPromptFile)),
    terminalApp: env.ATTN_TERMINAL_APP?.trim() || undefined,
    // Extra Host-header names accepted by the DNS-rebinding guard
    // (hooks.server.ts); loopback is always allowed.
    allowedHosts: parseAllowedHostsEnv(env.ATTN_ALLOWED_HOSTS),
    limit: numberFrom(env, "ATTN_LIMIT", 50),
    issueLimit: numberFrom(env, "ATTN_ISSUE_LIMIT", 25),
    issueCommentItemLimit: countFrom(env, "ATTN_ISSUE_COMMENT_ITEM_LIMIT", 5),
    commentsPerIssue: countFrom(env, "ATTN_COMMENTS_PER_ISSUE", 3),
    // Search TTLs must stay below the poll interval (default 900s), or a poll
    // serves the previous search from cache and new PRs/issues surface a whole
    // extra interval late — defeating the timeliness this tool exists for. View
    // TTLs can be longer: views are keyed on the item's updatedAt, so changed
    // items re-fetch regardless of TTL.
    prSearchTtlSeconds: numberFrom(env, "ATTN_PR_SEARCH_TTL_SECONDS", 600),
    issueSearchTtlSeconds: numberFrom(env, "ATTN_ISSUE_SEARCH_TTL_SECONDS", 600),
    prViewTtlSeconds: numberFrom(env, "ATTN_PR_VIEW_TTL_SECONDS", 1800),
    issueViewTtlSeconds: numberFrom(env, "ATTN_ISSUE_VIEW_TTL_SECONDS", 3600),
    rateLimitBackoffSeconds: numberFrom(env, "ATTN_RATE_LIMIT_BACKOFF_SECONDS", 900),
  };
}
