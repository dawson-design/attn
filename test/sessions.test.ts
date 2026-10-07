import { describe, expect, test } from "bun:test";
import { SESSION_TTL_MS, SessionStore } from "../src/sessions";

describe("SessionStore", () => {
  test("each sign-in gets its own random session", () => {
    const sessions = new SessionStore();
    const first = sessions.create(0);
    const second = sessions.create(0);
    expect(first).not.toBe(second);
    expect(sessions.has(first, 1)).toBe(true);
    expect(sessions.has(second, 1)).toBe(true);
  });

  test("sessions expire", () => {
    const sessions = new SessionStore();
    const id = sessions.create(0);
    expect(sessions.has(id, SESSION_TTL_MS + 1)).toBe(false);
  });

  test("signout revokes every session", () => {
    const sessions = new SessionStore();
    const id = sessions.create(0);
    expect(sessions.revokeAll()).toBe(1);
    expect(sessions.has(id, 1)).toBe(false);
  });

  test("a new store, as after a restart, knows no session", () => {
    const id = new SessionStore().create(0);
    expect(new SessionStore().has(id, 1)).toBe(false);
  });

  test("unknown ids grant nothing", () => {
    const sessions = new SessionStore();
    expect(sessions.has(undefined)).toBe(false);
    expect(sessions.has("guess")).toBe(false);
  });

  test("keeps a bounded number of sessions, dropping the oldest", () => {
    const sessions = new SessionStore();
    const oldest = sessions.create(0);
    for (let index = 0; index < 50; index += 1) sessions.create(0);
    expect(sessions.has(oldest, 1)).toBe(false);
  });
});
