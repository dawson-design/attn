import { describe, expect, test } from "bun:test";
import { hostnameOf, isAllowedHost, isAllowedRequestOrigin, parseAllowedHostsEnv } from "../src/host-guard";

describe("hostnameOf", () => {
  test("strips the port from host:port and bracketed IPv6", () => {
    expect(hostnameOf("127.0.0.1:8765")).toBe("127.0.0.1");
    expect(hostnameOf("localhost")).toBe("localhost");
    expect(hostnameOf("[::1]:8765")).toBe("[::1]");
  });
});

describe("isAllowedHost", () => {
  test("accepts loopback hosts regardless of port or case", () => {
    expect(isAllowedHost("127.0.0.1:8765")).toBe(true);
    expect(isAllowedHost("localhost:8765")).toBe(true);
    expect(isAllowedHost("LocalHost")).toBe(true);
    expect(isAllowedHost("[::1]:8765")).toBe(true);
  });

  test("rejects a rebound attacker Host header", () => {
    // Under DNS rebinding the socket is loopback but the Host is the attacker's
    // original domain — exactly what this guard blocks.
    expect(isAllowedHost("evil.example:8765")).toBe(false);
    expect(isAllowedHost("dashboard.internal")).toBe(false);
    expect(isAllowedHost("")).toBe(false);
  });

  test("honors the GHE_WATCH_ALLOWED_HOSTS escape hatch", () => {
    const extra = parseAllowedHostsEnv("watch.example, proxy.internal ");
    expect(extra).toEqual(["watch.example", "proxy.internal"]);
    expect(isAllowedHost("watch.example:8765", extra)).toBe(true);
    expect(isAllowedHost("other.example", extra)).toBe(false);
  });
});

describe("isAllowedRequestOrigin", () => {
  test("always allows safe methods", () => {
    // GET/HEAD have no side effects; the Host guard already covers rebinding.
    expect(isAllowedRequestOrigin("GET", "cross-site", "https://evil.example")).toBe(true);
    expect(isAllowedRequestOrigin("HEAD", null, null)).toBe(true);
  });

  test("allows the dashboard's own same-origin fetches", () => {
    expect(isAllowedRequestOrigin("POST", "same-origin", "http://127.0.0.1:8765")).toBe(true);
    // A user gesture (typed URL, bookmark) is not a cross-site request.
    expect(isAllowedRequestOrigin("POST", "none", null)).toBe(true);
  });

  test("rejects cross-site and same-site state-changing requests", () => {
    // The CSRF vector: a page on another origin drives /api/* in the browser.
    expect(isAllowedRequestOrigin("POST", "cross-site", "https://evil.example")).toBe(false);
    expect(isAllowedRequestOrigin("POST", "same-site", "https://evil.example")).toBe(false);
  });

  test("falls back to the Origin header when Sec-Fetch-Site is absent", () => {
    // Older browsers omit fetch metadata but still send Origin on a POST.
    expect(isAllowedRequestOrigin("POST", null, "http://localhost:8765")).toBe(true);
    expect(isAllowedRequestOrigin("POST", null, "https://evil.example")).toBe(false);
    // An opaque origin serializes to the literal "null" — reject it.
    expect(isAllowedRequestOrigin("POST", null, "null")).toBe(false);
  });

  test("allows non-browser clients that send neither header", () => {
    // curl / the CLI carry no ambient authority, so they are not a CSRF vector.
    expect(isAllowedRequestOrigin("POST", null, null)).toBe(true);
  });

  test("honors the allowed-hosts escape hatch for the Origin fallback", () => {
    const extra = parseAllowedHostsEnv("watch.example");
    expect(isAllowedRequestOrigin("POST", null, "https://watch.example", extra)).toBe(true);
  });
});
