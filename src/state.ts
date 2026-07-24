import type { AppState, Lifecycle, StoredItem, WatchItem } from "./types";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function emptyState(): AppState {
  return {
    version: 1,
    items: {},
    mutedRepos: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function loadState(path: string): Promise<AppState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // No file yet (first run / fresh checkout) — start with empty intent.
    return emptyState();
  }

  try {
    return JSON.parse(raw) as AppState;
  } catch (error) {
    // The file exists but is not valid JSON. Never silently overwrite a user's
    // acks/mutes: move the bad file aside so it stays recoverable, and
    // only then start fresh. If we cannot move it, refuse rather than clobber.
    const detail = error instanceof Error ? error.message : String(error);
    const backup = `${path}.corrupt`;
    try {
      await rename(path, backup);
    } catch (renameError) {
      const renameDetail = renameError instanceof Error ? renameError.message : String(renameError);
      throw new Error(
        `State file ${path} is corrupt (${detail}) and could not be moved aside (${renameDetail}); ` +
          `refusing to overwrite it. Inspect or remove the file manually.`,
        { cause: renameError },
      );
    }
    console.error(
      `State file ${path} held invalid JSON (${detail}); moved it to ${backup} and started with empty local state.`,
    );
    return emptyState();
  }
}

export async function saveState(path: string, state: AppState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

// Parse to epoch millis before comparing. GitHub timestamps have no
// milliseconds ("...T12:00:00Z") while our own acknowledgedAt/lastKnownUpdatedAt
// come from Date.toISOString() with them ("...T12:00:00.500Z"). A lexicographic
// string compare misorders the same second ('Z' sorts after '.'), so an item
// updated in the same second it was acknowledged would wrongly read as active.
function toMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// `_now` is vestigial: lifecycle is decided purely by comparing the item's
// updatedAt against the stored record, so no wall-clock reading is needed. The
// parameter stays to keep snapshotLifecycle's signature stable for its callers.
function lifecycleFor(item: WatchItem, stored: StoredItem | undefined, _now: string): Lifecycle {
  if (!stored) return "new";
  if (stored.acknowledgedAt && toMillis(item.updatedAt) <= toMillis(stored.acknowledgedAt)) return "acknowledged";
  if (toMillis(item.updatedAt) > toMillis(stored.lastKnownUpdatedAt)) return "unread";
  return "active";
}

/**
 * The single source of truth for an item's lifecycle, given current persisted
 * state. Both the full refresh (`reconcileItems`) and the local-action fast
 * path (`applyLocalStateToSnapshot`) call this so they cannot drift apart.
 */
export function snapshotLifecycle(state: AppState, item: WatchItem, now = new Date().toISOString()): Lifecycle {
  if (state.mutedRepos.includes(item.repo)) return "muted";
  return lifecycleFor(item, state.items[item.id], now);
}

export interface ReconcileOptions {
  /**
   * When false, stored records for items missing from `fetched` are kept.
   * Pass false for partial/failed fetches: a search that errored with no
   * cached fallback returns [], and dropping state then would erase the
   * user's acks — items would later reappear as "new" and re-notify.
   */
  dropMissing?: boolean;
}

export function reconcileItems(
  state: AppState,
  fetched: WatchItem[],
  now = new Date().toISOString(),
  options: ReconcileOptions = {},
): WatchItem[] {
  const activeIds = new Set(fetched.map((item) => item.id));

  if (options.dropMissing !== false) {
    for (const id of Object.keys(state.items)) {
      if (!activeIds.has(id)) delete state.items[id];
    }
  }

  return fetched.map((item) => {
    // Compute lifecycle against the previous stored record before overwriting it.
    const lifecycle = snapshotLifecycle(state, item, now);
    const stored = state.items[item.id];
    const firstSeenAt = stored?.firstSeenAt || now;

    state.items[item.id] = {
      id: item.id,
      firstSeenAt,
      lastSeenAt: now,
      lastKnownUpdatedAt: item.updatedAt || now,
      acknowledgedAt: stored?.acknowledgedAt,
    };

    return {
      ...item,
      lifecycle,
      firstSeenAt,
      lastSeenAt: now,
    };
  });
}

export function acknowledge(state: AppState, ids: string[], at = new Date().toISOString()): void {
  for (const id of ids) {
    if (state.items[id]) state.items[id].acknowledgedAt = at;
  }
}

export function unacknowledge(state: AppState, ids: string[]): void {
  for (const id of ids) {
    if (state.items[id]) delete state.items[id].acknowledgedAt;
  }
}

export function muteRepo(state: AppState, repo: string): void {
  if (!state.mutedRepos.includes(repo)) state.mutedRepos.push(repo);
}

export function unmuteRepo(state: AppState, repo: string): void {
  state.mutedRepos = state.mutedRepos.filter((item) => item !== repo);
}
