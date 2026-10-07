// `attn` — the run-only front door to the dashboard.
//
// Installed (Homebrew) deployments run this as `bin/attn`, a wrapper that
// sets ATTN_HOME and execs `bun cli.js <command>`; dev checkouts run the
// same commands via `bun run cli <command>`. Mode selection and all path
// differences live in src/paths.ts — this file only picks entry points.
//
// Commands:
//   serve              run the dashboard server (what `brew services` invokes)
//   init               first-run setup: write the config file, check gh auth,
//                      offer the notification-window login item
//   install-window     install the login-time Chrome window LaunchAgent
//   uninstall-window   remove it
//   open               open the Chrome app window now (used by the LaunchAgent)
//   status [--json]    show config paths, server/agent/auth state; --json
//                      prints waiting-item counts from the last snapshot
//   watch [options]    terminal UI (src/cli/watch.ts)
//   mcp                MCP server on stdio, proxying to the running server
//   setup claude-desktop
//                      add the MCP server to Claude Desktop's config

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import packageJson from "../../package.json" with { type: "json" };
import { agentCredentialsPath } from "../agent-token";
import { loadConfig } from "../config";
import { httpAttnApi } from "../mcp/api";
import { createAttnMcpServer } from "../mcp/server";
import { resolveAppPaths, type AppPaths } from "../paths";
import { loadSnapshot } from "../snapshot-cache";
import { loadState } from "../state";
import type { AppState, ItemKind, Snapshot } from "../types";
import { attnServerEntry, claudeDesktopConfigPath, mergeDesktopConfig } from "./claude-desktop";
import { applyCurrentLifecycle } from "./watch-core";
import { runWatch } from "./watch";
import { renderWindowPlist, windowAgentLabel } from "./window-agent";

export interface CliInvocation {
  command?: string;
  force: boolean;
  help: boolean;
  json: boolean;
  // Second word of `setup <target>`.
  target?: string;
  unknown: string[];
}

export function parseCliArgs(argv: string[]): CliInvocation {
  const invocation: CliInvocation = { force: false, help: false, json: false, unknown: [] };
  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") invocation.force = true;
    else if (arg === "--json") invocation.json = true;
    else if (arg === "--help" || arg === "-h") invocation.help = true;
    else if (arg.startsWith("-")) invocation.unknown.push(arg);
    else if (invocation.command === undefined) invocation.command = arg;
    else if (invocation.command === "setup" && invocation.target === undefined) invocation.target = arg;
    else invocation.unknown.push(arg);
  }
  return invocation;
}

// Contents of the config file written by `init`. Round-trips through
// parseEnvFile (see config-file.ts), so what init writes is exactly what
// loadConfig reads back.
export function buildConfigFileContents(host: string, checkoutRoots: string): string {
  const lines = [
    "# attn configuration (KEY=value).",
    "# No secrets belong here — GitHub auth comes from `gh auth login`.",
    "# All available ATTN_* settings are documented in the project README.",
    `ATTN_HOST=${host}`,
  ];
  if (checkoutRoots) lines.push(`ATTN_CHECKOUT_ROOTS=${checkoutRoots}`);
  return `${lines.join("\n")}\n`;
}

const HELP = `Usage: attn <command>

Commands:
  serve              Run the dashboard server (foreground; brew services uses this)
  init [--force]     First-run setup: write the config file, check gh auth,
                     offer the notification-window login item
  install-window     Open a Chrome app window to the dashboard at every login
  uninstall-window   Stop opening it
  open               Open the Chrome app window now
  status [--json]    Show config paths, server, window agent, and gh auth state.
                     --json prints waiting-item counts from the last snapshot
                     (no network calls)
  watch [options]    Terminal UI; run \`attn watch --help\` for options
  mcp                MCP server on stdio for Claude and other agents; needs
                     the dashboard server running
  setup claude-desktop
                     Add the attn MCP server to Claude Desktop's config
                     (asks first and backs the file up)
`;

function installRoot(): string | undefined {
  const home = process.env.ATTN_HOME?.trim();
  return home || undefined;
}

