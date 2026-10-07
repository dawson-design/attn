import { text, type Handle, type ServerInit } from "@sveltejs/kit";
import { agentCredentialsPath, bearerMatches, newAgentToken, writeAgentCredentials } from "./agent-token";
import { loadConfig } from "./config";
import { isAllowedHost, isAllowedRequestOrigin } from "./host-guard";

// A new token on every start, so a token copied from an old agent.json stops
// working after a restart.
const agentToken = newAgentToken();

export const init: ServerInit = async () => {
  const config = loadConfig();
  const port = Number(process.env.PORT) || config.port;
  await writeAgentCredentials(agentCredentialsPath(config.stateFile), { port, token: agentToken });
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

  // Reject cross-site state-changing requests (CSRF). The Host guard above only
  // stops rebinding; this stops a page on another origin from driving /api/*.
  const request = event.request;
  if (
    !isAllowedRequestOrigin(
      request.method,
      request.headers.get("sec-fetch-site"),
      request.headers.get("origin"),
      extraHosts,
      bearerMatches(agentToken, request.headers.get("authorization")),
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
