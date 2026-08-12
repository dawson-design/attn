import { text, type Handle } from "@sveltejs/kit";
import { loadConfig } from "./config";
import { isAllowedHost, isAllowedRequestOrigin } from "./host-guard";

// Reject requests whose Host header is not a loopback (or explicitly allowed)
// host. This is the DNS-rebinding guard adapter-node does not provide; see
// host-guard.ts for why loopback binding alone is insufficient. The allowlist
// comes from config (GHE_WATCH_ALLOWED_HOSTS), resolved lazily on the first
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
