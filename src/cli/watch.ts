#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { loadGithubCache, saveGithubCache, type GithubCache } from "../github-cache";
import { fetchItemDetails } from "../item-details";
import { loadSnapshot, saveSnapshot } from "../snapshot-cache";
import { acknowledge, loadState, saveState } from "../state";
import type { AppState, Config, Snapshot, WatchItem, WatchItemDetails } from "../types";
import {
  actionLabel,
  actionsForItem,
  applyCurrentLifecycle,
  buildAgentLaunch,
  isDependabotPr,
  refreshWatcherData,
  visibleItems,
  type AgentName,
  type WatchAction,
} from "./watch-core";

interface CliOptions {
  agent?: AgentName;
  pollSeconds?: number;
  includeAcknowledged: boolean;
}

type Mode =
  | { name: "list" }
  | { name: "actions"; item: WatchItem; selectedAction: number; details?: WatchItemDetails; error?: string }
  | { name: "message"; title: string; body: string[]; returnTo?: Mode };

const HELP = "up/down select  enter actions  r refresh  a ack  o open url  q quit";
// The escape character is the point here: this strips ANSI colour codes when
// measuring the printable width of a TUI line.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

let config: Config;
let state: AppState;
let cache: GithubCache;
let snapshot: Snapshot;
let selectedIndex = 0;
let mode: Mode = { name: "list" };
let status = "Starting watcher.";
let nextRefreshAllowedAt = 0;
let refreshInFlight: Promise<void> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let restoringTerminal = false;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loadedConfig = loadConfig();
  config = { ...loadedConfig, pollSeconds: options.pollSeconds ?? loadedConfig.pollSeconds };
  state = await loadState(config.stateFile);
  cache = await loadGithubCache(config.cacheFile, config.host);
  snapshot = (await loadSnapshot(config.snapshotFile)) ?? emptySnapshot(config);
  snapshot = { ...snapshot, items: applyCurrentLifecycle(state, snapshot.items) };

  setupTerminal();
  render(options);
  await refresh(options, { force: true });
  pollTimer = setInterval(() => {
    void refresh(options);
  }, config.pollSeconds * 1000);
  pollTimer.unref?.();
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { includeAcknowledged: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--include-acknowledged") {
      options.includeAcknowledged = true;
      continue;
    }
    if (arg === "--agent") {
      const value = args[index + 1];
      if (value !== "codex" && value !== "claude") throw new Error("--agent must be codex or claude");
      options.agent = value;
      index += 1;
      continue;
    }
    if (arg === "--poll-seconds") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value < 5) throw new Error("--poll-seconds must be an integer >= 5");
      options.pollSeconds = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function refresh(options: CliOptions, refreshOptions: { force?: boolean } = {}): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  status = "Refreshing.";
  render(options);
  refreshInFlight = (async () => {
    try {
      const result = await refreshWatcherData({
        config,
        state,
        cache,
        previousItems: snapshot.items,
        nextRefreshAllowedAt,
        force: refreshOptions.force,
      });
      state = result.state;
      cache = result.cache;
      snapshot = result.snapshot;
      nextRefreshAllowedAt = result.nextRefreshAllowedAt;
      await saveGithubCache(config.cacheFile, cache);
      await saveState(config.stateFile, state);
      await saveSnapshot(config.snapshotFile, snapshot);
      clampSelection(options);
      status = result.skippedForRateLimit
        ? "Rate limit backoff active."
        : `Last refresh ${formatDate(snapshot.generatedAt)}.`;
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    } finally {
      refreshInFlight = undefined;
      render(options);
    }
  })();
  return refreshInFlight;
}

function setupTerminal(): void {
  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", inputHandler);
  process.on("SIGINT", shutdown);
  process.on("exit", restoreTerminal);
  process.stdout.write("\x1b[?25l");
}

let currentOptions: CliOptions = { includeAcknowledged: false };

function inputHandler(data: Buffer | string): void {
  void handleInput(String(data), currentOptions);
}

