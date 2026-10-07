// Client for the running attn server, used by `attn mcp` and `attn open`.
// It never runs the fetch pipeline itself, so the server stays the only writer
// of state.json.
//
// Before every call it checks the server proof (auth.ts): when attn is
// stopped, another local account can listen on the port, and that process must
// neither receive the token nor have its answers treated as attn's.
import { readAgentToken } from "./agent-token";
import { newNonce, serverProof } from "./auth";
import type { Snapshot } from "./types";

export interface AttnApi {
  items(): Promise<Snapshot>;
  acknowledge(ids: string[], acknowledged: boolean): Promise<void>;
  reviewPrompt(id: string): Promise<string>;
  refresh(): Promise<Snapshot>;
}

export interface AttnClient extends AttnApi {
  loginCode(): Promise<string>;
  signOutAll(): Promise<number>;
}

export class AttnNotRunningError extends Error {
  constructor() {
    super("attn is not running. Start it with `brew services start attn`, or `attn serve` in a terminal.");
  }
}

export class NotAttnError extends Error {
  constructor(port: number) {
    super(
      `Something other than attn is answering on 127.0.0.1:${port}, so attn did not send it your token. ` +
        `See what is listening with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`.`,
    );
  }
}

const TIMEOUT_MS = 120_000;

export function httpAttnClient(credentialsPath: string, port: number, fetchImpl: typeof fetch = fetch): AttnClient {
  const base = `http://127.0.0.1:${port}`;

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new AttnNotRunningError();
    }
  }

  async function verifyServer(token: string): Promise<void> {
    const nonce = newNonce();
    const response = await send(`/api/agent-proof?nonce=${nonce}`, { method: "GET" });
    const body = (await response.json().catch(() => undefined)) as { proof?: unknown } | undefined;
    if (!response.ok || body?.proof !== serverProof(token, nonce)) throw new NotAttnError(port);
  }

  // Reads agent.json on every call, so a rotated token is picked up without
  // restarting the MCP client.
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await readAgentToken(credentialsPath);
    if (!token) throw new AttnNotRunningError();
    await verifyServer(token);
    const response = await send(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    if (!response.ok) {
      throw new Error(payload?.error ?? `attn returned HTTP ${response.status} for ${path}`);
    }
    return payload as T;
  }

  return {
    items: () => call<Snapshot>("GET", "/api/items"),
    acknowledge: async (ids, acknowledged) => {
      await call("POST", "/api/ack", { ids, acknowledged });
    },
    reviewPrompt: async (id) => (await call<{ prompt: string }>("POST", "/api/review-prompt", { id })).prompt,
    refresh: () => call<Snapshot>("POST", "/api/refresh", { force: false }),
    loginCode: async () => (await call<{ code: string }>("POST", "/api/login-code")).code,
    signOutAll: async () => (await call<{ revoked: number }>("POST", "/api/signout")).revoked,
  };
}
