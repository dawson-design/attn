// Browser sessions. Each sign-in gets a random session token, which the page
// sends as a bearer header. Sessions live in memory only, so a restart ends
// them all, and `attn signout` ends them sooner.
//
// They must not survive a restart. While attn is stopped, another account's
// program can listen on its port. Chrome then shows a certificate warning
// (Chrome ignores HSTS for localhost names, so the warning can be clicked
// through). A token that page could ever have read belongs to a stopped
// server and is already dead; tokens issued later stay in other tabs'
// sessionStorage (lib/session-client.ts).
import { randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;

export class SessionStore {
  private readonly entries = new Map<string, number>();

  has(id: string | undefined, now = Date.now()): boolean {
    if (!id) return false;
    const expiresAt = this.entries.get(id);
    return expiresAt !== undefined && now < expiresAt;
  }

  create(now = Date.now()): string {
    for (const [id, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(id);
    // Map iteration is insertion order, so the first key is the oldest session.
    while (this.entries.size >= MAX_SESSIONS) this.entries.delete(this.entries.keys().next().value as string);
    const id = randomBytes(32).toString("base64url");
    this.entries.set(id, now + SESSION_TTL_MS);
    return id;
  }

  revokeAll(): number {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }
}
