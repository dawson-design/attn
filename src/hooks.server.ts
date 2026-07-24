import { text, type Handle } from "@sveltejs/kit";
import { isAllowedHost, parseAllowedHostsEnv } from "./host-guard";

// Reject requests whose Host header is not a loopback (or explicitly allowed)
// host. This is the DNS-rebinding guard adapter-node does not provide; see
// host-guard.ts for why loopback binding alone is insufficient.
const extraHosts = parseAllowedHostsEnv(process.env.GHE_WATCH_ALLOWED_HOSTS);

export const handle: Handle = async ({ event, resolve }) => {
  const host = event.request.headers.get("host") ?? "";
  if (!isAllowedHost(host, extraHosts)) {
    return text("Forbidden: unexpected Host header. This dashboard only serves loopback requests.\n", {
      status: 403,
    });
  }
  return resolve(event);
};
