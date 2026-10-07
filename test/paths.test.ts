import { describe, expect, test } from "bun:test";
import { resolveAppPaths } from "../src/paths";

const HOME = "/Users/someone";
const CWD = "/Users/someone/src/attn";

describe("resolveAppPaths", () => {
  test("dev mode (no ATTN_HOME) keeps the historical cwd-relative layout", () => {
    const paths = resolveAppPaths({}, HOME, CWD);
    expect(paths.mode).toBe("dev");
    expect(paths.configFile).toBeUndefined();
    expect(paths.stateFile).toBe(`${CWD}/.local-state/attn/state.json`);
    expect(paths.snapshotFile).toBe(`${CWD}/.local-state/attn/snapshot.json`);
    expect(paths.cacheFile).toBe(`${CWD}/.local-state/attn/github-cache.json`);
    expect(paths.reviewPromptFile).toBe(`${CWD}/prompts/review.md`);
    expect(paths.workspaceDefault).toBe(CWD);
  });

  test("a blank ATTN_HOME still counts as dev mode", () => {
    expect(resolveAppPaths({ ATTN_HOME: "  " }, HOME, CWD).mode).toBe("dev");
  });

  test("installed mode uses XDG-conventional user dirs, independent of cwd", () => {
    const paths = resolveAppPaths({ ATTN_HOME: "/opt/attn/libexec" }, HOME, "/");
    expect(paths.mode).toBe("installed");
    expect(paths.configDir).toBe(`${HOME}/.config/attn`);
    expect(paths.configFile).toBe(`${HOME}/.config/attn/env`);
    expect(paths.stateFile).toBe(`${HOME}/.local/state/attn/state.json`);
    expect(paths.snapshotFile).toBe(`${HOME}/.local/state/attn/snapshot.json`);
    expect(paths.cacheFile).toBe(`${HOME}/.local/state/attn/github-cache.json`);
    expect(paths.reviewPromptFile).toBe(`${HOME}/.config/attn/review.md`);
    expect(paths.workspaceDefault).toBe(HOME);
  });

  test("installed mode honors XDG_CONFIG_HOME and XDG_STATE_HOME", () => {
    const paths = resolveAppPaths(
      {
        ATTN_HOME: "/opt/attn/libexec",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_STATE_HOME: "/custom/state",
      },
      HOME,
      "/",
    );
    expect(paths.configFile).toBe("/custom/config/attn/env");
    expect(paths.stateFile).toBe("/custom/state/attn/state.json");
    expect(paths.reviewPromptFile).toBe("/custom/config/attn/review.md");
  });
});
