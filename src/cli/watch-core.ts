import { dirname } from "node:path";
import { fetchWatchItems, type GhJsonRunner } from "../fetch";
import { pruneCache, type GithubCache } from "../github-cache";
import { buildAgentReviewPrompt } from "../local-review";
import { reconcileItems, snapshotLifecycle } from "../state";
import type { AppState, Config, Snapshot, WatchItem } from "../types";
import { discoverWorkspaceRepos } from "../workspace";

export type AgentName = "codex" | "claude";

export interface RefreshInput {
  config: Config;
  state: AppState;
  cache: GithubCache;
  localRepos?: Map<string, string>;
  /** Used only when `localRepos` is absent, and only on a non-skipped refresh. */
  discoverRepos?: (config: Config) => Promise<Map<string, string>>;
  runner?: GhJsonRunner;
  nextRefreshAllowedAt?: number;
  previousItems?: WatchItem[];
  /** Carried onto a backoff-skipped snapshot so unrelated errors are not lost. */
  previousErrors?: string[];
  force?: boolean;
  now?: Date;
}

export interface RefreshOutput {
  state: AppState;
  cache: GithubCache;
  snapshot: Snapshot;
  nextRefreshAllowedAt: number;
  skippedForRateLimit: boolean;
}

export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  // Where the caller writes `prompt` (owner-only) before starting the agent.
  promptFile: string;
}

export type WatchAction = "launch_codex" | "launch_claude" | "acknowledge" | "open_url" | "back";

function isRateLimitError(message: string): boolean {
  return /rate limit exceeded|rate limit backoff/i.test(message);
}

export function visibleItems(items: WatchItem[], includeAcknowledged = false): WatchItem[] {
  return [...items]
    .filter((item) => includeAcknowledged || item.lifecycle !== "acknowledged")
    .sort((a, b) => {
      const rankDiff = kindRank(a.kind) - kindRank(b.kind);
      if (rankDiff !== 0) return rankDiff;
      const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (updatedDiff !== 0) return updatedDiff;
      return lifecycleRank(a.lifecycle) - lifecycleRank(b.lifecycle);
    });
}

export function actionsForItem(item: WatchItem): WatchAction[] {
  if (item.kind.startsWith("pr_")) {
    return ["open_url", "launch_codex", "launch_claude", "acknowledge", "back"];
  }
  return ["open_url", "acknowledge", "back"];
}

export function isDependabotPr(item: WatchItem): boolean {
  return item.kind.startsWith("pr_") && item.actor.toLowerCase().startsWith("dependabot");
}

export function actionLabel(action: WatchAction): string {
  switch (action) {
    case "launch_codex":
      return "Launch Codex review";
    case "launch_claude":
      return "Launch Claude review";
    case "acknowledge":
      return "Acknowledge";
    case "open_url":
      return "Open URL";
    case "back":
      return "Back";
  }
}

// The prompt names the repo, the PR, and its title, and every local account
// can read process arguments with `ps`, so the agent gets only the path of an
// owner-only file that holds the prompt. The caller puts that file in a
// private temporary directory of its own, which Claude gets with --add-dir so
// it can read the file without asking; the state directory, which holds the
// TLS key, stays out of reach.
export async function buildAgentLaunch(
  config: Config,
  item: WatchItem,
  agent: AgentName,
  promptFile: string,
): Promise<AgentLaunch> {
  if (!item.kind.startsWith("pr_")) {
    throw new Error("Local code review launch is only available for PR notifications.");
  }
  if (!item.localPath) {
    throw new Error(`No local checkout path was found for ${item.repo}.`);
  }

  const { prompt } = await buildAgentReviewPrompt(config, item);
  const instruction = `Read the review instructions in ${promptFile} and follow them.`;
  if (agent === "codex") {
    return { command: "codex", args: ["-C", item.localPath, instruction], cwd: process.cwd(), prompt, promptFile };
  }
  return {
    command: "claude",
    // --add-dir takes every argument after it, so the prompt comes first.
    args: [instruction, "--add-dir", dirname(promptFile)],
    cwd: item.localPath,
    prompt,
    promptFile,
  };
}