async function handleInput(data: string, options: CliOptions): Promise<void> {
  if (data === "\u0003" || data === "q") return shutdown();
  if (mode.name === "message") {
    mode = mode.returnTo ?? { name: "list" };
    render(options);
    return;
  }

  if (mode.name === "actions") {
    await handleActionInput(data, options, mode);
    return;
  }

  if (isUp(data)) selectedIndex = Math.max(0, selectedIndex - 1);
  else if (isDown(data)) selectedIndex = Math.min(currentItems(options).length - 1, selectedIndex + 1);
  else if (data === "r") await refresh(options, { force: true });
  else if (data === "a") await acknowledgeSelected(options);
  else if (data === "o") openSelected(options);
  else if (isEnter(data)) await openActions(options);
  render(options);
}

async function handleActionInput(
  data: string,
  options: CliOptions,
  actionMode: Extract<Mode, { name: "actions" }>,
): Promise<void> {
  if (data === "\u001b") {
    mode = { name: "list" };
    render(options);
    return;
  }
  const item = actionMode.item;
  const actions = actionsForItem(item);
  if (isUp(data)) mode = { ...actionMode, selectedAction: Math.max(0, actionMode.selectedAction - 1) };
  else if (isDown(data))
    mode = { ...actionMode, selectedAction: Math.min(actions.length - 1, actionMode.selectedAction + 1) };
  else if (isEnter(data)) await runAction(actions[actionMode.selectedAction], item, options);
  render(options);
}

async function openActions(options: CliOptions): Promise<void> {
  const item = currentItems(options)[selectedIndex];
  if (!item) return;
  let details: WatchItemDetails | undefined;
  let error: string | undefined;
  try {
    details = await fetchItemDetails(config, item, cache);
    await saveGithubCache(config.cacheFile, cache);
  } catch (detailError) {
    error = detailError instanceof Error ? detailError.message : String(detailError);
  }
  const actions = actionsForItem(item);
  const selectedAction =
    options.agent && item.kind.startsWith("pr_")
      ? actions.findIndex((action) => action === `launch_${options.agent}`)
      : 0;
  mode = { name: "actions", item, selectedAction: Math.max(0, selectedAction), details, error };
}

async function runAction(action: WatchAction, item: WatchItem, options: CliOptions): Promise<void> {
  if (action === "back") {
    mode = { name: "list" };
    return;
  }
  if (action === "acknowledge") {
    await acknowledgeItems([item.id], options);
    mode = { name: "list" };
    return;
  }
  if (action === "open_url") {
    openUrl(item.url);
    return;
  }
  if (action === "launch_codex" || action === "launch_claude") {
    await launchAgent(item, action === "launch_codex" ? "codex" : "claude", options);
  }
}

async function acknowledgeSelected(options: CliOptions): Promise<void> {
  const item = currentItems(options)[selectedIndex];
  if (!item) return;
  await acknowledgeItems([item.id], options);
}

async function acknowledgeItems(ids: string[], options: CliOptions): Promise<void> {
  acknowledge(state, ids);
  await saveState(config.stateFile, state);
  snapshot = { ...snapshot, items: applyCurrentLifecycle(state, snapshot.items) };
  await saveSnapshot(config.snapshotFile, snapshot);
  clampSelection(options);
  status = "Acknowledged selected item.";
}

function openSelected(options: CliOptions): void {
  const item = currentItems(options)[selectedIndex];
  if (item) openUrl(item.url);
}

function openUrl(url: string): void {
  // url comes from GitHub JSON (and the on-disk snapshot). Only hand a real
  // http(s) URL to the opener: it guards against a non-web scheme and against
  // Windows `cmd /c start` argument injection via `&`/`^` in a crafted value.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    status = `Refused to open a malformed URL: ${url}`;
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    status = `Refused to open a non-web URL: ${url}`;
    return;
  }
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    status = `URL: ${url}`;
  });
  child.unref?.();
  status = `Opened ${url}`;
}

async function launchAgent(item: WatchItem, agent: AgentName, options: CliOptions): Promise<void> {
  let suspended = false;
  try {
    const launch = await buildAgentLaunch(config, item, agent);
    suspendTerminal();
    suspended = true;
    console.log(`\nLaunching ${agent} in ${launch.cwd}\n`);
    await new Promise<void>((resolve) => {
      const child = spawn(launch.command, launch.args, { cwd: launch.cwd, stdio: "inherit" });
      child.on("error", (error) => {
        console.error(error.message);
        resolve();
      });
      child.on("close", () => resolve());
    });
    resumeTerminal();
    status = `${agent} exited.`;
    mode = { name: "list" };
    render(options);
  } catch (error) {
    if (suspended) resumeTerminal();
    mode = {
      name: "message",
      title: "Launch failed",
      body: [error instanceof Error ? error.message : String(error)],
      returnTo: mode,
    };
  }
}