// Repo root when running from a checkout (this file lives at src/cli/main.ts).
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function appPaths(): AppPaths {
  return resolveAppPaths(process.env, homedir(), process.cwd());
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function requireDarwin(command: string): void {
  if (process.platform !== "darwin") fail(`\`${command}\` manages a macOS LaunchAgent and only runs on macOS`);
}

function run(command: string, args: string[], opts: { allowFailure?: boolean } = {}): number {
  const result = spawnSync(command, args, { stdio: "inherit" });
  const status = result.status ?? 1;
  if (status !== 0 && !opts.allowFailure) fail(`${command} ${args.join(" ")} exited with ${status}`);
  return status;
}

function launchdDomain(): string {
  return `gui/${process.getuid!()}`;
}

function windowAgentPlistPath(label: string): string {
  return `${homedir()}/Library/LaunchAgents/${label}.plist`;
}

// --- serve --------------------------------------------------------------------

async function serve(): Promise<void> {
  const config = loadConfig();
  // Loopback binding is part of the security model — never widen it here.
  process.env.HOST = "127.0.0.1";
  process.env.PORT ||= String(config.port);
  const root = installRoot();
  const entry = root ? `${root}/server/index.js` : `${repoRoot()}/build/index.js`;
  if (!existsSync(entry)) {
    fail(`server entry not found: ${entry}${root ? "" : " — run 'bun run build' first"}`);
  }
  await import(entry);
}

// --- window agent -------------------------------------------------------------

function installWindow(): void {
  requireDarwin("install-window");
  const config = loadConfig();
  const label = windowAgentLabel(userInfo().username);

  if (!existsSync("/Applications/Google Chrome.app")) {
    console.warn(
      "WARNING: Google Chrome.app not found in /Applications; the window will not open until it is installed.",
    );
  }

  const root = installRoot();
  // Installed mode launches the packaged wrapper (which restores
  // ATTN_HOME); dev mode runs this file with the current bun.
  const programArgs = root
    ? [process.env.ATTN_BIN?.trim() || resolve(root, "..", "bin", "attn"), "open"]
    : [process.execPath, `${repoRoot()}/src/cli/main.ts`, "open"];
  const logDir = root ? `${homedir()}/Library/Logs/attn` : `${repoRoot()}/.local-state/logs`;
  mkdirSync(logDir, { recursive: true });

  const plist = renderWindowPlist({
    label,
    programArgs,
    path: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    port: config.port,
    logDir,
  });
  const plistPath = windowAgentPlistPath(label);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plist);

  console.log(`==> Loading ${label}`);
  run("launchctl", ["bootout", `${launchdDomain()}/${label}`], { allowFailure: true });
  run("launchctl", ["bootstrap", launchdDomain(), plistPath]);
  run("launchctl", ["kickstart", "-k", `${launchdDomain()}/${label}`]);
  console.log(`==> Done. A Chrome app window opens once http://127.0.0.1:${config.port} responds.`);
  console.log("    First time only: click 'Enable notifications' in the dashboard header and Allow");
  console.log("    the Chrome permission prompt so new items trigger a macOS notification.");
}

function uninstallWindow(): void {
  requireDarwin("uninstall-window");
  const label = windowAgentLabel(userInfo().username);
  run("launchctl", ["bootout", `${launchdDomain()}/${label}`], { allowFailure: true });
  rmSync(windowAgentPlistPath(label), { force: true });
  console.log(`==> Removed ${windowAgentPlistPath(label)}`);
}

// --- open ---------------------------------------------------------------------

async function serverResponds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// Both LaunchAgents are RunAtLoad with no ordering guarantee between them, so
// wait for the backend before opening the window (any HTTP response counts).
async function openWindow(): Promise<void> {
  requireDarwin("open");
  const url = `http://127.0.0.1:${loadConfig().port}`;
  console.log(`==> Waiting for ${url} to respond`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await serverResponds(url)) break;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
  }
  console.log("==> Opening dashboard app window");
  run("open", ["-na", "Google Chrome", "--args", `--app=${url}`]);
}

// --- init ---------------------------------------------------------------------

