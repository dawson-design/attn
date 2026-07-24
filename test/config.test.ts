import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { DEFAULT_REVIEW_PROMPT } from "../src/review-prompt";

const TOUCHED = ["GHE_WATCH_TERMINAL_APP", "GHE_WATCH_REVIEW_PROMPT_FILE", "GHE_WATCH_HOST", "GHE_WATCH_REPOS"];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

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
});
