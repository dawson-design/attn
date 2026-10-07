// Request authentication for the local server. Pure apart from the clock, so
// the rules can be tested without a server.
//
// - Bearer token (agent-token.ts): `attn mcp` and `attn open`.
// - Session cookie: the browser. `attn open` asks the server for a one-time
//   login code and opens `/#code=<code>`; the locked page trades the code for
//   the cookie. The token itself never appears in a URL or a process argument,
//   which other local accounts can read with `ps`.
// - Server proof: before a client sends the token, it checks that the process
//   on the port knows the token, so a squatter on the port after attn stops
//   never receives it.
import { createHmac, randomBytes } from "node:crypto";
import { bearerMatches, safeEqual } from "./agent-token";

export const SESSION_COOKIE = "attn_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
export const LOGIN_CODE_TTL_MS = 60_000;
const MAX_OUTSTANDING_CODES = 20;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function hmac(token: string, label: string): string {
  return createHmac("sha256", token).update(label).digest("base64url");
}

// Derived from the token, so it changes when the token is rotated.
export function sessionCookieValue(token: string): string {
  return hmac(token, "attn-browser-session");
}

export function serverProof(token: string, nonce: string): string {
  return hmac(token, `attn-server-proof:${nonce}`);
}

export function isValidNonce(nonce: string | null): nonce is string {
  return nonce !== null && NONCE_PATTERN.test(nonce);
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function isAuthenticated(
  token: string,
  authorization: string | null,
  sessionCookie: string | undefined,
): boolean {
  if (bearerMatches(token, authorization)) return true;
  return sessionCookie !== undefined && safeEqual(sessionCookieValue(token), sessionCookie);
}

// Paths served without a credential: the hashed app bundle (no data in it),
// the favicon, the proof check, and the code-for-cookie exchange.
export function isPublicRequest(method: string, pathname: string): boolean {
  if (pathname.startsWith("/_app/") || pathname.startsWith("/favicon")) return true;
  if (method === "GET" && pathname === "/api/agent-proof") return true;
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