function currentItems(options: CliOptions): WatchItem[] {
  return visibleItems(snapshot.items, options.includeAcknowledged);
}

function clampSelection(options: CliOptions): void {
  selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, currentItems(options).length - 1));
}

function render(options: CliOptions): void {
  currentOptions = options;
  if (restoringTerminal) return;
  process.stdout.write("\x1b[2J\x1b[H");
  if (mode.name === "message") {
    renderMessage(mode);
    return;
  }
  if (mode.name === "actions") {
    renderActions(mode);
    return;
  }
  renderList(options);
}

function renderList(options: CliOptions): void {
  const items = currentItems(options);
  const rows = process.stdout.rows || 30;
  const width = process.stdout.columns || 100;
  const maxItems = Math.max(5, rows - 7);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxItems / 2), Math.max(0, items.length - maxItems)));

  writeLine(color("bold", "attn"));
  writeLine(
    `${color("dim", snapshot.host)} | ${items.length} visible / ${snapshot.items.length} tracked | ${cacheStatusLabel(snapshot.cacheStatus)} | ${status}`,
  );
  if (snapshot.errors.length) writeLine(`${color("red", "Warnings:")} ${snapshot.errors.join(" | ")}`, width);
  writeLine(color("dim", HELP));
  writeLine("");

  if (!items.length) {
    writeLine("No matching active items.");
    return;
  }

  for (const [offset, item] of items.slice(start, start + maxItems).entries()) {
    const index = start + offset;
    const selected = index === selectedIndex;
    const marker = selected ? ">" : " ";
    const lifecycle = color(lifecycleColor(item.lifecycle), lifecycleSymbol(item.lifecycle));
    const kind = color(kindColor(item.kind), kindLabel(item.kind).padEnd(18));
    const repo = color("blue", `${item.repoName} #${item.number}`);
    const updated = color("dim", formatDate(item.updatedAt).padEnd(14));
    const bot = isDependabotPr(item) ? `${color("green", "[dependabot]")} ` : "";
    const title = item.lifecycle === "new" || item.lifecycle === "unread" ? color("bold", item.title) : item.title;
    const row = `${marker} ${updated} ${lifecycle} ${kind} ${repo}  ${bot}${title}`;
    writeLine(selected ? highlightLine(row, width) : row, width);
  }
}

function renderActions(actionMode: Extract<Mode, { name: "actions" }>): void {
  const width = process.stdout.columns || 100;
  const item = actionMode.item;
  writeLine(color("blue", `${item.repo} #${item.number}`));
  writeLine(
    `${color(kindColor(item.kind), kindLabel(item.kind))} | ${color(lifecycleColor(item.lifecycle), item.lifecycle)} | ${formatDate(item.updatedAt)} | ${item.actor}`,
  );
  writeLine(color("bold", item.title), width);
  writeLine(`${color("dim", "URL:")} ${item.url}`, width);
  if (item.localPath) writeLine(`${color("dim", "Local:")} ${item.localPath}`, width);
  if (actionMode.error) writeLine(`${color("red", "Details error:")} ${actionMode.error}`, width);
  if (actionMode.details?.body) {
    writeLine("");
    for (const line of actionMode.details.body.replace(/\s+/g, " ").match(/.{1,120}/g) || []) writeLine(line, width);
  }
  if (actionMode.details?.comments.length) {
    writeLine("");
    writeLine(color("bold", "Comments:"));
    for (const comment of actionMode.details.comments.slice(-3)) {
      writeLine(`- ${comment.author}: ${comment.body.replace(/\s+/g, " ").slice(0, 140)}`, width);
    }
  }
  writeLine("");
  const actions = actionsForItem(item);
  for (const [index, action] of actions.entries()) {
    const prefix = index === actionMode.selectedAction ? ">" : " ";
    writeLine(
      `${prefix} ${index === actionMode.selectedAction ? color("bold", actionLabel(action)) : actionLabel(action)}`,
    );
  }
  writeLine("");
  writeLine(color("dim", "up/down select action  enter run  escape back  q quit"));
}

