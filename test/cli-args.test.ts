import { describe, expect, test } from "bun:test";
import { buildConfigFileContents, parseCliArgs } from "../src/cli/main";
import { parseEnvFile } from "../src/config-file";

describe("parseCliArgs", () => {
  test("picks the first bare word as the command", () => {
    expect(parseCliArgs(["init"])).toEqual({ command: "init", force: false, help: false, unknown: [] });
  });

  test("recognizes --force and --help in any position", () => {
    expect(parseCliArgs(["--force", "init"])).toMatchObject({ command: "init", force: true });
    expect(parseCliArgs(["serve", "-h"])).toMatchObject({ command: "serve", help: true });
  });

  test("collects unknown flags and extra words instead of guessing", () => {
    expect(parseCliArgs(["init", "--verbose", "extra"]).unknown).toEqual(["--verbose", "extra"]);
  });

  test("no arguments means no command", () => {
    expect(parseCliArgs([]).command).toBeUndefined();
  });
});

describe("buildConfigFileContents", () => {
  test("round-trips through parseEnvFile exactly as loadConfig will read it", () => {
    const parsed = parseEnvFile(buildConfigFileContents("ghe.example.com", "/Users/someone/work"));
    expect(parsed).toEqual({
      GHE_WATCH_HOST: "ghe.example.com",
      GHE_WATCH_CHECKOUT_ROOTS: "/Users/someone/work",
    });
  });

  test("omits checkout roots when the user skipped them", () => {
    const parsed = parseEnvFile(buildConfigFileContents("github.com", ""));
    expect(parsed).toEqual({ GHE_WATCH_HOST: "github.com" });
  });
});
