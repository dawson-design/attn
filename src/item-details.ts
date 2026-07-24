import { runGhJson } from "./gh";
import { getAnyView, getFreshView, putView, type GithubCache } from "./github-cache";
import type { Config, WatchItem, WatchItemDetails } from "./types";

type GhDetailComment = {
  id?: string;
  author?: { login?: string };
  body?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
};

type GhDetailReview = {
  id?: string;
  author?: { login?: string };
  body?: string;
  state?: string;
  url?: string;
  submittedAt?: string;
};

type GhItemDetails = {
  body?: string;
  comments?: GhDetailComment[];
  reviews?: GhDetailReview[];
};

type NormalizedComment = {
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type ItemDetailsRunner = <T>(config: Config, args: string[]) => Promise<T>;

function detailsCacheKey(item: WatchItem): string {
  return `details:${item.id}`;
}

function detailsTtlSeconds(config: Config, item: WatchItem): number {
  return item.kind.startsWith("pr_") ? config.prViewTtlSeconds : config.issueViewTtlSeconds;
}

function detailsArgs(item: WatchItem): string[] {
  const isPr = item.kind.startsWith("pr_");
  const kind = isPr ? "pr" : "issue";
  // Review submissions live in the separate `reviews` field, not `comments`, so
  // a pr_review_comment item's detail can only be found when reviews are asked
  // for. `gh issue view` has no reviews field.
  const fields = isPr ? "body,comments,reviews" : "body,comments";
  return [kind, "view", String(item.number), "--repo", item.repo, "--json", fields];
}

// Matches a normalized comment/review to the focused item. The id fallbacks here
// mirror commentItem()/reviewItem() in fetch.ts, so the item's id ends with
// ":<that id>". An exact suffix match (not substring) avoids a short id
// colliding with, say, the issue number elsewhere in the item id.
function isFocused(item: WatchItem, entry: NormalizedComment): boolean {
  return entry.url === item.url || item.id.endsWith(`:${entry.id}`);
}

function normalizeDetails(
  item: WatchItem,
  payload: GhItemDetails,
  fetchedAt = new Date().toISOString(),
): WatchItemDetails {
  const comments: NormalizedComment[] = (payload.comments || []).map((comment) => {
    const updatedAt = comment.updatedAt || comment.createdAt || fetchedAt;
    return {
      id: String(comment.id || comment.url || `${updatedAt}:${comment.author?.login || "unknown"}`),
      author: comment.author?.login || "unknown",
      body: comment.body || "",
      url: comment.url || item.url,
      createdAt: comment.createdAt || updatedAt,
      updatedAt,
    };
  });
  const reviews: NormalizedComment[] = (payload.reviews || []).map((review) => {
    const submittedAt = review.submittedAt || fetchedAt;
    return {
      id: String(review.id || review.url || `${submittedAt}:${review.author?.login || "unknown"}`),
      author: review.author?.login || "unknown",
      body: review.body || "",
      url: review.url || item.url,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    };
  });

  let focusedComments: NormalizedComment[];
  if (item.kind === "pr_review_comment") {
    focusedComments = reviews.filter((review) => isFocused(item, review));
  } else if (item.kind.endsWith("_comment")) {
    focusedComments = comments.filter((comment) => isFocused(item, comment));
  } else {
    focusedComments = comments;
  }

  return {
    id: item.id,
    body: item.kind.endsWith("_comment") ? "" : payload.body || "",
    comments: focusedComments,
    fetchedAt,
  };
}

export async function fetchItemDetails(
  config: Config,
  item: WatchItem,
  cache: GithubCache,
  runner: ItemDetailsRunner = runGhJson,
): Promise<WatchItemDetails> {
  const cached = getFreshView<WatchItemDetails>(
    cache,
    detailsCacheKey(item),
    item.updatedAt,
    detailsTtlSeconds(config, item),
  );
  if (cached) return cached;

  try {
    const payload = await runner<GhItemDetails>(config, detailsArgs(item));
    const details = normalizeDetails(item, payload);
    putView(cache, detailsCacheKey(item), item.updatedAt, details);
    return details;
  } catch (error) {
    const stale = getAnyView<WatchItemDetails>(cache, detailsCacheKey(item));
    if (stale) return stale;
    throw error;
  }
}