async function init(force: boolean): Promise<void> {
  const paths = appPaths();
  // Write wherever the app actually reads config in this mode: the installed
  // config file, or the checkout's .env that Bun auto-loads.
  const configFile = paths.mode === "installed" ? paths.configFile! : `${repoRoot()}/.env`;
  if (existsSync(configFile) && !force) {
    fail(`${configFile} already exists — edit it directly, or re-run with --force to overwrite`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const host = (await rl.question("GitHub host to watch [github.com]: ")).trim() || "github.com";
    const roots = (
      await rl.question("Local checkout roots to scan for clones (comma-separated absolute paths, empty to skip): ")
    ).trim();

    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, buildConfigFileContents(host, roots));
    console.log(`==> Wrote ${configFile}`);
    seedReviewPrompt(paths);
    checkGhAuth(host);

    if (process.platform === "darwin") {
      const answer = (await rl.question("Open a Chrome notification window at login? [Y/n]: ")).trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") installWindow();
    }
  } finally {
    rl.close();
  }

  console.log("==> Setup complete.");
  if (paths.mode === "installed") {
    console.log("    Start the dashboard with: brew services start attn");
  } else {
    console.log("    Start the dashboard with: bun run dev (or scripts/install-service.sh for the login service)");
  }
}

// Give installed users an editable copy of the review-prompt template; the
// packaged share/review.md matches the built-in default, so this is purely a
// customization convenience and skipping it loses nothing.
function seedReviewPrompt(paths: AppPaths): void {
  const root = installRoot();
  if (!root || paths.mode !== "installed" || existsSync(paths.reviewPromptFile)) return;
  const shipped = `${root}/share/review.md`;
  if (!existsSync(shipped)) return;
  mkdirSync(dirname(paths.reviewPromptFile), { recursive: true });
  copyFileSync(shipped, paths.reviewPromptFile);
  console.log(`==> Seeded review-prompt template at ${paths.reviewPromptFile}`);
}

function checkGhAuth(host: string): void {
  const result = spawnSync("gh", ["auth", "status", "--hostname", host], { stdio: "ignore" });
  if (result.error) {
    console.warn("WARNING: `gh` not found on PATH — install it (brew install gh) and run:");
  } else if (result.status !== 0) {
    console.warn(`WARNING: gh is not authenticated against ${host} — run:`);
  } else {
    console.log(`==> gh is authenticated against ${host}`);
    return;
  }
  console.warn(`    gh auth login --hostname ${host}`);
}

// --- status -------------------------------------------------------------------

async function status(): Promise<void> {
  const config = loadConfig();
  const paths = appPaths();
  console.log(`mode:         ${paths.mode}`);
  console.log(`config file:  ${paths.configFile ?? "(dev: .env in the checkout)"}`);
  console.log(`state file:   ${config.stateFile}`);
  console.log(`host:         ${config.host}`);

  const url = `http://127.0.0.1:${config.port}`;
  console.log(`server:       ${(await serverResponds(url)) ? `responding at ${url}` : `not responding at ${url}`}`);

  if (process.platform === "darwin") {
    const label = windowAgentLabel(userInfo().username);
    const loaded = spawnSync("launchctl", ["print", `${launchdDomain()}/${label}`], { stdio: "ignore" }).status === 0;
    console.log(`window agent: ${label} ${loaded ? "loaded" : "not loaded"}`);
  }

  const auth = spawnSync("gh", ["auth", "status", "--hostname", config.host], { stdio: "ignore" });
  console.log(
    `gh auth:      ${auth.error ? "gh not found" : auth.status === 0 ? "ok" : `not logged in to ${config.host}`}`,
  );
}

export interface StatusSummary {
  host: string;
  generatedAt: string | null;
  cacheStatus: Snapshot["cacheStatus"] | null;
  waiting: number;
  waitingByKind: Record<ItemKind, number>;
}

