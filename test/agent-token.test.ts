import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  agentCredentialsPath,
  bearerMatches,
  loadOrCreateAgentToken,
  newAgentToken,
  readAgentToken,
} from "../src/agent-token";

describe("bearerMatches", () => {
  const token = newAgentToken();

  test("accepts the exact bearer token", () => {
    expect(bearerMatches(token, `Bearer ${token}`)).toBe(true);
  });

  test("rejects a missing, malformed, or wrong token", () => {
    expect(bearerMatches(token, null)).toBe(false);
    expect(bearerMatches(token, token)).toBe(false);
    expect(bearerMatches(token, `Basic ${token}`)).toBe(false);
    expect(bearerMatches(token, `Bearer ${newAgentToken()}`)).toBe(false);
    expect(bearerMatches(token, `Bearer ${token}x`)).toBe(false);
    expect(bearerMatches(token, "Bearer ")).toBe(false);
  });

  test("rejects everything when the server has no token", () => {
    expect(bearerMatches(undefined, "Bearer ")).toBe(false);
    expect(bearerMatches("", "Bearer ")).toBe(false);
  });
});

describe("agent token file", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("lives beside the state file", () => {
    expect(agentCredentialsPath("/x/state/attn/state.json")).toBe("/x/state/attn/agent.json");
  });

  test("is created once, owner-only, and reused on the next start", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-agent-`);
    const path = `${dir}/nested/agent.json`;
    const first = await loadOrCreateAgentToken(path);
    expect(await loadOrCreateAgentToken(path)).toBe(first);
    expect(await readAgentToken(path)).toBe(first);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${dir}/nested`)).mode & 0o777).toBe(0o700);
  });

  test("two servers starting at once agree on one token", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-agent-`);
    const path = `${dir}/agent.json`;
    const tokens = await Promise.all([loadOrCreateAgentToken(path), loadOrCreateAgentToken(path)]);
    expect(tokens[0]).toBe(tokens[1]);
  });

  test("reads a missing, malformed, or short token as none", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-agent-`);
    expect(await readAgentToken(`${dir}/missing.json`)).toBeUndefined();
    await writeFile(`${dir}/bad.json`, "{not json");
    expect(await readAgentToken(`${dir}/bad.json`)).toBeUndefined();
    await writeFile(`${dir}/short.json`, JSON.stringify({ token: "abc" }));
    expect(await readAgentToken(`${dir}/short.json`)).toBeUndefined();
  });

  test("refuses to replace a corrupt file", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-agent-`);
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/agent.json`, "{not json");
    await expect(loadOrCreateAgentToken(`${dir}/agent.json`)).rejects.toThrow("delete it and restart attn");
  });
});
