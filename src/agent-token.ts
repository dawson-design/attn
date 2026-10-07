// The local credential for attn. The server creates one random token on first
// start and keeps it in agent.json beside the state file (mode 0600, in a 0700
// directory), so only the user running attn can read it. Every /api and
// /events request must carry it, either as a bearer header (`attn mcp`,
// `attn open`) or as the browser session cookie derived from it (see auth.ts).
// Loopback is reachable by every local account and request headers are easy to
// fake, so the token is the only thing that separates this user from others.
//
// The token survives restarts so a running browser session and the MCP client
// keep working after `brew services restart`. Delete agent.json and restart
// the server to rotate it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDir } from "./private-file";

export function agentCredentialsPath(stateFile: string): string {
  return join(dirname(stateFile), "agent.json");
}

export function newAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

export class InvalidAgentTokenError extends Error {
  constructor(path: string) {
    super(`${path} holds no valid attn token; delete it and restart attn`);
  }
}

// Undefined when the file does not exist yet; throws when it exists but is
// unusable, so callers report the real problem instead of "not running".
export async function readAgentToken(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: { token?: unknown };
  try {
    parsed = JSON.parse(raw) as { token?: unknown };
  } catch {
    throw new InvalidAgentTokenError(path);
  }
  if (typeof parsed.token !== "string" || parsed.token.length < 32) throw new InvalidAgentTokenError(path);
  return parsed.token;
}

// Returns the existing token, or creates one. The token is written to a temp
// file and hard-linked into place: link() fails if agent.json already exists
// and never exposes a half-written file, so two servers starting at once agree
// on a single token.
export async function loadOrCreateAgentToken(path: string): Promise<string> {
  const existing = await readAgentToken(path);
  if (existing) return existing;
  await ensurePrivateDir(dirname(path));
  const token = newAgentToken();
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ token })}\n`, { mode: 0o600 });
  try {
    await link(tmp, path);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readAgentToken(path);
    if (raced) return raced;
    throw new InvalidAgentTokenError(path);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export function safeEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Constant-time comparison of an Authorization header against the token.
export function bearerMatches(expected: string | undefined, authorization: string | null): boolean {
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  return safeEqual(expected, authorization.slice("Bearer ".length));
}
