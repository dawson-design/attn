import { describe, expect, test } from "bun:test";
import { classifyHost, dashboardHost, dashboardOrigin, hostnameOf, isAllowedRequestOrigin } from "../src/host-guard";

const HOST = dashboardHost(8765);
const ORIGIN = dashboardOrigin(8765);

describe("hostnameOf", () => {
  test("strips the port from host:port and bracketed IPv6", () => {
    expect(hostnameOf("127.0.0.1:8765")).toBe("127.0.0.1");
    expect(hostnameOf("localhost")).toBe("localhost");
    expect(hostnameOf("[::1]:8765")).toBe("[::1]");
  });
});

describe("classifyHost", () => {
  test("only attn.localhost on attn's port reaches the dashboard", () => {
    expect(ORIGIN).toBe("https://attn.localhost:8765");
    expect(classifyHost("attn.localhost:8765", HOST)).toBe("dashboard");
    expect(classifyHost("ATTN.LOCALHOST:8765", HOST)).toBe("dashboard");
    expect(classifyHost("attn.localhost:9999", HOST)).toBe("local");
  });

  test("other loopback names get the locked page", () => {
    for (const host of ["127.0.0.1:8765", "localhost:8765", "[::1]:8765", "other.localhost:8765"]) {
      expect(classifyHost(host, HOST)).toBe("local");
    }
  });

  test("rejects a rebound attacker Host header", () => {
    for (const host of ["evil.example", "evil.example:8765", "127.0.0.1.evil.example", "localhost.evil.example", ""]) {
      expect(classifyHost(host, HOST)).toBe("foreign");
    }
  });
});

describe("isAllowedRequestOrigin", () => {
  test("always allows safe methods", () => {
    expect(isAllowedRequestOrigin("GET", "cross-site", "https://evil.example", ORIGIN)).toBe(true);
    expect(isAllowedRequestOrigin("HEAD", null, null, ORIGIN)).toBe(true);
  });

  test("allows the dashboard's own same-origin fetches and user gestures", () => {
    expect(isAllowedRequestOrigin("POST", "same-origin", ORIGIN, ORIGIN)).toBe(true);
    expect(isAllowedRequestOrigin("POST", "none", null, ORIGIN)).toBe(true);
  });

  test("rejects cross-site and same-site state-changing requests", () => {
    expect(isAllowedRequestOrigin("POST", "cross-site", "https://evil.example", ORIGIN)).toBe(false);
    expect(isAllowedRequestOrigin("POST", "same-site", "https://other.attn.localhost:8765", ORIGIN)).toBe(false);
  });

  test("falls back to the Origin header when Sec-Fetch-Site is absent", () => {
    expect(isAllowedRequestOrigin("POST", null, ORIGIN, ORIGIN)).toBe(true);
    expect(isAllowedRequestOrigin("POST", null, "http://attn.localhost:8765", ORIGIN)).toBe(false);
    expect(isAllowedRequestOrigin("POST", null, "null", ORIGIN)).toBe(false);
  });

  test("rejects a state change with neither header", () => {
    expect(isAllowedRequestOrigin("POST", null, null, ORIGIN)).toBe(false);
  });
});
