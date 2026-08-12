import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfigFileEnv, parseEnvFile } from "../src/config-file";

describe("parseEnvFile", () => {
  test("parses simple assignments and trims whitespace", () => {
    expect(parseEnvFile("GHE_WATCH_HOST=ghe.example.com\n  GHE_WATCH_PORT = 9000 \n")).toEqual({
      GHE_WATCH_HOST: "ghe.example.com",
      GHE_WATCH_PORT: "9000",
    });
  });

  test("ignores comments and blank lines", () => {
    const contents = "# a comment\n\nGHE_WATCH_HOST=ghe.example.com\n  # indented comment\n";
    expect(parseEnvFile(contents)).toEqual({ GHE_WATCH_HOST: "ghe.example.com" });
  });

  test("accepts an export prefix", () => {
    expect(parseEnvFile("export GHE_WATCH_HOST=ghe.example.com")).toEqual({
      GHE_WATCH_HOST: "ghe.example.com",
    });
  });

  test("last assignment wins, matching gw_env_file_value in scripts/lib.sh", () => {
    expect(parseEnvFile("GHE_WATCH_HOST=first\nGHE_WATCH_HOST=second")).toEqual({
      GHE_WATCH_HOST: "second",
    });
  });

  test("strips exactly one layer of paired quotes", () => {
    const contents = ['A="double quoted"', "B='single quoted'", `C="'nested'"`, 'D="unpaired'].join("\n");
    expect(parseEnvFile(contents)).toEqual({
      A: "double quoted",
      B: "single quoted",
      C: "'nested'",
      D: '"unpaired',
    });
  });

  test("keeps everything after the first equals sign", () => {
    expect(parseEnvFile('GHE_WATCH_REPO_PATH_MAP={"acme/api": "/x=y"}')).toEqual({
      GHE_WATCH_REPO_PATH_MAP: '{"acme/api": "/x=y"}',
    });
  });

  test("skips malformed lines without failing", () => {
    expect(parseEnvFile("not a var\n=nokey\n1BAD=value\nGOOD=yes")).toEqual({ GOOD: "yes" });
  });
});

describe("loadConfigFileEnv", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("reads an existing file", async () => {
    dir = await mkdtemp(`${tmpdir()}/ghe-config-file-`);
    const file = `${dir}/env`;
    await writeFile(file, "GHE_WATCH_HOST=ghe.example.com\n");
    expect(loadConfigFileEnv(file)).toEqual({ GHE_WATCH_HOST: "ghe.example.com" });
  });

  test("returns empty for a missing file or no path", () => {
    expect(loadConfigFileEnv("/no/such/dir/env")).toEqual({});
    expect(loadConfigFileEnv(undefined)).toEqual({});
  });
});
