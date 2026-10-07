import { readFile } from "node:fs/promises";
import { writePrivateFile } from "./private-file";
import type { Snapshot } from "./types";

export async function loadSnapshot(path: string): Promise<Snapshot | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Snapshot;
  } catch {
    return undefined;
  }
}

export async function saveSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  await writePrivateFile(path, JSON.stringify(snapshot, null, 2) + "\n");
}
