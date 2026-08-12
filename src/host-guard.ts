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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Pinning Host to loopback stops DNS rebinding, but it is not a CSRF control: a
// page on any origin can `fetch("http://127.0.0.1:8765/api/...")`, which sends a
// loopback Host that isAllowedHost accepts. There are no credentials to steal
// here, but the state-changing endpoints have local side effects (open-review-
// terminal launches a process; ack mutates state). SvelteKit's built-in check
// only covers form content types and is off in dev, so guard the origin here.
export function isAllowedRequestOrigin(
  method: string,
  secFetchSite: string | null,
  origin: string | null,
  extraHosts: Iterable<string> = [],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  // Fetch metadata is the most reliable signal and is set by every current
  // browser. "same-origin" is the dashboard's own fetch(); "none" is a user
  // gesture (typed URL, bookmark). "same-site"/"cross-site" are not us.
  if (secFetchSite) return secFetchSite === "same-origin" || secFetchSite === "none";
  // Older browsers omit Sec-Fetch-Site but still send Origin on a POST. A
  // non-browser client (curl, the CLI) sends neither and carries no ambient
  // authority, so it is not a CSRF vector — allow it.
  if (origin) {
    try {
      return isAllowedHost(new URL(origin).host, extraHosts);
    } catch {
      return false; // opaque origins serialize to the literal "null"
    }
  }
  return true;
}
