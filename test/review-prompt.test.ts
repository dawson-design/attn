import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { DEFAULT_REVIEW_PROMPT, loadReviewPromptTemplate, renderReviewPrompt } from "../src/review-prompt";

describe("renderReviewPrompt", () => {
  test("substitutes known placeholders", () => {
    const out = renderReviewPrompt("Review {{repo}} #{{number}} on {{base}}", {
      repo: "acme/api",
      number: "42",
      base: "main",
    });
    expect(out).toBe("Review acme/api #42 on main");
  });

  test("leaves unknown placeholders untouched", () => {
    expect(renderReviewPrompt("keep {{mystery}}", { repo: "x" })).toBe("keep {{mystery}}");
  });

  test("does not re-scan substituted values for placeholders", () => {
    // A value containing "{{repo}}" must not be expanded a second time.
    const out = renderReviewPrompt("{{setup}} then {{repo}}", {
      setup: "echo {{repo}}",
      repo: "acme/api",
    });
    expect(out).toBe("echo {{repo}} then acme/api");
  });
});

describe("loadReviewPromptTemplate", () => {
  test("returns file contents when the file exists", async () => {
    const dir = await mkdtemp(`${tmpdir()}/ghe-prompt-`);
    const file = `${dir}/custom.md`;
    try {
      await writeFile(file, "Custom prompt for {{repo}}");
      expect(loadReviewPromptTemplate(file)).toBe("Custom prompt for {{repo}}");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the default when the file is missing", () => {
    expect(loadReviewPromptTemplate("/no/such/prompt.md")).toBe(DEFAULT_REVIEW_PROMPT);
  });

  test("falls back to the default when the file is empty", async () => {
    const dir = await mkdtemp(`${tmpdir()}/ghe-prompt-`);
    const file = `${dir}/empty.md`;
    try {
      await writeFile(file, "   \n");
      expect(loadReviewPromptTemplate(file)).toBe(DEFAULT_REVIEW_PROMPT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the shipped default template exposes the documented placeholders", () => {
    for (const key of ["{{repo}}", "{{number}}", "{{base}}", "{{branch}}", "{{setup}}", "{{url}}"]) {
      expect(DEFAULT_REVIEW_PROMPT).toContain(key);
    }
  });
});
