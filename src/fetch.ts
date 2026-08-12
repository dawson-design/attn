import { summarize } from "./summary";
import { runGhJson } from "./gh";
import {
  getAnySearch,
  getAnyView,
  getFreshSearch,
  getFreshView,
  putSearch,
  putView,
  type GithubCache,
} from "./github-cache";
import type { Config, RawSearchItem, Snapshot, WatchItem } from "./types";

type GhComment = {
  id?: string;
  url?: string;
  body?: string;
  author?: { login?: string };
  createdAt?: string;
  updatedAt?: string;
};

type GhPrReview = {
  id?: string;
  url?: string;
  body?: string;
  state?: string;
  author?: { login?: string };
  submittedAt?: string;
};

type GhPrView = {
  body?: string;
  comments?: GhComment[];
  reviews?: GhPrReview[];
  headRefName?: string;
  baseRefName?: string;
};

type GhIssueView = {
  body?: string;
  comments?: GhComment[];
  labels?: Array<{ name: string }>;
};

const PR_SEARCH_FIELDS = "repository,title,url,author,updatedAt,createdAt,isDraft,labels,number,body";
const ISSUE_SEARCH_FIELDS = "repository,title,url,author,updatedAt,createdAt,labels,number,body";
const PR_VIEW_FIELDS = "body,comments,reviews,headRefName,baseRefName";
const ISSUE_VIEW_FIELDS = "body,comments,labels";
const PR_SEARCH_KEY = "search:prs:review-requested";
const ISSUE_ASSIGNED_SEARCH_KEY = "search:issues:assigned";
const ISSUE_MENTIONS_SEARCH_KEY = "search:issues:mentions";

export type GhJsonRunner = <T>(config: Config, args: string[]) => Promise<T>;

interface CacheState {
  usedCache: boolean;
  usedStale: boolean;
  rateLimited: boolean;
}

export interface FetchWatchItemsResult {
  items: WatchItem[];
  errors: string[];
  cacheStatus: Snapshot["cacheStatus"];
  lastSuccessfulFetchAt?: string;
  rateLimited: boolean;
}

function labelNames(item: { labels?: Array<{ name: string }> }): string[] {
  return (item.labels || []).map((label) => label.name).filter(Boolean);
}

function isRelevant(item: RawSearchItem, config: Config): boolean {
  // With no filters configured, every item the personal searches return
  // (review-requested / assigned / mentioned) is relevant.
  if (config.repos.length === 0 && config.labels.length === 0) return true;
  const { name, nameWithOwner } = item.repository;
  const labels = new Set(labelNames(item));
  // Exact match on the repo — either the bare name ("api") or the
  // fully-qualified "owner/repo" ("acme/api"). Exact (not
  // prefix) so a repo can be watched while a sibling under the same naming
  // family is excluded by simply omitting it.
  return (
    config.repos.some((repo) => repo === name || repo === nameWithOwner) ||
    config.labels.some((label) => labels.has(label))
  );
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit exceeded/i.test(message);
}

// Last `count` elements, or none when count is 0. Guards the slice(-0) trap:
// `arr.slice(-0)` is `arr.slice(0)`, i.e. the whole array, so a configured cap
// of 0 ("disable enrichment") would otherwise surface every comment/review.
function lastN<T>(values: T[], count: number): T[] {
  return count <= 0 ? [] : values.slice(-count);
}

function itemKey(kind: "pr" | "issue", raw: RawSearchItem): string {
  return `${kind}:${raw.repository.nameWithOwner}#${raw.number}`;
}

function baseItem(raw: RawSearchItem, kind: WatchItem["kind"], localPath?: string): WatchItem {
  const labels = labelNames(raw);
  const now = new Date().toISOString();
  return {
    id: `${raw.repository.nameWithOwner}#${raw.number}:${kind}`,
    kind,
    lifecycle: "new",
    repo: raw.repository.nameWithOwner,
    repoName: raw.repository.name,
    number: raw.number,
    title: raw.title,
    actor: raw.author?.login || "unknown",
    url: raw.url,
    createdAt: raw.createdAt || raw.updatedAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    firstSeenAt: now,
    lastSeenAt: now,
    isDraft: Boolean(raw.isDraft),
    labels,
    summary: raw.body || raw.title,
    localPath,
  };
}

