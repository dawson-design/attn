import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { refreshWatcherData } from "../../cli/watch-core";
import { loadConfig } from "../../config";
import type { GhJsonRunner } from "../../fetch";
import { loadGithubCache, saveGithubCache } from "../../github-cache";
import { fetchItemDetails } from "../../item-details";
import { buildAgentReviewPrompt } from "../../local-review";
import { loadSnapshot, saveSnapshot } from "../../snapshot-cache";
import { buildReviewTerminalScript, terminalScriptFileName } from "../../terminal-launch";
import { acknowledge, loadState, saveState, snapshotLifecycle, unacknowledge } from "../../state";
import type { AppState, Config, Snapshot, WatchItemDetails } from "../../types";
import { discoverWorkspaceRepos } from "../../workspace";

type Client = ReadableStreamDefaultController<string>;
const SERVICE_VERSION = 14;

/**
 * Seams for tests. Production passes nothing and gets the real wiring: local
 * config, `gh` subprocesses, workspace scanning, `open`, and the poll timer.
 * Tests inject fakes so the service can be driven without touching the network
 * or spawning anything. Persistence is deliberately NOT injectable — tests
 * point the config's three file paths at a temp dir so the real save/load
 * paths are exercised.
 */
export interface ServiceDeps {
  config?: Config;
  runner?: GhJsonRunner;
  discoverRepos?: (config: Config) => Promise<Map<string, string>>;
  launchTerminal?: (scriptPath: string, terminalApp?: string) => Promise<void>;
  platform?: NodeJS.Platform;
  /** Default true. False skips the poll timer and the startup refresh. */
  startPolling?: boolean;
}

