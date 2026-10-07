import { describe, expect, test } from "bun:test";
import { newAgentToken } from "../src/agent-token";
import {
  isAuthenticated,
  isPublicRequest,
  isValidNonce,
  LOGIN_CODE_TTL_MS,
  LoginCodes,
  serverProof,
  sessionCookieValue,
  wantsLockedPage,
} from "../src/auth";

const token = newAgentToken();

describe("isAuthenticated", () => {
  test("accepts the bearer token or the session cookie derived from it", () => {
    expect(isAuthenticated(token, `Bearer ${token}`, undefined)).toBe(true);
    expect(isAuthenticated(token, null, sessionCookieValue(token))).toBe(true);
  });

  test("rejects requests with no credential, whatever browser headers they claim", () => {
    // Sec-Fetch-Site and Origin are not inputs here: any local process can fake them.
    expect(isAuthenticated(token, null, undefined)).toBe(false);
  });

  test("rejects a cookie for another token and the raw token as a cookie", () => {
    expect(isAuthenticated(token, null, sessionCookieValue(newAgentToken()))).toBe(false);
    expect(isAuthenticated(token, null, token)).toBe(false);
  });
});

describe("public requests", () => {
  test("serves the app bundle, the proof check, and the code exchange without a credential", () => {
    expect(isPublicRequest("GET", "/_app/immutable/entry/start.js")).toBe(true);
    expect(isPublicRequest("GET", "/favicon.png")).toBe(true);
    expect(isPublicRequest("GET", "/api/agent-proof")).toBe(true);
    expect(isPublicRequest("POST", "/api/session")).toBe(true);
  });

  test("protects the page, the data, the event stream, and every action", () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/api/items"],
      ["GET", "/events"],
      ["POST", "/api/ack"],
      ["POST", "/api/open-review-terminal"],
      ["POST", "/api/login-code"],
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

describe("server proof", () => {
  test("depends on the token and the nonce", () => {
    const nonce = "a".repeat(32);
    expect(serverProof(token, nonce)).toBe(serverProof(token, nonce));
    expect(serverProof(newAgentToken(), nonce)).not.toBe(serverProof(token, nonce));
    expect(serverProof(token, "b".repeat(32))).not.toBe(serverProof(token, nonce));
  });

  test("accepts only well-formed nonces", () => {
    expect(isValidNonce("a".repeat(16))).toBe(true);
    expect(isValidNonce("short")).toBe(false);
    expect(isValidNonce(null)).toBe(false);
    expect(isValidNonce("a".repeat(15) + "/")).toBe(false);
  });
});