function finalizePrItem(raw: RawSearchItem, view: GhPrView | undefined, localPath?: string): WatchItem {
  const item = baseItem(raw, "pr_review_request", localPath);
  item.summary = summarize({ title: raw.title, body: view?.body || raw.body });
  item.headBranch = view?.headRefName;
  item.baseBranch = view?.baseRefName;
  return item;
}

function commentItem(parent: WatchItem, comment: GhComment, kind: "pr_comment" | "issue_comment"): WatchItem {
  const created = comment.createdAt || parent.updatedAt;
  const updated = comment.updatedAt || created;
  const idPart = comment.id || comment.url || `${updated}:${comment.author?.login || "unknown"}`;
  return {
    ...parent,
    id: `${parent.repo}#${parent.number}:${kind}:${idPart}`,
    kind,
    lifecycle: "new",
    title: parent.title,
    actor: comment.author?.login || "unknown",
    url: comment.url || parent.url,
    createdAt: created,
    updatedAt: updated,
    summary: (comment.body || "New comment.").replace(/\s+/g, " ").slice(0, 260),
  };
}

// Review submissions worth surfacing even without a body; a bare COMMENTED
// review usually just accompanies inline comments and would be noise.
const REVIEW_STATES_SHOWN = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

function notableReviews(view: GhPrView | undefined): GhPrReview[] {
  return (view?.reviews || []).filter(
    (review) => (review.body || "").trim() || REVIEW_STATES_SHOWN.has(review.state || ""),
  );
}

// Comments and review submissions are one kind of row, so the cap has to apply
// to the merged set: capping each source separately would let a single PR
// produce twice `commentsPerIssue` rows and make "the latest N" a lie.
function prCommentItems(parent: WatchItem, view: GhPrView | undefined, cap: number): WatchItem[] {
  const merged = [
    ...(view?.comments || []).map((comment) => commentItem(parent, comment, "pr_comment")),
    ...notableReviews(view).map((review) => reviewItem(parent, review)),
  ];
  merged.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return lastN(merged, cap);
}

