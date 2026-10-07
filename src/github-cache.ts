import { readFile } from "node:fs/promises";
import { writePrivateFile } from "./private-file";
import type { RawSearchItem } from "./types";

export interface GithubCacheEntry<T = unknown> {
  fetchedAt: string;
  updatedAt?: string;
  payload: T;
}

export interface GithubCache {
  version: 1;
  /**
   * The GitHub host these responses came from. Every payload is host-specific
   * (different repos, different URLs, different item ids), so a cache written
   * against one host must never be served for another.
   */
  host?: string;
  searches: Record<string, GithubCacheEntry<RawSearchItem[]>>;
  views: Record<string, GithubCacheEntry>;
  lastSuccessfulFetchAt?: string;
  rateLimitUntil?: string;
}

export function emptyGithubCache(host?: string): GithubCache {
  return {
    version: 1,
    host,
    searches: {},
    views: {},
  };
}

/**
 * Loads the cache for `host`, discarding one written against a different host.
 * Without that check, changing ATTN_HOST serves the previous host's
 * results as fresh data for the new one — wrong repos and wrong links, with no
 * error to show for it. A cache file predating this field has an unknown host
 * and is discarded once, costing a single refresh.
 */
export async function loadGithubCache(path: string, host?: string): Promise<GithubCache> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<GithubCache>;
    if (host !== undefined && parsed.host !== host) return emptyGithubCache(host);
    return {
      version: 1,
      host: parsed.host,
      searches: parsed.searches || {},
      views: parsed.views || {},
      lastSuccessfulFetchAt: parsed.lastSuccessfulFetchAt,
      rateLimitUntil: parsed.rateLimitUntil,
    };
  } catch {
    return emptyGithubCache(host);
  }
}

export async function saveGithubCache(path: string, cache: GithubCache): Promise<void> {
  await writePrivateFile(path, JSON.stringify(cache, null, 2) + "\n");
}

function isFresh(fetchedAt: string | undefined, ttlSeconds: number, now = new Date()): boolean {
  if (!fetchedAt) return false;
  const fetched = Date.parse(fetchedAt);
  if (!Number.isFinite(fetched)) return false;
  return now.getTime() - fetched <= ttlSeconds * 1000;
}

export function getFreshSearch(
  cache: GithubCache,
  key: string,
  ttlSeconds: number,
  now = new Date(),
): RawSearchItem[] | undefined {
  const entry = cache.searches[key];
  return entry && isFresh(entry.fetchedAt, ttlSeconds, now) ? entry.payload : undefined;
}

export function getAnySearch(cache: GithubCache, key: string): RawSearchItem[] | undefined {
  return cache.searches[key]?.payload;
}

export function putSearch(
  cache: GithubCache,
  key: string,
  payload: RawSearchItem[],
  fetchedAt = new Date().toISOString(),
): void {
  cache.searches[key] = { fetchedAt, payload };
}

export function getFreshView<T>(
  cache: GithubCache,
  key: string,
  updatedAt: string | undefined,
  ttlSeconds: number,
  now = new Date(),
): T | undefined {
  const entry = cache.views[key];
  if (!entry) return undefined;
  if (updatedAt && entry.updatedAt !== updatedAt) return undefined;
  return isFresh(entry.fetchedAt, ttlSeconds, now) ? (entry.payload as T) : undefined;
}

export function getAnyView<T>(cache: GithubCache, key: string): T | undefined {
  return cache.views[key]?.payload as T | undefined;
}

export function putView<T>(
  cache: GithubCache,
  key: string,
  updatedAt: string | undefined,
  payload: T,
  fetchedAt = new Date().toISOString(),
): void {
  cache.views[key] = { fetchedAt, updatedAt, payload };
}

export function pruneCache(cache: GithubCache, maxAgeDays = 7, now = new Date()): void {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [key, entry] of Object.entries(cache.searches)) {
    if (now.getTime() - Date.parse(entry.fetchedAt) > maxAgeMs) delete cache.searches[key];
  }
  for (const [key, entry] of Object.entries(cache.views)) {
    if (now.getTime() - Date.parse(entry.fetchedAt) > maxAgeMs) delete cache.views[key];
  }
}
