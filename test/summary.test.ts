import { describe, expect, test } from "bun:test";
import { summarize } from "../src/summary";

describe("summarize", () => {
  test("uses the first sentence of the body when it is a reasonable length", () => {
    expect(
      summarize({ title: "Add retry", body: "Adds a retry around the publish call. More detail follows here." }),
    ).toBe("Adds a retry around the publish call.");
  });

  test("falls back to the title (with a period) when the body is too short or absent", () => {
    expect(summarize({ title: "Bump deps", body: "wip" })).toBe("Bump deps.");
    expect(summarize({ title: "Bump deps." })).toBe("Bump deps.");
  });

  test("collapses whitespace in the body", () => {
    expect(summarize({ title: "x", body: "First   sentence   spread\nacross lines here." })).toBe(
      "First sentence spread across lines here.",
    );
  });
});