function renderMessage(message: Extract<Mode, { name: "message" }>): void {
  const width = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  writeLine(color("bold", message.title));
  writeLine(color("dim", "press any key to return"));
  writeLine("");
  for (const line of message.body.slice(0, rows - 4)) writeLine(line, width);
}

function writeLine(value: string, width = process.stdout.columns || 100): void {
  process.stdout.write(`${truncate(value, width)}\n`);
}

function truncate(value: string, width: number): string {
  const clean = value.replace(ANSI_PATTERN, "");
  if (clean.length <= width) return value;
  return `${clean.slice(0, Math.max(0, width - 1))}.`;
}

function kindLabel(kind: WatchItem["kind"]): string {
  if (kind === "pr_review_request") return "pr review";
  return kind.replaceAll("_", " ");
}

function lifecycleSymbol(lifecycle: WatchItem["lifecycle"]): string {
  if (lifecycle === "new") return "N";
  if (lifecycle === "unread") return "U";
  if (lifecycle === "active") return "A";
  if (lifecycle === "acknowledged") return "-";
  return "M";
}

function highlightLine(value: string, width: number): string {
  const clean = value.replace(ANSI_PATTERN, "");
  if (!process.stdout.isTTY) return clean;
  const padded = `${clean}${" ".repeat(Math.max(0, width - clean.length))}`;
  return `\u001b[30;47m${padded}\u001b[0m`;
}

type ColorName = "bold" | "dim" | "green" | "purple" | "yellow" | "red" | "blue" | "gray";

function color(name: ColorName, value: string): string {
  if (!process.stdout.isTTY) return value;
  const codes: Record<ColorName, string> = {
    bold: "1",
    dim: "2",
    green: "32",
    purple: "35",
    yellow: "33",
    red: "31",
    blue: "34",
    gray: "90",
  };
  return `\u001b[${codes[name]}m${value}\u001b[0m`;
}

function kindColor(kind: WatchItem["kind"]): ColorName {
  if (kind === "pr_review_request") return "green";
  if (kind === "pr_comment") return "purple";
  if (kind === "issue_assigned") return "yellow";
  if (kind === "issue_mention") return "green";
  if (kind === "issue_comment") return "red";
  return "gray";
}

function lifecycleColor(lifecycle: WatchItem["lifecycle"]): ColorName {
  if (lifecycle === "new") return "green";
  if (lifecycle === "unread") return "yellow";
  if (lifecycle === "acknowledged") return "gray";
  return "dim";
}

function cacheStatusLabel(status: Snapshot["cacheStatus"]): string {
  if (status === "fresh") return color("green", status);
  if (status === "partial" || status === "stale") return color("yellow", status);
  return color("red", status);
}

function formatDate(value: string | undefined): string {
  if (!value) return "unknown";
  return new Date(value).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function isUp(data: string): boolean {
  return data === "\u001b[A" || data === "\u001bOA" || data === "k";
}

function isDown(data: string): boolean {
  return data === "\u001b[B" || data === "\u001bOB" || data === "j";
}

function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

function emptySnapshot(config: Config): Snapshot {
  return {
    generatedAt: new Date().toISOString(),
    host: config.host,
    items: [],
    errors: [],
    cacheStatus: "stale",
  };
}

function suspendTerminal(): void {
  restoringTerminal = true;
  process.stdin.off("data", inputHandler);
  process.stdin.pause();
  restoreTerminal();
}

function resumeTerminal(): void {
  restoringTerminal = false;
  process.stdout.write("\x1b[?25l");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on("data", inputHandler);
  process.stdin.resume();
}

function restoreTerminal(): void {
  process.stdout.write("\x1b[?25h");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function shutdown(): never {
  if (pollTimer) clearInterval(pollTimer);
  restoreTerminal();
  process.stdout.write("\n");
  process.exit(0);
}

function printHelp(): void {
  console.log(`Usage: bun run watch -- [options]

Options:
  --agent codex|claude       Preselect an agent in the PR action menu
  --poll-seconds <seconds>   Override ATTN_POLL_SECONDS
  --include-acknowledged     Show acknowledged items
  --help                     Show this help
`);
}

main().catch((error) => {
  restoreTerminal();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
