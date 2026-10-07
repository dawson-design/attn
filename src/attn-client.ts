// The MCP server's view of the running dashboard. `attn mcp` never runs the
// fetch pipeline itself: it proxies to the server over loopback, so the server
// stays the only writer of state.json.
import { readAgentCredentials } from "../agent-token";
import type { Snapshot } from "../types";

export interface AttnApi {
  items(): Promise<Snapshot>;
  acknowledge(ids: string[], acknowledged: boolean): Promise<void>;
  reviewPrompt(id: string): Promise<string>;
  refresh(): Promise<Snapshot>;
}

export class AttnNotRunningError extends Error {
  constructor() {
    super("attn is not running. Start it with `brew services start attn`, or `attn serve` in a terminal.");
  }
}

// Reads agent.json on every call, so a server restart (new port or token) is
// picked up without restarting the MCP client.
export function httpAttnApi(credentialsPath: string, fetchImpl: typeof fetch = fetch): AttnApi {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const credentials = await readAgentCredentials(credentialsPath);
    if (!credentials) throw new AttnNotRunningError();
    let response: Response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${credentials.port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new AttnNotRunningError();
    }
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
    refresh: () => call<Snapshot>("POST", "/api/refresh"),
  };
}
