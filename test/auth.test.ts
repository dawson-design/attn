import { describe, expect, test } from "bun:test";
import { isAuthenticated, isPublicRequest, LOGIN_CODE_TTL_MS, LoginCodes, wantsLockedPage } from "../src/auth";

describe("isAuthenticated", () => {
  const sessions = { has: (id: string | undefined) => id === "live-session" };

  test("accepts a live session token as a bearer header", () => {
    expect(isAuthenticated("Bearer live-session", sessions)).toBe(true);
  });

  test("rejects requests with no token or a revoked one, whatever else they claim", () => {
    // Sec-Fetch-Site and Origin are not inputs: any local process can send them.
    expect(isAuthenticated(null, sessions)).toBe(false);
    expect(isAuthenticated("Bearer revoked", sessions)).toBe(false);
    expect(isAuthenticated("live-session", sessions)).toBe(false);
    expect(isAuthenticated("Basic live-session", sessions)).toBe(false);
  });
});

describe("public requests", () => {
  test("serves the data-free page shell, the app bundle, and the code exchange without a session", () => {
    expect(isPublicRequest("GET", "/")).toBe(true);
    expect(isPublicRequest("GET", "/_app/immutable/entry/start.js")).toBe(true);
    expect(isPublicRequest("GET", "/favicon.png")).toBe(true);
    expect(isPublicRequest("POST", "/api/session")).toBe(true);
  });

  test("protects the page, the data, the event stream, and every action", () => {
    for (const [method, path] of [
      ["GET", "/__data.json"],
      ["GET", "/anything-else"],
      ["GET", "/api/items"],
      ["GET", "/events"],
      ["POST", "/api/ack"],
      ["POST", "/api/open-review-terminal"],
      ["GET", "/api/session"],
    ]) {
      expect(isPublicRequest(method, path)).toBe(false);
    }
  });

  test("shows the locked page only for page loads", () => {
    expect(wantsLockedPage("GET", "/")).toBe(true);
    expect(wantsLockedPage("GET", "/api/items")).toBe(false);
    expect(wantsLockedPage("GET", "/events")).toBe(false);
    expect(wantsLockedPage("POST", "/")).toBe(false);
  });
});

describe("LoginCodes", () => {
  test("a code works once", () => {
    const codes = new LoginCodes();
    const code = codes.issue(0);
    expect(codes.redeem(code, 1)).toBe(true);
    expect(codes.redeem(code, 2)).toBe(false);
  });

  test("a code expires", () => {
    const codes = new LoginCodes();
    const code = codes.issue(0);
    expect(codes.redeem(code, LOGIN_CODE_TTL_MS + 1)).toBe(false);
  });

  test("unknown and non-string codes fail", () => {
    const codes = new LoginCodes();
    codes.issue(0);
    expect(codes.redeem("guess", 1)).toBe(false);
    expect(codes.redeem(undefined, 1)).toBe(false);
    expect(codes.redeem({ code: "x" }, 1)).toBe(false);
  });

  test("keeps a bounded number of outstanding codes", () => {
    const codes = new LoginCodes();
    const first = codes.issue(0);
    for (let index = 0; index < 20; index += 1) codes.issue(0);
    expect(codes.redeem(first, 1)).toBe(false);
  });
});
