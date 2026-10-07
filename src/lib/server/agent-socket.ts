// The agent API: a small HTTP API on a Unix socket in the owner-only state
// directory, used by `attn mcp`, `attn open`, and `attn signout`
// (attn-client.ts is the client).
//
// The directory is mode 0700, so only this user's processes can connect, and
// only this user's processes can create the socket, so a client that connects
// has reached this user's attn. No token is needed in either direction, and
// none can leak to a program that took attn's TCP port.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmod, rm } from "node:fs/promises";
import type { Snapshot } from "../../types";

export interface AgentBackend {
  items(): Promise<Snapshot>;
  acknowledge(ids: string[], acknowledged: boolean): Promise<void>;
  reviewPrompt(id: string): Promise<string>;
  refresh(): Promise<Snapshot>;
  // A one-time browser sign-in link for the dashboard.
  signInUrl(): string;
  signOut(): Promise<number>;
}

export interface AgentResponse {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 1_000_000;

// Only an array of string ids is accepted; a non-array would throw in the
// service and an unbounded one is a cheap DoS. Unknown ids are ignored there.
export function ackIds(body: { ids?: unknown }): string[] {
  return Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 1000) : [];
}

export async function routeAgentRequest(
  backend: AgentBackend,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<AgentResponse> {
  const route = `${method} ${path}`;
  switch (route) {
    case "GET /items":
      return { status: 200, body: await backend.items() };
    case "POST /ack":
      await backend.acknowledge(ackIds(body), body.acknowledged !== false);
      return { status: 200, body: { ok: true } };
    case "POST /review-prompt":
      if (typeof body.id !== "string") return { status: 400, body: { error: "Missing notification item id." } };
      return { status: 200, body: { prompt: await backend.reviewPrompt(body.id) } };
    case "POST /refresh":
      return { status: 200, body: await backend.refresh() };
    case "POST /sign-in":
      return { status: 200, body: { url: backend.signInUrl() } };
    case "POST /signout":
      return { status: 200, body: { revoked: await backend.signOut() } };
    default:
      return { status: 404, body: { error: `No agent route ${route}.` } };
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > MAX_BODY_BYTES) throw new Error("Request body is too large.");
  }
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

async function respond(backend: AgentBackend, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let result: AgentResponse;
  try {
    const path = new URL(request.url ?? "/", "http://attn").pathname;
    result = await routeAgentRequest(backend, request.method ?? "GET", path, await readBody(request));
  } catch (error) {
    result = { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  response.writeHead(result.status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result.body));
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

// macOS limits a Unix socket path to 104 bytes, including the final NUL.
const MAX_SOCKET_PATH_BYTES = 103;

export async function listenAgentSocket(path: string, backend: AgentBackend): Promise<Server> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `attn's socket path is longer than macOS allows (${MAX_SOCKET_PATH_BYTES} bytes): ${path}. ` +
        "Move attn's state directory to a shorter path with XDG_STATE_HOME or ATTN_STATE_FILE.",
    );
  }
  // A socket file left by a server that crashed refuses connections and can
  // go. One that answers belongs to a running attn, which must keep it.
  if (await socketIsLive(path)) throw new Error(`Another attn server is already running (it answers on ${path}).`);
  await rm(path, { force: true });
  const server = createServer((request, response) => void respond(backend, request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return server;
}

export async function closeAgentSocket(server: Server, path: string): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(path, { force: true });
}
