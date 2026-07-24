import { describe, expect, test } from "bun:test";
import { isDependencyBotItem } from "../src/actors";

describe("isDependencyBotItem", () => {
  test("matches dependabot actor spellings", () => {
    expect(isDependencyBotItem({ actor: "dependabot[bot]", labels: [] })).toBe(true);
    expect(isDependencyBotItem({ actor: "dependabot", labels: [] })).toBe(true);
    expect(isDependencyBotItem({ actor: "app/dependabot", labels: [] })).toBe(true);
  });

  test("matches the dependencies label regardless of actor or case", () => {
    expect(isDependencyBotItem({ actor: "engineer", labels: ["dependencies"] })).toBe(true);
    expect(isDependencyBotItem({ actor: "engineer", labels: ["Dependencies"] })).toBe(true);
  });

  test("does not match ordinary authors", () => {
    expect(isDependencyBotItem({ actor: "octo", labels: ["Platform"] })).toBe(false);
  });
});
