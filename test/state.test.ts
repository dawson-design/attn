import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledge, emptyState, loadState, reconcileItems, unacknowledge } from "../src/state";
import type { WatchItem } from "../src/types";

function item(updatedAt: string): WatchItem {
  return {
    id: "acme/schemas#35:pr_review_request",
    kind: "pr_review_request",
    lifecycle: "new",
    repo: "acme/schemas",
    repoName: "schemas",
    number: 35,
    title: "Removed the shared build config",
    actor: "engineer",
    url: "https://ghe.example.com/acme/schemas/pull/35",
    createdAt: "2026-06-01T20:00:00Z",
    updatedAt,
    firstSeenAt: "",
    lastSeenAt: "",
    isDraft: false,
    labels: ["Platform"],
    summary: "Removed the shared build config.",
  };
}

describe("acknowledge", () => {
  test("ignores prototype-polluting ids", () => {
    // A crafted id like "__proto__" is truthy via the prototype chain; guarding
    // with hasOwn keeps the write off Object.prototype.
    const state = emptyState();
    acknowledge(state, ["__proto__", "constructor"], "2099-01-01T00:00:00Z");
    expect(({} as Record<string, unknown>).acknowledgedAt).toBeUndefined();
    expect(Object.hasOwn(state.items, "__proto__")).toBe(false);
  });

  test("acknowledges and unacknowledges real ids", () => {
    const state = emptyState();
    reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:01:00Z");
    const id = "acme/schemas#35:pr_review_request";
    acknowledge(state, [id], "2026-06-02T00:00:00Z");
    expect(state.items[id].acknowledgedAt).toBe("2026-06-02T00:00:00Z");
    unacknowledge(state, [id]);
    expect(state.items[id].acknowledgedAt).toBeUndefined();
  });
});

describe("item lifecycle", () => {
  test("keeps locally seen unacknowledged items active until GitHub-derived queries stop returning them", () => {
    const state = emptyState();
    const first = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:01:00Z");
    expect(first[0].lifecycle).toBe("new");

    const second = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:03:00Z");
    expect(second[0].lifecycle).toBe("active");
    expect(state.items[first[0].id]).toBeDefined();
  });

  test("marks locally acknowledged items as acknowledged until GitHub updates them", () => {
    const state = emptyState();
    const first = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:01:00Z");
    expect(first[0].lifecycle).toBe("new");

    acknowledge(state, [first[0].id], "2026-06-01T20:02:00Z");
    const second = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:03:00Z");
    expect(second[0].lifecycle).toBe("acknowledged");
    expect(state.items[first[0].id]).toBeDefined();

    // Un-acknowledging clears the flag, so the item returns to an active state.
    unacknowledge(state, [first[0].id]);
    expect(state.items[first[0].id]?.acknowledgedAt).toBeUndefined();
    const third = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:04:00Z");
    expect(third[0].lifecycle).toBe("active");

    const updated = reconcileItems(state, [item("2026-06-01T20:05:00Z")], "2026-06-01T20:06:00Z");
    expect(updated[0].lifecycle).toBe("unread");
  });

  test("acknowledges an item updated in the same second as the ack (mixed precision)", () => {
    const state = emptyState();
    // GitHub updatedAt has no milliseconds; our acknowledgedAt does. A string
    // compare misorders them within the same second.
    const first = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:00:00.100Z");
    acknowledge(state, [first[0].id], "2026-06-01T20:00:00.500Z");

    const second = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:00:01.000Z");
    expect(second[0].lifecycle).toBe("acknowledged");
  });

  test("drops items GitHub no longer returns", () => {
    const state = emptyState();
    const first = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:01:00Z");
    reconcileItems(state, [], "2026-06-01T20:04:00Z");

    expect(state.items[first[0].id]).toBeUndefined();
  });

  test("a partial fetch must not erase acks for items it failed to return", () => {
    const state = emptyState();
    const first = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:01:00Z");
    acknowledge(state, [first[0].id], "2026-06-01T20:02:00Z");

    // Simulates a search that errored with no cached fallback: it returns []
    // even though the item is still open on GitHub.
    reconcileItems(state, [], "2026-06-01T20:04:00Z", { dropMissing: false });
    expect(state.items[first[0].id]?.acknowledgedAt).toBe("2026-06-01T20:02:00Z");

    // When the fetch recovers, the item is still acknowledged, not "new".
    const recovered = reconcileItems(state, [item("2026-06-01T20:00:00Z")], "2026-06-01T20:06:00Z");
    expect(recovered[0].lifecycle).toBe("acknowledged");
  });
});

describe("loadState", () => {
  test("returns empty state when the file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghe-state-"));
    const loaded = await loadState(join(dir, "does-not-exist.json"));
    expect(loaded.items).toEqual({});
  });

  test("preserves corrupt state in a backup rather than silently overwriting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghe-state-"));
    const path = join(dir, "state.json");
    await writeFile(path, "{ this is not json");

    const loaded = await loadState(path);

    expect(loaded.items).toEqual({});
    // The bad content must remain recoverable, not be discarded.
    expect(await readFile(`${path}.corrupt`, "utf8")).toBe("{ this is not json");
  });
});