// GHE_WATCH_TERMINAL_APP picks the terminal (Terminal / iTerm / Ghostty /
// ...). It is passed as a literal arg to `open -a`, never shell-interpreted.
// Unset falls back to the system default handler for .command files.
function openWithSystem(scriptPath: string, terminalApp?: string): Promise<void> {
  const openArgs = terminalApp ? ["-a", terminalApp, scriptPath] : [scriptPath];
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("open", openArgs, { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open exited with code ${code}; could not launch ${terminalApp ?? "the terminal"}.`));
    });
  });
}

interface DashboardService {
  serviceVersion: number;
  getSnapshot(): Snapshot;
  refresh(options?: { force?: boolean }): Promise<Snapshot>;
  addClient(client: Client): void;
  removeClient(client: Client): void;
  acknowledge(ids: string[], acknowledged: boolean): Promise<void>;
  getItemDetails(id: string): Promise<{ ok: true; details: WatchItemDetails }>;
  buildAgentReviewPrompt(id: string): Promise<{ ok: true; prompt: string }>;
  openReviewTerminal(id: string): Promise<{ ok: true }>;
  dispose(): void;
}

declare global {
  var gheNotificationWatchService: Promise<DashboardService> | undefined;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function createService(deps: ServiceDeps = {}): Promise<DashboardService> {
  const config = deps.config ?? loadConfig();
  const discoverRepos = deps.discoverRepos ?? discoverWorkspaceRepos;
  const launchTerminal = deps.launchTerminal ?? openWithSystem;
  const platform = deps.platform ?? process.platform;
  const state: AppState = await loadState(config.stateFile);
  const githubCache = await loadGithubCache(config.cacheFile, config.host);
  const loadedSnapshot = await loadSnapshot(config.snapshotFile);
  let snapshot: Snapshot = loadedSnapshot
    ? {
        ...loadedSnapshot,
        cacheStatus: loadedSnapshot.cacheStatus || "stale",
        lastSuccessfulFetchAt: loadedSnapshot.lastSuccessfulFetchAt || githubCache.lastSuccessfulFetchAt,
        nextRefreshAllowedAt: loadedSnapshot.nextRefreshAllowedAt || githubCache.rateLimitUntil,
      }
    : {
        generatedAt: new Date().toISOString(),
        host: config.host,
        items: [],
        errors: [],
        cacheStatus: "stale",
        lastSuccessfulFetchAt: githubCache.lastSuccessfulFetchAt,
        nextRefreshAllowedAt: githubCache.rateLimitUntil,
      };

  const clients = new Set<Client>();
  let nextRefreshAllowedAt = githubCache.rateLimitUntil ? Date.parse(githubCache.rateLimitUntil) : 0;
  let refreshInFlight: Promise<Snapshot> | undefined;

  function broadcast(event = "snapshot"): void {
    const payload = sse(event, snapshot);
    for (const client of clients) {
      try {
        client.enqueue(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  async function applyLocalStateToSnapshot(): Promise<void> {
    const now = new Date().toISOString();
    snapshot = {
      ...snapshot,
      generatedAt: now,
      items: snapshot.items.map((item) => ({ ...item, lifecycle: snapshotLifecycle(state, item, now) })),
    };
    await saveSnapshot(config.snapshotFile, snapshot);
    broadcast();
  }

  // The fetch pipeline, the rate-limit backoff, and the reconcile rules live in
  // refreshWatcherData (cli/watch-core.ts) and are shared with the terminal
  // watcher. What is genuinely the service's own job stays here: persistence,
  // in-flight coalescing, and the SSE broadcast.
  async function runRefresh(options: { force?: boolean }): Promise<Snapshot> {
    const result = await refreshWatcherData({
      config,
      state,
      cache: githubCache,
      discoverRepos,
      runner: deps.runner,
      nextRefreshAllowedAt,
      previousItems: snapshot.items,
      previousErrors: snapshot.errors,
      force: options.force,
    });

    nextRefreshAllowedAt = result.nextRefreshAllowedAt;
    snapshot = result.snapshot;

    // A skipped refresh fetched nothing and reconciled nothing, so there is no
    // new state to write; it only needs to reach the browser.
    if (!result.skippedForRateLimit) {
      await saveGithubCache(config.cacheFile, githubCache);
      await saveState(config.stateFile, state);
      await saveSnapshot(config.snapshotFile, snapshot);
    }

    broadcast();
    return snapshot;
  }

  async function refresh(options: { force?: boolean } = {}): Promise<Snapshot> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = runRefresh(options).finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  }

  // Failures ride the normal snapshot event (Snapshot.errors); an SSE event
  // literally named "error" is indistinguishable from EventSource's own
  // connection-error event on the client, so the payload would never render.
  function refreshLoggingFailure(): void {
    refresh().catch((error) => {
      snapshot = { ...snapshot, generatedAt: new Date().toISOString(), errors: [String(error)] };
      broadcast();
    });
  }

  let interval: ReturnType<typeof setInterval> | undefined;
  if (deps.startPolling !== false) {
    interval = setInterval(refreshLoggingFailure, config.pollSeconds * 1000);
    interval.unref?.();

    setTimeout(refreshLoggingFailure, 0).unref?.();
  }

  return {
    serviceVersion: SERVICE_VERSION,
    getSnapshot: () => snapshot,
    refresh,
    addClient: (client) => {
      clients.add(client);
      client.enqueue(sse("snapshot", snapshot));
    },
    removeClient: (client) => {
      clients.delete(client);
    },
    acknowledge: async (ids, acknowledged) => {
      if (acknowledged) acknowledge(state, ids);
      else unacknowledge(state, ids);
      await saveState(config.stateFile, state);
      await applyLocalStateToSnapshot();
    },
    getItemDetails: async (id) => {
      const item = snapshot.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error("Notification item was not found in the current snapshot.");
      const details = await fetchItemDetails(config, item, githubCache, deps.runner);
      await saveGithubCache(config.cacheFile, githubCache);
      return { ok: true, details };
    },
    buildAgentReviewPrompt: async (id) => {
      const item = snapshot.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error("Notification item was not found in the current snapshot.");
      if (item.localPath) return buildAgentReviewPrompt(config, item);

      const localRepos = await discoverRepos(config);
      return buildAgentReviewPrompt(config, { ...item, localPath: localRepos.get(item.repo) });
    },
    openReviewTerminal: async (id) => {
      // The launcher writes a macOS .command (zsh) script and opens it with
      // `open`; neither exists elsewhere. Fail clearly rather than with a raw
      // ENOENT from spawn on Linux/Windows. (Everything else in the dashboard
      // is cross-platform — only this convenience action is macOS-only.)
      if (platform !== "darwin") {
        throw new Error("Opening a review terminal is only supported on macOS. Use the agent review prompt instead.");
      }
      const item = snapshot.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error("Notification item was not found in the current snapshot.");
      const withPath = item.localPath
        ? item
        : { ...item, localPath: (await discoverWorkspaceRepos(config)).get(item.repo) };

      // The script content is a fixed template (terminal-launch.ts); author-
      // controlled refs are validated there. A .command file opened via
      // `open` runs in a new terminal window in the user's GUI session.
      const script = buildReviewTerminalScript(withPath);
      const dir = `${dirname(config.stateFile)}/terminal`;
      await mkdir(dir, { recursive: true });
      const path = `${dir}/${terminalScriptFileName(withPath)}`;
      await writeFile(path, script, { mode: 0o700 });
      await chmod(path, 0o700); // writeFile's mode is ignored when the file already exists
      await launchTerminal(path, config.terminalApp);
      return { ok: true };
    },
    dispose: () => {
      if (interval) clearInterval(interval);
    },
  };
}

export function getDashboardService(): Promise<DashboardService> {
  globalThis.gheNotificationWatchService ??= createService();
  globalThis.gheNotificationWatchService = globalThis.gheNotificationWatchService.then((service) => {
    if (
      service.serviceVersion === SERVICE_VERSION &&
      typeof service.buildAgentReviewPrompt === "function" &&
      typeof service.getItemDetails === "function"
    ) {
      return service;
    }
    service.dispose?.();
    return createService();
  });
  return globalThis.gheNotificationWatchService;
}
