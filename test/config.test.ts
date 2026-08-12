import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { DEFAULT_REVIEW_PROMPT } from "../src/review-prompt";

// loadConfig reads process.env, which Bun pre-populates from the developer's
// local .env — so these tests save and clear every GHE_WATCH_*/XDG_* variable
// to run against a known-empty environment, and restore them afterwards.
const ENV_PREFIXES = ["GHE_WATCH_", "XDG_"];
let savedEnv: Record<string, string> = {};

beforeEach(() => {
  savedEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) && value !== undefined) {
      savedEnv[key] = value;
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

// Point installed mode's XDG dirs at a temp dir, optionally with a config file
// at <config>/ghe-watch/env, so loadConfig() reads it like a real install.
async function installedModeDir(configFileContents?: string): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/ghe-installed-`);
  process.env.GHE_WATCH_HOME = `${dir}/libexec`;
  process.env.XDG_CONFIG_HOME = `${dir}/config`;
  process.env.XDG_STATE_HOME = `${dir}/state`;
  if (configFileContents !== undefined) {
    await mkdir(`${dir}/config/ghe-watch`, { recursive: true });
    await writeFile(`${dir}/config/ghe-watch/env`, configFileContents);
  }
  return dir;
}

describe("loadConfig", () => {
  test("maps the terminal app from the environment", () => {
    process.env.GHE_WATCH_TERMINAL_APP = "Ghostty";
    expect(loadConfig().terminalApp).toBe("Ghostty");
  });

  test("leaves the terminal app unset when the env var is empty", () => {
    process.env.GHE_WATCH_TERMINAL_APP = "  ";
    expect(loadConfig().terminalApp).toBeUndefined();
  });

  test("loads the review prompt template from the configured file", async () => {
    const dir = await mkdtemp(`${tmpdir()}/ghe-config-`);
    const file = `${dir}/prompt.md`;
    try {
      await writeFile(file, "Custom review for {{repo}}");
      process.env.GHE_WATCH_REVIEW_PROMPT_FILE = file;
      expect(loadConfig().reviewPromptTemplate).toBe("Custom review for {{repo}}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the default template when the file is missing", () => {
    process.env.GHE_WATCH_REVIEW_PROMPT_FILE = "/no/such/prompt.md";
    expect(loadConfig().reviewPromptTemplate).toBe(DEFAULT_REVIEW_PROMPT);
  });

  test("maps host and exact repo allowlist from the environment", () => {
    process.env.GHE_WATCH_HOST = "ghe.example.com";
    process.env.GHE_WATCH_REPOS = "acme/api, acme/web ,";
    const config = loadConfig();
    expect(config.host).toBe("ghe.example.com");
    expect(config.repos).toEqual(["acme/api", "acme/web"]);
  });

  test("dev mode keeps state under the cwd and scans the workspace for checkouts", () => {
    const config = loadConfig();
    expect(config.stateFile).toBe(`${process.cwd()}/.local-state/ghe-notification-watch/state.json`);
    expect(config.checkoutRoots).toEqual([process.cwd()]);
  });

  test("parses the Host-header allowlist from the environment", () => {
    process.env.GHE_WATCH_ALLOWED_HOSTS = "proxy.internal, dashboard.local ,";
    expect(loadConfig().allowedHosts).toEqual(["proxy.internal", "dashboard.local"]);
    delete process.env.GHE_WATCH_ALLOWED_HOSTS;
    expect(loadConfig().allowedHosts).toEqual([]);
  });
});

describe("loadConfig installed mode", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("reads values from the config file and defaults state to XDG dirs", async () => {
    dir = await installedModeDir("GHE_WATCH_HOST=ghe.example.com\nGHE_WATCH_ALLOWED_HOSTS=proxy.internal\n");
    const config = loadConfig();
    expect(config.host).toBe("ghe.example.com");
    expect(config.allowedHosts).toEqual(["proxy.internal"]);
    expect(config.stateFile).toBe(`${dir}/state/ghe-watch/state.json`);
    expect(config.snapshotFile).toBe(`${dir}/state/ghe-watch/snapshot.json`);
    expect(config.cacheFile).toBe(`${dir}/state/ghe-watch/github-cache.json`);
  });

  test("process env beats the config file, which beats the default", async () => {
    dir = await installedModeDir("GHE_WATCH_HOST=from-file.example.com\n");
    process.env.GHE_WATCH_HOST = "from-env.example.com";
    expect(loadConfig().host).toBe("from-env.example.com");

    delete process.env.GHE_WATCH_HOST;
    expect(loadConfig().host).toBe("from-file.example.com");
  });

  test("falls back to defaults when no config file exists", async () => {
    dir = await installedModeDir();
    const config = loadConfig();
    expect(config.host).toBe("github.com");
    expect(config.reviewPromptTemplate).toBe(DEFAULT_REVIEW_PROMPT);
  });

  test("does not scan any checkout roots by default", async () => {
    dir = await installedModeDir();
    expect(loadConfig().checkoutRoots).toEqual([]);
  });

  test("loads a user review prompt from the config dir when present", async () => {
    dir = await installedModeDir("");
    await writeFile(`${dir}/config/ghe-watch/review.md`, "Installed review for {{repo}}");
    expect(loadConfig().reviewPromptTemplate).toBe("Installed review for {{repo}}");
  });
});
