import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { DEFAULT_REVIEW_PROMPT } from "../src/review-prompt";

// loadConfig reads process.env, which Bun pre-populates from the developer's
// local .env — so these tests save and clear every ATTN_*/XDG_* variable
// to run against a known-empty environment, and restore them afterwards.
const ENV_PREFIXES = ["ATTN_", "XDG_"];
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
// at <config>/attn/env, so loadConfig() reads it like a real install.
async function installedModeDir(configFileContents?: string): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/ghe-installed-`);
  process.env.ATTN_HOME = `${dir}/libexec`;
  process.env.XDG_CONFIG_HOME = `${dir}/config`;
  process.env.XDG_STATE_HOME = `${dir}/state`;
  if (configFileContents !== undefined) {
    await mkdir(`${dir}/config/attn`, { recursive: true });
    await writeFile(`${dir}/config/attn/env`, configFileContents);
  }
  return dir;
}

describe("loadConfig", () => {
  test("maps the terminal app from the environment", () => {
    process.env.ATTN_TERMINAL_APP = "Ghostty";
    expect(loadConfig().terminalApp).toBe("Ghostty");
  });

  test("leaves the terminal app unset when the env var is empty", () => {
    process.env.ATTN_TERMINAL_APP = "  ";
    expect(loadConfig().terminalApp).toBeUndefined();
  });

  test("loads the review prompt template from the configured file", async () => {
    const dir = await mkdtemp(`${tmpdir()}/ghe-config-`);
    const file = `${dir}/prompt.md`;
    try {
      await writeFile(file, "Custom review for {{repo}}");
      process.env.ATTN_REVIEW_PROMPT_FILE = file;
      expect(loadConfig().reviewPromptTemplate).toBe("Custom review for {{repo}}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the default template when the file is missing", () => {
    process.env.ATTN_REVIEW_PROMPT_FILE = "/no/such/prompt.md";
    expect(loadConfig().reviewPromptTemplate).toBe(DEFAULT_REVIEW_PROMPT);
  });

  test("maps host and exact repo allowlist from the environment", () => {
    process.env.ATTN_HOST = "ghe.example.com";
    process.env.ATTN_REPOS = "acme/api, acme/web ,";
    const config = loadConfig();
    expect(config.host).toBe("ghe.example.com");
    expect(config.repos).toEqual(["acme/api", "acme/web"]);
  });

  test("dev mode keeps state under the cwd and scans the workspace for checkouts", () => {
    const config = loadConfig();
    expect(config.stateFile).toBe(`${process.cwd()}/.local-state/attn/state.json`);
    expect(config.checkoutRoots).toEqual([process.cwd()]);
  });

  test("parses the Host-header allowlist from the environment", () => {
    process.env.ATTN_ALLOWED_HOSTS = "proxy.internal, dashboard.local ,";
    expect(loadConfig().allowedHosts).toEqual(["proxy.internal", "dashboard.local"]);
    delete process.env.ATTN_ALLOWED_HOSTS;
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
    dir = await installedModeDir("ATTN_HOST=ghe.example.com\nATTN_ALLOWED_HOSTS=proxy.internal\n");
    const config = loadConfig();
    expect(config.host).toBe("ghe.example.com");
    expect(config.allowedHosts).toEqual(["proxy.internal"]);
    expect(config.stateFile).toBe(`${dir}/state/attn/state.json`);
    expect(config.snapshotFile).toBe(`${dir}/state/attn/snapshot.json`);
    expect(config.cacheFile).toBe(`${dir}/state/attn/github-cache.json`);
  });

  test("process env beats the config file, which beats the default", async () => {
    dir = await installedModeDir("ATTN_HOST=from-file.example.com\n");
    process.env.ATTN_HOST = "from-env.example.com";
    expect(loadConfig().host).toBe("from-env.example.com");

    delete process.env.ATTN_HOST;
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
    await writeFile(`${dir}/config/attn/review.md`, "Installed review for {{repo}}");
    expect(loadConfig().reviewPromptTemplate).toBe("Installed review for {{repo}}");
  });
});