// Items not yet acknowledged, counted per kind. Pure so the SessionStart hook's
// numbers can be tested without files.
export function summarizeStatus(
  host: string,
  snapshot: Snapshot | undefined,
  state: AppState,
  now?: string,
): StatusSummary {
  const waitingByKind: Record<ItemKind, number> = {
    pr_review_request: 0,
    pr_comment: 0,
    issue_assigned: 0,
    issue_mention: 0,
    issue_comment: 0,
  };
  const items = snapshot ? applyCurrentLifecycle(state, snapshot.items, now) : [];
  const waiting = items.filter((item) => item.lifecycle !== "acknowledged");
  for (const item of waiting) waitingByKind[item.kind] += 1;
  return {
    host,
    generatedAt: snapshot?.generatedAt ?? null,
    cacheStatus: snapshot?.cacheStatus ?? null,
    waiting: waiting.length,
    waitingByKind,
  };
}

async function statusJson(): Promise<void> {
  const config = loadConfig();
  const snapshot = await loadSnapshot(config.snapshotFile);
  const state = await loadState(config.stateFile);
  // A snapshot from a previously configured host says nothing about this one.
  const current = snapshot?.host === config.host ? snapshot : undefined;
  console.log(JSON.stringify(summarizeStatus(config.host, current, state)));
}

// --- mcp ----------------------------------------------------------------------

// stdout carries the MCP protocol from here on; diagnostics go to stderr.
async function mcp(): Promise<void> {
  const config = loadConfig();
  const api = httpAttnApi(agentCredentialsPath(config.stateFile));
  await createAttnMcpServer(api, packageJson.version).connect(new StdioServerTransport());
}

// --- setup claude-desktop -------------------------------------------------------

async function setupClaudeDesktop(): Promise<void> {
  requireDarwin("setup claude-desktop");
  // The config entry must survive `brew upgrade`, so it uses the wrapper's
  // stable opt path. A clone has no single command that finds its config from
  // any working directory, so only installs are supported.
  const attnBin = process.env.ATTN_BIN?.trim();
  if (!installRoot() || !attnBin) {
    fail("`setup claude-desktop` needs the Homebrew install (brew install kreek/tap/attn)");
  }
  const path = claudeDesktopConfigPath(homedir());
  let existing: unknown;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail(`${path} is not valid JSON; fix it before running setup`);
    }
  }
  const entry = attnServerEntry(attnBin);
  let change;
  try {
    change = mergeDesktopConfig(existing, entry);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (change.kind === "unchanged") {
    console.log(`==> Claude Desktop already runs attn from ${attnBin}`);
    return;
  }

  console.log(`==> This adds an "attn" MCP server to ${path}:`);
  console.log(JSON.stringify({ attn: entry }, null, 2));
  if (change.replaced) console.log(`    It replaces the current attn entry: ${JSON.stringify(change.replaced)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Write it? [y/N]: ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("==> Left the file unchanged.");
    return;
  }

  if (existsSync(path)) {
    const backup = `${path}.attn-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
    console.log(`==> Backed up the current file to ${backup}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.attn-tmp`;
  writeFileSync(tmp, `${JSON.stringify(change.config, null, 2)}\n`);
  renameSync(tmp, path);
  console.log("==> Done. Quit and reopen Claude Desktop to load the attn tools.");
}

// --- entry --------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  // The terminal UI parses its own options.
  if (argv[0] === "watch") return runWatch(argv.slice(1));
  const invocation = parseCliArgs(argv);
  if (invocation.unknown.length > 0) fail(`unknown arguments: ${invocation.unknown.join(" ")}\n\n${HELP}`);
  if (invocation.help || invocation.command === undefined) {
    console.log(HELP);
    if (invocation.command === undefined && !invocation.help) process.exit(1);
    return;
  }

  switch (invocation.command) {
    case "serve":
      return serve();
    case "init":
      return init(invocation.force);
    case "install-window":
      return installWindow();
    case "uninstall-window":
      return uninstallWindow();
    case "open":
      return openWindow();
    case "mcp":
      return mcp();
    case "setup":
      if (invocation.target !== "claude-desktop")
        fail(`unknown setup target: ${invocation.target ?? "(none)"}\n\n${HELP}`);
      return setupClaudeDesktop();
    case "status":
      return invocation.json ? statusJson() : status();
    default:
      fail(`unknown command: ${invocation.command}\n\n${HELP}`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
