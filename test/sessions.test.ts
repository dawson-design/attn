import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SESSION_TTL_MS, SessionStore, sessionsPath } from "../src/sessions";

describe("SessionStore", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function store(): Promise<{ path: string; sessions: SessionStore }> {
    dir = await mkdtemp(`${tmpdir()}/attn-sessions-`);
    const path = sessionsPath(`${dir}/state.json`);
    return { path, sessions: await SessionStore.load(path) };
  }

  test("each sign-in gets its own session, and only a hash is stored", async () => {
    const { path, sessions } = await store();
    const first = await sessions.create(0);
    const second = await sessions.create(0);
    expect(first).not.toBe(second);
    expect(sessions.has(first, 1)).toBe(true);
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("sessions survive a restart", async () => {
    const { path, sessions } = await store();
    const id = await sessions.create(0);
    expect((await SessionStore.load(path)).has(id, 1)).toBe(true);
  });

  test("sessions expire", async () => {
    const { sessions } = await store();
    const id = await sessions.create(0);
    expect(sessions.has(id, SESSION_TTL_MS + 1)).toBe(false);
  });

  test("signout revokes every session, including after a restart", async () => {
    const { path, sessions } = await store();
    const id = await sessions.create(0);
    expect(await sessions.revokeAll()).toBe(1);
    expect(sessions.has(id, 1)).toBe(false);
    expect((await SessionStore.load(path)).has(id, 1)).toBe(false);
  });

  test("unknown ids and an unreadable file grant nothing", async () => {
    const { path, sessions } = await store();
    expect(sessions.has(undefined)).toBe(false);
    expect(sessions.has("guess")).toBe(false);
    await writeFile(path, "{not json");
    expect((await SessionStore.load(path)).has("guess")).toBe(false);
  });
});
