// Review submissions are `pr_comment` too: they differ only in where `gh` keeps
// them, and the verdict they carry survives in the item summary.
export type ItemKind = "pr_review_request" | "pr_comment" | "issue_assigned" | "issue_mention" | "issue_comment";

export type Lifecycle = "new" | "unread" | "active" | "acknowledged";

export interface Config {
  host: string;
  workspace: string;
  checkoutRoots: string[];
  repoPathMap: Record<string, string>;
  port: number;
  pollSeconds: number;
  stateFile: string;
  snapshotFile: string;
  cacheFile: string;
  repos: string[];
  labels: string[];
  // Local code-review prompt template (loaded from prompts/review.md at startup;
  // see review-prompt.ts). Optional in the type for test ergonomics — loadConfig
  // always populates it, and local-review.ts falls back to the built-in default.
  reviewPromptTemplate?: string;
  // macOS app to open the review terminal in (e.g. "Terminal", "iTerm",
  // "Ghostty"). Unset uses the system default handler for .command files.
  terminalApp?: string;
  // Extra Host-header names accepted by the DNS-rebinding guard, beyond
  // loopback (ATTN_ALLOWED_HOSTS). Optional for test ergonomics —
  // loadConfig always populates it, and hooks.server.ts treats unset as [].
  allowedHosts?: string[];
  limit: number;
  issueLimit: number;
  issueCommentItemLimit: number;
  commentsPerIssue: number;
  prSearchTtlSeconds: number;
  issueSearchTtlSeconds: number;
  prViewTtlSeconds: number;
  issueViewTtlSeconds: number;
  rateLimitBackoffSeconds: number;
}

export interface RawSearchItem {
  repository: { name: string; nameWithOwner: string };
  number: number;
  title: string;
  url: string;
  author?: { login?: string };
  updatedAt?: string;
  createdAt?: string;
  isDraft?: boolean;
  labels?: Array<{ name: string }>;
  body?: string;
}

export interface WatchItem {
  id: string;
  kind: ItemKind;
  lifecycle: Lifecycle;
  repo: string;
  repoName: string;
  number: number;
  title: string;
  actor: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  isDraft: boolean;
  labels: string[];
  summary: string;
  headBranch?: string;
  baseBranch?: string;
  localPath?: string;
}

export interface WatchItemDetailComment {
  id: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchItemDetails {
  id: string;
  body: string;
  comments: WatchItemDetailComment[];
  fetchedAt: string;
}

export interface StoredItem {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastKnownUpdatedAt: string;
  acknowledgedAt?: string;
}

export interface AppState {
  version: 1;
  items: Record<string, StoredItem>;
  updatedAt: string;
}

export interface Snapshot {
  generatedAt: string;
  host: string;
  items: WatchItem[];
  errors: string[];
  cacheStatus: "fresh" | "partial" | "stale" | "rate_limited";
  lastSuccessfulFetchAt?: string;
  nextRefreshAllowedAt?: string;
}
