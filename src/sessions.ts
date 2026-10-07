// Browser sessions. Each sign-in gets a random session id, sent as the
// attn_session cookie; the server keeps only its SHA-256, with an expiry, in
// sessions.json beside the state file (owner-only). Sessions survive restarts
// and `attn signout` revokes them all. A cookie leaked to another process
// (cookies are not port-scoped on loopback) is therefore revocable and expires.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile } from "./private-file";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;

export function sessionsPath(stateFile: string): string {
  return join(dirname(stateFile), "sessions.json");
}

function hashOf(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function loadEntries(path: string): Promise<Map<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { sessions?: Record<string, unknown> };
    const entries = Object.entries(parsed.sessions ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    );
    return new Map(entries);
  } catch {
    // Missing or unreadable: everyone signs in again, nothing else is lost.
    return new Map();
  }
}

export class SessionStore {
  private constructor(
    private readonly path: string,
    private readonly entries: Map<string, number>,
  ) {}

  static async load(path: string): Promise<SessionStore> {
    return new SessionStore(path, await loadEntries(path));
  }

  has(id: string | undefined, now = Date.now()): boolean {
    if (!id) return false;
    const expiresAt = this.entries.get(hashOf(id));
    return expiresAt !== undefined && now < expiresAt;
  }

  async create(now = Date.now()): Promise<string> {
    for (const [hash, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(hash);
    // Map iteration is insertion order, so the first key is the oldest session.
    while (this.entries.size >= MAX_SESSIONS) this.entries.delete(this.entries.keys().next().value as string);
    const id = randomBytes(32).toString("base64url");
    this.entries.set(hashOf(id), now + SESSION_TTL_MS);
    await this.save();
    return id;
  }

  async revokeAll(): Promise<number> {
    const count = this.entries.size;
    this.entries.clear();
    await this.save();
    return count;
  }

  private async save(): Promise<void> {
    await writePrivateFile(this.path, `${JSON.stringify({ sessions: Object.fromEntries(this.entries) }, null, 2)}\n`);
  }
}
