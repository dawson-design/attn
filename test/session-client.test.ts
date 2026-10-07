import { describe, expect, test } from "bun:test";
import { parseServerEvents } from "../src/lib/session-client";

describe("parseServerEvents", () => {
  test("returns complete events and keeps a partial one for the next chunk", () => {
    const first = parseServerEvents('event: snapshot\ndata: {"a":1}\n\nevent: snapshot\ndata: {"b"');
    expect(first.events).toEqual([{ event: "snapshot", data: '{"a":1}' }]);
    const second = parseServerEvents(`${first.rest}:2}\n\n`);
    expect(second.events).toEqual([{ event: "snapshot", data: '{"b":2}' }]);
    expect(second.rest).toBe("");
  });

  test("joins multi-line data and ignores comments and empty blocks", () => {
    const { events } = parseServerEvents(": keepalive\n\ndata: one\ndata: two\n\n");
    expect(events).toEqual([{ event: "message", data: "one\ntwo" }]);
  });
});
