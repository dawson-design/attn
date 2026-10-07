import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  agentCredentialsPath,
  bearerMatches,
  newAgentToken,
  readAgentCredentials,
  writeAgentCredentials,
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

describe("agent credentials file", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("lives beside the state file", () => {
    expect(agentCredentialsPath("/x/state/attn/state.json")).toBe("/x/state/attn/agent.json");
  });

  test("round-trips and is readable only by the owner", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-agent-`);
    const path = `${dir}/nested/agent.json`;
    await writeAgentCredentials(path, { port: 8765, token: "abc" });
    expect(await readAgentCredentials(path)).toEqual({ port: 8765, token: "abc" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("reads a missing or malformed file as no credentials", async () => {
    dir = await mkdtemp(`${tmpdir()}/attn-agent-`);
    expect(await readAgentCredentials(`${dir}/missing.json`)).toBeUndefined();
    await writeFile(`${dir}/bad.json`, "{not json");
    expect(await readAgentCredentials(`${dir}/bad.json`)).toBeUndefined();
    await writeFile(`${dir}/partial.json`, JSON.stringify({ port: "8765", token: "abc" }));
    expect(await readAgentCredentials(`${dir}/partial.json`)).toBeUndefined();
  });
});
