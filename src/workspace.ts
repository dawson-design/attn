import type { Config } from "./types";
import { access, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

// Extract the `owner/repo` slug from a git remote for the configured host.
// Handles both ssh (git@host:owner/repo.git) and https
// (https://host/owner/repo.git) forms, any owner/org, and repo names that
// contain dots (e.g. `api-docs.wiki`). The returned slug matches `gh`'s
// `nameWithOwner`, which is how local checkouts are keyed to search results.
function parseRemote(remote: string, host: string): string | undefined {
  const cleaned = remote.trim().replace(/\.git$/, "");
  if (host && !cleaned.includes(host)) return undefined;
  const match = cleaned.match(/[:/]([^/:]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function originFor(path: string): Promise<string | undefined> {
  const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number | null }>((resolve) => {
    const proc = spawn("git", ["-C", path, "remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdoutChunks: Buffer[] = [];
    proc.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    proc.on("error", () => resolve({ stdout: "", exitCode: 1 }));
    proc.on("close", (code) => resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), exitCode: code }));
  });
  return exitCode === 0 ? stdout.trim() : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function discoverWorkspaceRepos(config: Config): Promise<Map<string, string>> {
  const map = new Map<string, string>(Object.entries(config.repoPathMap));
  for (const root of config.checkoutRoots.length ? config.checkoutRoots : [config.workspace]) {
    for (const [repo, path] of await discoverReposAt(root, config.host)) {
      if (!map.has(repo)) map.set(repo, path);
    }
  }
  return map;
}

export async function discoverReposAt(workspace: string, host: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = `${workspace}/${entry.name}`;
    if (!(await exists(`${fullPath}/.git`))) continue;
    const origin = await originFor(fullPath);
    if (!origin) continue;
    const repo = parseRemote(origin, host);
    if (repo) map.set(repo, fullPath);
  }
  return map;
}
