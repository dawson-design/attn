import { describe, expect, test } from "bun:test";
import { hostnameOf, isAllowedHost, parseAllowedHostsEnv } from "../src/host-guard";

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