export async function refreshWatcherData(input: RefreshInput): Promise<RefreshOutput> {
  const now = input.now ?? new Date();
  const nextAllowed = input.nextRefreshAllowedAt ?? rateLimitUntil(input.cache);
  if (!input.force && nextAllowed > now.getTime()) {
    const nextRefreshIso = new Date(nextAllowed).toISOString();
    // Local time, not the ISO string: this message is rendered verbatim in the
    // dashboard's error list and read by a human sitting at the machine.
    const retryAt = new Date(nextAllowed).toLocaleTimeString();
    return {
      state: input.state,
      cache: input.cache,
      nextRefreshAllowedAt: nextAllowed,
      skippedForRateLimit: true,
      snapshot: {
        generatedAt: now.toISOString(),
        host: input.config.host,
        items: applyCurrentLifecycle(input.state, input.previousItems ?? [], now.toISOString()),
        // Keep errors unrelated to the backoff; replace only the previous
        // backoff notice so it does not accumulate on every skipped refresh.
        errors: [
          ...(input.previousErrors ?? []).filter((error) => !isRateLimitError(error)),
          `Rate limit backoff active. Next automatic refresh after ${retryAt}.`,
        ],
        cacheStatus: "rate_limited",
        lastSuccessfulFetchAt: input.cache.lastSuccessfulFetchAt,
        nextRefreshAllowedAt: nextRefreshIso,
      },
    };
  }

  const discover = input.discoverRepos ?? discoverWorkspaceRepos;
  const localRepos = input.localRepos ?? (await discover(input.config));
  const result = await fetchWatchItems(input.config, localRepos, input.cache, input.runner);
  let nextRefreshAllowedAt = 0;
  if (result.rateLimited || result.errors.some(isRateLimitError)) {
    nextRefreshAllowedAt = now.getTime() + input.config.rateLimitBackoffSeconds * 1000;
    input.cache.rateLimitUntil = new Date(nextRefreshAllowedAt).toISOString();
  } else {
    delete input.cache.rateLimitUntil;
  }

  pruneCache(input.cache, 7, now);
  // Only a clean fetch is trusted to say an item is gone; a partial one may be
  // missing items because a search failed, not because they closed. Leaving
  // this off silently erased acks on any degraded fetch.
  const items = reconcileItems(input.state, result.items, now.toISOString(), {
    dropMissing: result.cacheStatus === "fresh",
  });
  return {
    state: input.state,
    cache: input.cache,
    nextRefreshAllowedAt,
    skippedForRateLimit: false,
    snapshot: {
      generatedAt: now.toISOString(),
      host: input.config.host,
      items,
      errors: result.errors,
      cacheStatus: result.cacheStatus,
      lastSuccessfulFetchAt: result.lastSuccessfulFetchAt || input.cache.lastSuccessfulFetchAt,
      nextRefreshAllowedAt: input.cache.rateLimitUntil,
    },
  };
}

export function applyCurrentLifecycle(
  state: AppState,
  items: WatchItem[],
  now = new Date().toISOString(),
): WatchItem[] {
  return items.map((item) => ({ ...item, lifecycle: snapshotLifecycle(state, item, now) }));
}

function lifecycleRank(lifecycle: WatchItem["lifecycle"]): number {
  if (lifecycle === "new" || lifecycle === "unread") return 0;
  if (lifecycle === "active") return 1;
  return 2;
}

function kindRank(kind: WatchItem["kind"]): number {
  if (kind === "pr_review_request") return 0;
  if (kind === "pr_comment") return 1;
  if (kind === "issue_assigned") return 2;
  if (kind === "issue_mention") return 3;
  if (kind === "issue_comment") return 4;
  return 5;
}

function rateLimitUntil(cache: GithubCache): number {
  if (!cache.rateLimitUntil) return 0;
  const parsed = Date.parse(cache.rateLimitUntil);
  return Number.isFinite(parsed) ? parsed : 0;
}
