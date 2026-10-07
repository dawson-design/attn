// Request authentication for the local server. Pure apart from the clock, so
// the rules can be tested without a server.
//
// - Agents (`attn mcp`, `attn open`, `attn signout`) do not use HTTP. They
//   talk to the server over a Unix socket in the owner-only state directory
//   (lib/server/agent-socket.ts), so only this user's processes can reach it,
//   and a client that connects knows it reached this user's attn.
// - The browser holds a session token in the tab's sessionStorage and sends
//   it as `Authorization: Bearer` (lib/session-client.ts). `attn
//   open` asks the server, over the socket, for a one-time login code and
//   opens `/#code=<code>` through an owner-only file; the page trades the code
//   for a random session (sessions.ts) that ends when the server stops. There
//   is no cookie: cookies are not port-scoped, so a program listening on
//   another port of attn.localhost would receive one.
import { randomBytes } from "node:crypto";

export const LOGIN_CODE_TTL_MS = 60_000;
const MAX_OUTSTANDING_CODES = 20;

export function bearerToken(authorization: string | null): string | undefined {
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

export function isAuthenticated(
  authorization: string | null,
  sessions: { has(id: string | undefined): boolean },
): boolean {
  return sessions.has(bearerToken(authorization));
}

// Served without a session: the page shell (its HTML carries no data; the
// page fetches everything with the token), the hashed app bundle, the favicon,
// and the code-for-token exchange. Everything else, including /api/* and
// /events, needs the token.
export function isPublicRequest(method: string, pathname: string): boolean {
  if (pathname.startsWith("/_app/") || pathname.startsWith("/favicon")) return true;
  if ((method === "GET" || method === "HEAD") && pathname === "/") return true;
  return method === "POST" && pathname === "/api/session";
}

// Unauthenticated page loads get the locked page; API calls get a JSON 401.
export function wantsLockedPage(method: string, pathname: string): boolean {
  return method === "GET" && !pathname.startsWith("/api/") && pathname !== "/events";
}

// Single-use login codes with a short lifetime. Kept in memory: a restart
// invalidates them, which only costs another `attn open`.
export class LoginCodes {
  private readonly codes = new Map<string, number>();

  issue(now = Date.now()): string {
    this.prune(now);
    if (this.codes.size >= MAX_OUTSTANDING_CODES) {
      const oldest = this.codes.keys().next().value as string;
      this.codes.delete(oldest);
    }
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, now + LOGIN_CODE_TTL_MS);
    return code;
  }

  redeem(code: unknown, now = Date.now()): boolean {
    if (typeof code !== "string") return false;
    const expiresAt = this.codes.get(code);
    this.codes.delete(code);
    return expiresAt !== undefined && now <= expiresAt;
  }

  private prune(now: number): void {
    for (const [code, expiresAt] of this.codes) if (expiresAt < now) this.codes.delete(code);
  }
}
