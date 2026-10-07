import { json, text, type Handle, type ServerInit } from "@sveltejs/kit";
import { dirname } from "node:path";
import { agentCredentialsPath, bearerMatches, loadOrCreateAgentToken } from "./agent-token";
import { isAuthenticated, isPublicRequest, SESSION_COOKIE, wantsLockedPage } from "./auth";
import { loadConfig } from "./config";
import { isAllowedHost, isAllowedRequestOrigin } from "./host-guard";
import { serverToken, setServerToken } from "./lib/server/auth-state";
import { LOCKED_PAGE } from "./locked-page";
import { ensurePrivateDir } from "./private-file";

export const init: ServerInit = async () => {
  const config = loadConfig();
  // Tighten a state directory created before files were written owner-only.
  await ensurePrivateDir(dirname(config.stateFile));
  setServerToken(await loadOrCreateAgentToken(agentCredentialsPath(config.stateFile)));
};

// Reject requests whose Host header is not a loopback (or explicitly allowed)
// host. This is the DNS-rebinding guard adapter-node does not provide; see
// host-guard.ts for why loopback binding alone is insufficient. The allowlist
// comes from config (ATTN_ALLOWED_HOSTS), resolved lazily on the first
// request so the installed-mode config file is honored, and memoized because
// it must not change while the server runs.
let extraHosts: string[] | undefined;

export const handle: Handle = async ({ event, resolve }) => {
  extraHosts ??= loadConfig().allowedHosts ?? [];
  const host = event.request.headers.get("host") ?? "";
  if (!isAllowedHost(host, extraHosts)) {
    return text("Forbidden: unexpected Host header. This dashboard only serves loopback requests.\n", {
      status: 403,
    });
  }

  // Every other local account can reach loopback, and request headers are easy
  // to fake, so data and actions need the token (bearer) or the session cookie
  // derived from it. See auth.ts.
  const request = event.request;
  const { pathname } = event.url;
  const token = serverToken();
  const authorization = request.headers.get("authorization");
  if (
    !isPublicRequest(request.method, pathname) &&
    !isAuthenticated(token, authorization, event.cookies.get(SESSION_COOKIE))
  ) {
    if (wantsLockedPage(request.method, pathname)) {
      return new Response(LOCKED_PAGE, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ ok: false, error: "Not signed in. Run `attn open`." }, { status: 401 });
  }

  // Reject cross-site state-changing requests (CSRF). The session cookie is
  // SameSite=Strict, and this check stops a page on another origin from
  // driving /api/* even in a browser that ignores SameSite.
  if (
    !isAllowedRequestOrigin(
      request.method,
      request.headers.get("sec-fetch-site"),
      request.headers.get("origin"),
      extraHosts,
      bearerMatches(token, authorization),
    )
  ) {
    return text("Forbidden: cross-origin request rejected.\n", { status: 403 });
  }

  const response = await resolve(event);
  // Defense in depth: no framing (clickjacking of the ack / terminal buttons),
  // no MIME sniffing, and no referrer leaking local URLs to off-site links.
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
};
