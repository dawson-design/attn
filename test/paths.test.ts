import { describe, expect, test } from "bun:test";
import { resolveAppPaths } from "../src/paths";

const HOME = "/Users/someone";
const CWD = "/Users/someone/src/ghe-notification-watch";

describe("resolveAppPaths", () => {
  test("dev mode (no GHE_WATCH_HOME) keeps the historical cwd-relative layout", () => {
    const paths = resolveAppPaths({}, HOME, CWD);
    expect(paths.mode).toBe("dev");
    expect(paths.configFile).toBeUndefined();
    expect(paths.stateFile).toBe(`${CWD}/.local-state/ghe-notification-watch/state.json`);
    expect(paths.snapshotFile).toBe(`${CWD}/.local-state/ghe-notification-watch/snapshot.json`);
    expect(paths.cacheFile).toBe(`${CWD}/.local-state/ghe-notification-watch/github-cache.json`);
    expect(paths.reviewPromptFile).toBe(`${CWD}/prompts/review.md`);
    expect(paths.workspaceDefault).toBe(CWD);
  });

  test("a blank GHE_WATCH_HOME still counts as dev mode", () => {
    expect(resolveAppPaths({ GHE_WATCH_HOME: "  " }, HOME, CWD).mode).toBe("dev");
  });

  test("installed mode uses XDG-conventional user dirs, independent of cwd", () => {
    const paths = resolveAppPaths({ GHE_WATCH_HOME: "/opt/ghe-watch/libexec" }, HOME, "/");
    expect(paths.mode).toBe("installed");
    expect(paths.configDir).toBe(`${HOME}/.config/ghe-watch`);
    expect(paths.configFile).toBe(`${HOME}/.config/ghe-watch/env`);
    expect(paths.stateFile).toBe(`${HOME}/.local/state/ghe-watch/state.json`);
    expect(paths.snapshotFile).toBe(`${HOME}/.local/state/ghe-watch/snapshot.json`);
    expect(paths.cacheFile).toBe(`${HOME}/.local/state/ghe-watch/github-cache.json`);
    expect(paths.reviewPromptFile).toBe(`${HOME}/.config/ghe-watch/review.md`);
    expect(paths.workspaceDefault).toBe(HOME);
  });

  test("installed mode honors XDG_CONFIG_HOME and XDG_STATE_HOME", () => {
    const paths = resolveAppPaths(
      {
        GHE_WATCH_HOME: "/opt/ghe-watch/libexec",
        XDG_CONFIG_HOME: "/custom/config",
        XDG_STATE_HOME: "/custom/state",
      },
      HOME,
      "/",
    );
    expect(paths.configFile).toBe("/custom/config/ghe-watch/env");
    expect(paths.stateFile).toBe("/custom/state/ghe-watch/state.json");
    expect(paths.reviewPromptFile).toBe("/custom/config/ghe-watch/review.md");
  });
});
