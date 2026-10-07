// Host-header and origin rules for the local dashboard.
//
// The dashboard lives at https://attn.localhost:<port>. Only that Host is
// served. Pinning Host stops DNS rebinding: a page on an attacker domain whose
// DNS re-resolves to 127.0.0.1 still sends its own name in Host (and fails
// the TLS name check before that). See tls.ts for why the address is safe to
// keep fixed.
import { DASHBOARD_HOSTNAME } from "./tls";

// The hostname portion of a Host header, minus the port. Handles bracketed IPv6
// ("[::1]:8765" -> "[::1]") and host:port ("127.0.0.1:8765" -> "127.0.0.1").
export function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

export function dashboardHost(port: number): string {
  return `${DASHBOARD_HOSTNAME}:${port}`;
}

export function dashboardOrigin(port: number): string {
  return `https://${dashboardHost(port)}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// "dashboard": attn.localhost on attn's port, the only Host that serves data.
// "local": another loopback name, such as 127.0.0.1. It gets the locked page
// and nothing else.
// "foreign": anything else, e.g. a rebound attacker domain. Rejected.
export type HostKind = "dashboard" | "local" | "foreign";

export function classifyHost(hostHeader: string, currentDashboardHost: string): HostKind {
  const host = hostHeader.toLowerCase();
  if (host === currentDashboardHost) return "dashboard";
  const name = hostnameOf(host);
  return LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost") ? "local" : "foreign";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF guard for state-changing requests. The session token is a header the
// page adds itself, which another origin cannot, but the endpoints have local
// side effects (open-review-terminal launches a process; ack mutates state),
// so the origin is checked too. SvelteKit's built-in check only covers form content
// types and is off in dev. A non-browser client can fake these headers, which
// is why hooks.server.ts requires a session first.
export function isAllowedRequestOrigin(
  method: string,
  secFetchSite: string | null,
  origin: string | null,
  currentDashboardOrigin: string,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  // Fetch metadata is set by every current browser. "same-origin" is the
  // dashboard's own fetch(); "none" is a user gesture (typed URL, bookmark).
  if (secFetchSite) return secFetchSite === "same-origin" || secFetchSite === "none";
  // Older browsers omit Sec-Fetch-Site but still send Origin on a POST.
  return origin === currentDashboardOrigin;
}
