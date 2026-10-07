// Client for the running attn server's agent API (lib/server/agent-socket.ts),
// used by `attn mcp`, `attn open`, and `attn signout`. It never runs the fetch
// pipeline itself, so the server stays the only writer of state.json.
//
// It talks over the Unix socket in the owner-only state directory, and checks
// that this user owns both before connecting, so it cannot be pointed at a
// socket another account made.
import { request } from "node:http";
import { lstat, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Snapshot } from "./types";

export function agentSocketPath(stateFile: string): string {
  return join(dirname(stateFile), "attn.sock");
}

export interface AttnApi {
  items(): Promise<Snapshot>;
  acknowledge(ids: string[], acknowledged: boolean): Promise<void>;
  reviewPrompt(id: string): Promise<string>;
  refresh(): Promise<Snapshot>;
}

export interface AttnClient extends AttnApi {
  signInUrl(): Promise<string>;
  signOutAll(): Promise<number>;
}

export class AttnNotRunningError extends Error {
  constructor() {
    super("attn is not running. Start it with `brew services start attn`, or `attn serve` in a terminal.");
  }
}

export class UntrustedSocketError extends Error {
  constructor(path: string, reason: string) {
    super(`attn did not connect to ${path}: ${reason}. attn's state directory must belong to you with mode 0700.`);
  }
}

const TIMEOUT_MS = 120_000;
// Bun reports a socket nobody listens on as FailedToOpenSocket, Node as ECONNREFUSED.
const NOT_RUNNING = new Set(["ENOENT", "ECONNREFUSED", "FailedToOpenSocket"]);

async function checkOwnership(path: string): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let socket;
  try {
    socket = await lstat(path);
  } catch {
    throw new AttnNotRunningError();
  }
  const dir = await stat(dirname(path));
  if (dir.uid !== uid || (dir.mode & 0o077) !== 0) throw new UntrustedSocketError(path, "its directory is not private");
  if (socket.uid !== uid || !socket.isSocket()) throw new UntrustedSocketError(path, "it is not your socket");
}

interface Reply {
  status: number;
  payload: unknown;
}

function send(path: string, method: "GET" | "POST", route: string, body?: unknown): Promise<Reply> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: path,
        method,
        path: route,
        timeout: TIMEOUT_MS,
        headers: data === undefined ? {} : { "Content-Type": "application/json" },
      },
      (incoming) => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => (text += chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch {
            payload = undefined;
          }
          resolve({ status: incoming.statusCode ?? 0, payload });
        });
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("attn did not answer within 120 seconds.")));
    outgoing.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code && NOT_RUNNING.has(error.code) ? new AttnNotRunningError() : error),
    );
    outgoing.end(data);
  });
}

export function socketAttnClient(path: string): AttnClient {
  async function call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    await checkOwnership(path);
    const { status, payload } = await send(path, method, route, body);
    if (status < 200 || status >= 300) {
      throw new Error(
        (payload as { error?: string } | undefined)?.error ?? `attn returned HTTP ${status} for ${route}`,
      );
    }
    return payload as T;
  }

  return {
    items: () => call<Snapshot>("GET", "/items"),
    acknowledge: async (ids, acknowledged) => {
      await call("POST", "/ack", { ids, acknowledged });
    },
    reviewPrompt: async (id) => (await call<{ prompt: string }>("POST", "/review-prompt", { id })).prompt,
    refresh: () => call<Snapshot>("POST", "/refresh"),
    signInUrl: async () => (await call<{ url: string }>("POST", "/sign-in")).url,
    signOutAll: async () => (await call<{ revoked: number }>("POST", "/signout")).revoked,
  };
}
