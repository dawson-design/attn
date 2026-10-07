// Credentials for local non-browser clients (the `attn mcp` proxy). The server
// writes a fresh random token and its port to agent.json beside the state file
// on every start; a client must send the token as a bearer header on any
// state-changing request that carries no browser fetch metadata. The file is
// mode 0600, so only the user running the server can read it, which keeps
// other local accounts from driving /api/* over loopback.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface AgentCredentials {
  port: number;
  token: string;
}

export function agentCredentialsPath(stateFile: string): string {
  return join(dirname(stateFile), "agent.json");
}

export function newAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function writeAgentCredentials(path: string, credentials: AgentCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  // writeFile's mode only applies when it creates the file; chmod covers a
  // leftover temp file from a crashed run.
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function readAgentCredentials(path: string): Promise<AgentCredentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentCredentials>;
    if (!Number.isSafeInteger(parsed.port) || typeof parsed.token !== "string" || !parsed.token) return undefined;
    return { port: parsed.port as number, token: parsed.token };
  } catch {
    return undefined;
  }
}

// Constant-time comparison of an Authorization header against the token.
export function bearerMatches(expected: string | undefined, authorization: string | null): boolean {
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const given = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
