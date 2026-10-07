import { describe, expect, test } from "bun:test";
import { buildConfigFileContents, parseCliArgs, signInTrampoline } from "../src/cli/main";
import { parseEnvFile } from "../src/config-file";

describe("parseCliArgs", () => {
  test("picks the first bare word as the command", () => {
    expect(parseCliArgs(["init"])).toEqual({
      command: "init",
      force: false,
      help: false,
      json: false,
      print: false,
      unknown: [],
    });
  });

  test("recognizes --force and --help in any position", () => {
    expect(parseCliArgs(["--force", "init"])).toMatchObject({ command: "init", force: true });
    expect(parseCliArgs(["serve", "-h"])).toMatchObject({ command: "serve", help: true });
  });

  test("collects unknown flags and extra words instead of guessing", () => {
    expect(parseCliArgs(["init", "--verbose", "extra"]).unknown).toEqual(["--verbose", "extra"]);
  });

  test("recognizes --json", () => {
    expect(parseCliArgs(["status", "--json"])).toMatchObject({ command: "status", json: true, unknown: [] });
  });

  test("no arguments means no command", () => {
    expect(parseCliArgs([]).command).toBeUndefined();
  });
});

describe("buildConfigFileContents", () => {
  test("round-trips through parseEnvFile exactly as loadConfig will read it", () => {
    const parsed = parseEnvFile(buildConfigFileContents("ghe.example.com", "/Users/someone/work"));
    expect(parsed).toEqual({
      ATTN_HOST: "ghe.example.com",
      ATTN_CHECKOUT_ROOTS: "/Users/someone/work",
    });
  });

  test("omits checkout roots when the user skipped them", () => {
    const parsed = parseEnvFile(buildConfigFileContents("github.com", ""));
    expect(parsed).toEqual({ ATTN_HOST: "github.com" });
  });
});

describe("signInTrampoline", () => {
  test("forwards to the sign-in link without putting it anywhere but the file", () => {
    const html = signInTrampoline("http://127.0.0.1:8765/#code=abc_DEF-1");
    expect(html).toContain('content="0;url=http://127.0.0.1:8765/#code=abc_DEF-1"');
    expect(html).toContain('location.replace("http://127.0.0.1:8765/#code=abc_DEF-1")');
  });

  test("escapes the link for the attribute and the script", () => {
    const html = signInTrampoline('http://x/"></script><b>');
    expect(html).toContain('url=http://x/&quot;>&lt;/script>&lt;b>"');
    expect(html).toContain('location.replace("http://x/\\"\\u003e\\u003c/script\\u003e\\u003cb\\u003e")');
  });
});
