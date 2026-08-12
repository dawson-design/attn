// Where the app keeps its files, resolved once per process by loadConfig().
//
// Two modes, selected by GHE_WATCH_HOME (set by the packaged `ghe-watch`
// wrapper, never by the dev flow):
//
// - dev (GHE_WATCH_HOME unset): everything lives in the checkout, relative to
//   cwd — exactly the historical behavior. Config comes from `${cwd}/.env` via
//   Bun's auto-load, so no config file path is returned.
// - installed (GHE_WATCH_HOME set): the process runs from a read-only package
//   (e.g. Homebrew libexec) with an arbitrary cwd, so paths move to
//   XDG-conventional user dirs and config is an env-format file the app reads
//   itself at startup.
//
// Pure: callers inject env/homedir/cwd so tests can exercise both modes.

export interface AppPaths {
  mode: "dev" | "installed";
  // Directory for user-editable config (installed mode); review.md overrides
  // live here too. Unused in dev mode.
  configDir?: string;
  // Env-format config file loaded by loadConfig(). Undefined in dev mode,
  // where Bun's `.env` auto-load already populates process.env.
  configFile?: string;
  stateFile: string;
  snapshotFile: string;
  cacheFile: string;
  reviewPromptFile: string;
  workspaceDefault: string;
}

export function resolveAppPaths(env: Record<string, string | undefined>, homedir: string, cwd: string): AppPaths {
  if (!env.GHE_WATCH_HOME?.trim()) {
    const stateDir = `${cwd}/.local-state/ghe-notification-watch`;
    return {
      mode: "dev",
      stateFile: `${stateDir}/state.json`,
      snapshotFile: `${stateDir}/snapshot.json`,
      cacheFile: `${stateDir}/github-cache.json`,
      reviewPromptFile: `${cwd}/prompts/review.md`,
      workspaceDefault: cwd,
    };
  }

  const configDir = `${env.XDG_CONFIG_HOME?.trim() || `${homedir}/.config`}/ghe-watch`;
  const stateDir = `${env.XDG_STATE_HOME?.trim() || `${homedir}/.local/state`}/ghe-watch`;
  return {
    mode: "installed",
    configDir,
    configFile: `${configDir}/env`,
    stateFile: `${stateDir}/state.json`,
    snapshotFile: `${stateDir}/snapshot.json`,
    cacheFile: `${stateDir}/github-cache.json`,
    reviewPromptFile: `${configDir}/review.md`,
    workspaceDefault: homedir,
  };
}
