// Host-header allowlisting for the local dashboard. The server binds 127.0.0.1,
// but loopback binding alone does not stop DNS rebinding: a page on an attacker
// domain whose DNS re-resolves to 127.0.0.1 becomes same-origin with this
// dashboard in the browser, and SvelteKit's built-in CSRF check only covers
// form content types — JSON POSTs to /api/* (including the terminal launcher)
// sail through. A rebound request still carries the attacker's original Host
// (e.g. "evil.example"), so pinning Host to loopback closes the vector.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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

// Parse the GHE_WATCH_ALLOWED_HOSTS escape hatch (comma-separated hostnames for
// reverse-proxy / container setups that front the dashboard with another name).
export function parseAllowedHostsEnv(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function isAllowedHost(hostHeader: string, extraHosts: Iterable<string> = []): boolean {
  const allowed = new Set(LOOPBACK_HOSTS);
  for (const extra of extraHosts) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) allowed.add(trimmed);
  }
  return allowed.has(hostnameOf(hostHeader).toLowerCase());
}