function reviewItem(parent: WatchItem, review: GhPrReview): WatchItem {
  const created = review.submittedAt || parent.updatedAt;
  // `review:` keeps a review id from ever colliding with a comment id now that
  // both kinds of row share the `pr_comment` id prefix. It sits inside the id
  // part so item-details' `endsWith(":<id>")` match still resolves.
  const idPart = `review:${review.id || review.url || `${created}:${review.author?.login || "unknown"}`}`;
  const stateLabel = (review.state || "commented").toLowerCase().replaceAll("_", " ");
  const body = (review.body || "").replace(/\s+/g, " ").trim();
  return {
    ...parent,
    id: `${parent.repo}#${parent.number}:pr_comment:${idPart}`,
    kind: "pr_comment",
    lifecycle: "new",
    actor: review.author?.login || "unknown",
    url: review.url || parent.url,
    createdAt: created,
    updatedAt: created,
    summary: `Review ${stateLabel}${body ? `: ${body}` : "."}`.slice(0, 260),
  };
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

interface CachedSearchArgs {
  config: Config;
  cache: GithubCache;
  key: string;
  ttlSeconds: number;
  args: string[];
  runner: GhJsonRunner;
  errors: string[];
  label: string;
  state: CacheState;
}

async function cachedSearch(o: CachedSearchArgs): Promise<RawSearchItem[]> {
  const cached = getFreshSearch(o.cache, o.key, o.ttlSeconds);
  if (cached) {
    o.state.usedCache = true;
    return cached;
  }

  try {
    const payload = await o.runner<RawSearchItem[]>(o.config, o.args);
    putSearch(o.cache, o.key, payload);
    return payload;
  } catch (error) {
    const stale = getAnySearch(o.cache, o.key);
    const message = `${o.label} failed: ${error instanceof Error ? error.message : String(error)}`;
    if (isRateLimitError(error)) {
      o.state.rateLimited = true;
      if (stale) {
        o.state.usedStale = true;
        o.errors.push(`${message}. Showing cached ${o.label.toLowerCase()} results.`);
        return stale;
      }
    }
    o.errors.push(message);
    return stale || [];
  }
}

interface CachedViewArgs {
  config: Config;
  cache: GithubCache;
  key: string;
  updatedAt: string | undefined;
  ttlSeconds: number;
  args: string[];
  runner: GhJsonRunner;
  errors: string[];
  label: string;
  state: CacheState;
}

async function cachedView<T>(o: CachedViewArgs): Promise<T | undefined> {
  const cached = getFreshView<T>(o.cache, o.key, o.updatedAt, o.ttlSeconds);
  if (cached) {
    o.state.usedCache = true;
    return cached;
  }

  try {
    const payload = await o.runner<T>(o.config, o.args);
    putView(o.cache, o.key, o.updatedAt, payload);
    return payload;
  } catch (error) {
    const stale = getAnyView<T>(o.cache, o.key);
    const message = `${o.label} failed: ${error instanceof Error ? error.message : String(error)}`;
    if (isRateLimitError(error)) {
      o.state.rateLimited = true;
      if (stale) {
        o.state.usedStale = true;
        o.errors.push(`${message}. Showing cached item details.`);
        return stale;
      }
    }
    // A non-rate-limit view failure must still be recorded. Left silent, the
    // fetch computes as "fresh" and reconcileItems(dropMissing) would erase the
    // acknowledged state of this item's comment/review rows, re-notifying them
    // on the next successful refresh. Surfacing the error forces cacheStatus to
    // "partial" so the caller keeps missing items instead of dropping them.
    o.errors.push(message);
    if (stale) o.state.usedStale = true;
    return stale;
  }
}

async function enrichPr(
  config: Config,
  cache: GithubCache,
  raw: RawSearchItem,
  runner: GhJsonRunner,
  errors: string[],
  state: CacheState,
): Promise<GhPrView | undefined> {
  return cachedView<GhPrView>({
    config,
    cache,
    key: itemKey("pr", raw),
    updatedAt: raw.updatedAt,
    ttlSeconds: config.prViewTtlSeconds,
    args: ["pr", "view", String(raw.number), "--repo", raw.repository.nameWithOwner, "--json", PR_VIEW_FIELDS],
    runner,
    errors,
    label: `PR view ${raw.repository.nameWithOwner}#${raw.number}`,
    state,
  });
}

async function enrichIssue(
  config: Config,
  cache: GithubCache,
  raw: RawSearchItem,
  runner: GhJsonRunner,
  errors: string[],
  state: CacheState,
): Promise<GhIssueView | undefined> {
  return cachedView<GhIssueView>({
    config,
    cache,
    key: itemKey("issue", raw),
    updatedAt: raw.updatedAt,
    ttlSeconds: config.issueViewTtlSeconds,
    args: ["issue", "view", String(raw.number), "--repo", raw.repository.nameWithOwner, "--json", ISSUE_VIEW_FIELDS],
    runner,
    errors,
    label: `Issue view ${raw.repository.nameWithOwner}#${raw.number}`,
    state,
  });
}

export async function fetchWatchItems(
  config: Config,
  localRepos: Map<string, string>,
  cache: GithubCache,
  runner: GhJsonRunner = runGhJson,
): Promise<FetchWatchItemsResult> {
  const errors: string[] = [];
  const items: WatchItem[] = [];
  const cacheState: CacheState = { usedCache: false, usedStale: false, rateLimited: false };

  const prs = await cachedSearch({
    config,
    cache,
    key: PR_SEARCH_KEY,
    ttlSeconds: config.prSearchTtlSeconds,
    args: [
      "search",
      "prs",
      "--review-requested",
      "@me",
      "--state",
      "open",
      "--sort",
      "updated",
      "--order",
      "desc",
      "--limit",
      String(config.limit),
      "--json",
      PR_SEARCH_FIELDS,
    ],
    runner,
    errors,
    label: "PR search",
    state: cacheState,
  });

  // View fetches are independent, so run a few gh processes at a time; a
  // serial loop makes a 50-PR refresh take minutes. Result order stays tied
  // to the search order.
  const relevantPrs = prs.filter((item) => isRelevant(item, config));
  const prViews = await mapWithConcurrency(relevantPrs, 4, (raw) =>
    enrichPr(config, cache, raw, runner, errors, cacheState),
  );
  relevantPrs.forEach((raw, index) => {
    const view = prViews[index];
    const parent = finalizePrItem(raw, view, localRepos.get(raw.repository.nameWithOwner));
    items.push(parent);
    // Cap like issues do: only the latest few comments become items, so a
    // long-running PR does not flood the dashboard with rows.
    items.push(...prCommentItems(parent, view, config.commentsPerIssue));
  });

  const issueQueries: Array<{ kind: "issue_assigned" | "issue_mention"; key: string; args: string[] }> = [
    { kind: "issue_assigned", key: ISSUE_ASSIGNED_SEARCH_KEY, args: ["--assignee", "@me"] },
    { kind: "issue_mention", key: ISSUE_MENTIONS_SEARCH_KEY, args: ["--mentions", "@me"] },
  ];

  const seenIssues = new Set<string>();
  let issueEnrichmentCount = 0;
  for (const query of issueQueries) {
    const issues = await cachedSearch({
      config,
      cache,
      key: query.key,
      ttlSeconds: config.issueSearchTtlSeconds,
      args: [
        "search",
        "issues",
        ...query.args,
        "--state",
        "open",
        "--sort",
        "updated",
        "--order",
        "desc",
        "--limit",
        String(config.issueLimit),
        "--json",
        ISSUE_SEARCH_FIELDS,
      ],
      runner,
      errors,
      label: "Issue search",
      state: cacheState,
    });

    for (const raw of issues.filter((item) => isRelevant(item, config))) {
      // Dedup across both issue queries so an issue that is both assigned and
      // mentions you shows once, under whichever query matched first.
      const dedupeKey = `${raw.repository.nameWithOwner}#${raw.number}`;
      if (seenIssues.has(dedupeKey)) continue;
      seenIssues.add(dedupeKey);
      const shouldEnrichComments = issueEnrichmentCount < config.issueCommentItemLimit;
      const view = shouldEnrichComments ? await enrichIssue(config, cache, raw, runner, errors, cacheState) : undefined;
      if (shouldEnrichComments) issueEnrichmentCount += 1;
      const parent = baseItem(raw, query.kind, localRepos.get(raw.repository.nameWithOwner));
      parent.labels = labelNames(view || raw);
      parent.summary = summarize({ title: raw.title, body: view?.body || raw.body });
      items.push(parent);
      for (const comment of lastN(view?.comments || [], config.commentsPerIssue)) {
        items.push(commentItem(parent, comment, "issue_comment"));
      }
    }
  }

  const cacheStatus = cacheState.rateLimited
    ? "rate_limited"
    : errors.length > 0
      ? "partial"
      : cacheState.usedStale
        ? "stale"
        : "fresh";
  if (!cacheState.rateLimited && errors.length === 0) {
    cache.lastSuccessfulFetchAt = new Date().toISOString();
  }

  return {
    items,
    errors,
    cacheStatus,
    lastSuccessfulFetchAt: cache.lastSuccessfulFetchAt,
    rateLimited: cacheState.rateLimited,
  };
}
