import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { summarizeStatus } from "../src/cli/main";
import { emptyState } from "../src/state";
import type { AppState, Snapshot, WatchItem } from "../src/types";

const MAIN = resolve(import.meta.dir, "../src/cli/main.ts");

function item(id: string, kind: WatchItem["kind"], updatedAt = "2026-10-01T00:00:00Z"): WatchItem {
  return {
    id,
    kind,
    lifecycle: "new",
    repo: "acme/api",
    repoName: "api",
    number: 1,
    title: "Title",
    actor: "someone",
    url: "https://github.com/acme/api/pull/1",
    createdAt: updatedAt,
    updatedAt,
    firstSeenAt: updatedAt,
    lastSeenAt: updatedAt,
    isDraft: false,
    labels: [],
    summary: "Title",
  };
}

function snapshot(host: string, items: WatchItem[]): Snapshot {
  return { generatedAt: "2026-10-02T00:00:00Z", host, items, errors: [], cacheStatus: "fresh" };
}

function ackedState(id: string): AppState {
  return {
    ...emptyState(),
    items: {
      [id]: {
        id,
        firstSeenAt: "2026-10-01T00:00:00Z",
        lastSeenAt: "2026-10-01T00:00:00Z",
        lastKnownUpdatedAt: "2026-10-01T00:00:00Z",
        acknowledgedAt: "2026-10-02T00:00:00Z",
      },
    },
  };
}

describe("summarizeStatus", () => {
  test("counts unacknowledged items per kind", () => {
    const snap = snapshot("github.com", [
      item("a", "pr_review_request"),
      item("b", "pr_review_request"),
      item("c", "issue_mention"),
    ]);
    const summary = summarizeStatus("github.com", snap, ackedState("b"));
    expect(summary.waiting).toBe(2);
    expect(summary.waitingByKind).toMatchObject({ pr_review_request: 1, issue_mention: 1, issue_assigned: 0 });
    expect(summary.cacheStatus).toBe("fresh");
  });

  test("reports nothing waiting before the first snapshot", () => {
    const summary = summarizeStatus("github.com", undefined, emptyState());
    expect(summary).toMatchObject({ waiting: 0, generatedAt: null, cacheStatus: null });
  });
});

describe("attn status --json", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function runStatus(snap: Snapshot): Promise<Record<string, unknown>> {
    dir = await mkdtemp(`${tmpdir()}/attn-status-`);
    await writeFile(`${dir}/snapshot.json`, JSON.stringify(snap));
    // cwd is the temp dir so Bun does not auto-load a developer's .env.
    const proc = Bun.spawnSync([process.execPath, MAIN, "status", "--json"], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        ATTN_HOST: "github.com",
        ATTN_SNAPSHOT_FILE: `${dir}/snapshot.json`,
        ATTN_STATE_FILE: `${dir}/state.json`,
        ATTN_CACHE_FILE: `${dir}/cache.json`,
      },
    });
    expect(proc.exitCode).toBe(0);
    return JSON.parse(proc.stdout.toString());
  }

  test("prints waiting counts from the snapshot", async () => {
    const output = await runStatus(snapshot("github.com", [item("a", "pr_review_request")]));
    expect(output).toMatchObject({ host: "github.com", waiting: 1, cacheStatus: "fresh" });
  });

  test("ignores a snapshot taken for a different host", async () => {
    const output = await runStatus(snapshot("ghe.example.com", [item("a", "pr_review_request")]));
    expect(output).toMatchObject({ host: "github.com", waiting: 0, cacheStatus: null });
  });
});
