import { describe, expect, test } from "bun:test";
import { assertReadOnlyGhArgs } from "../src/gh";

describe("read-only gh allowlist", () => {
  test("allows read-only search and view commands", () => {
    expect(() => assertReadOnlyGhArgs(["search", "prs", "--review-requested", "@me"])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(["pr", "view", "123", "--repo", "acme/api"])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/acme/example/issues"])).not.toThrow();
  });

  test("rejects GitHub mutation commands", () => {
    expect(() => assertReadOnlyGhArgs(["pr", "review", "123", "--approve"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["pr", "merge", "123"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["issue", "edit", "123"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "-X", "POST", "repos/acme/example/issues"])).toThrow();
  });

  test("rejects gh api requests that implicitly become writes", () => {
    // Field flags flip `gh api` from GET to POST without an explicit -X.
    expect(() => assertReadOnlyGhArgs(["api", "repos/acme/example/issues", "-f", "title=hi"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/x", "--field", "title=hi"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/x", "--raw-field=title=hi"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/x", "-F", "n=1"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/x", "--input", "body.json"])).toThrow();
    // graphql can carry mutations.
    expect(() => assertReadOnlyGhArgs(["api", "graphql", "-f", "query=mutation{}"])).toThrow();
    // Method passed via = or attached short flag must also be caught.
    expect(() => assertReadOnlyGhArgs(["api", "--method=POST", "repos/x"])).toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "-XDELETE", "repos/x"])).toThrow();
  });

  test("still allows explicit and implicit GET api reads", () => {
    expect(() => assertReadOnlyGhArgs(["api", "repos/x"])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/x", "-X", "GET"])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/x", "--method=GET", "-H", "Accept: x"])).not.toThrow();
  });
});
