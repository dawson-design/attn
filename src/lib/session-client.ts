// Browser side of dashboard sign-in. The session token lives in this tab's
// sessionStorage and goes out only as an Authorization header that the page's
// own code adds. A new tab signs in with its own `attn open`.
//
// A cookie would not do. Cookies are scoped by host, not by port, and Chrome
// sends Secure cookies over plain http to *.localhost, so a page served by
// another account's program on any port of attn.localhost would receive one.
//
// localStorage would not do either. It is shared by every tab of the origin,
// including a tab still showing a page another account's program served
// while attn was stopped (after a click-through on the certificate warning).
// That tab could read every token stored later. sessionStorage is per tab.

const TOKEN_KEY = "attn:session";
const RETRY_MS = 3000;

export class SignedOutError extends Error {
  constructor() {
    super("Not signed in. Run `attn open`.");
  }
}

function readToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function hasSession(): boolean {
  return readToken() !== null;
}

export function forgetSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

// Trades a `#code=` from `attn open` for a session token. Returns false when
// the URL has no code; throws when the code is expired or used.
export async function signInFromHash(): Promise<boolean> {
  const match = location.hash.match(/^#code=([A-Za-z0-9_-]+)$/);
  if (!match) return false;
  history.replaceState(null, "", "/");
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: match[1] }),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) throw new Error(body.error || "Signing in failed. Run `attn open` again.");
  sessionStorage.setItem(TOKEN_KEY, body.token);
  return true;
}

// fetch() with the session token. A 401 means the session is gone (signed
// out, or the server restarted), so the token is dropped.
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = readToken();
  if (!token) throw new SignedOutError();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    forgetSession();
    throw new SignedOutError();
  }
  return response;
}

export interface ServerEvent {
  event: string;
  data: string;
}

// Splits a text/event-stream buffer into complete events and the unparsed
// rest. Only the `event:` and `data:` fields the server sends are read.
export function parseServerEvents(buffer: string): { events: ServerEvent[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    return data.length ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
}

export type StreamStatus = "connected" | "disconnected" | "signed-out";

// Reads /events with the session token (EventSource cannot send headers) and
// reconnects after errors, like EventSource does. Stops when signed out or
// when `signal` aborts.
export async function streamEvents(
  onEvent: (event: ServerEvent) => void,
  onStatus: (status: StreamStatus) => void,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await api("/events", { signal });
      if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status}).`);
      onStatus("connected");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseServerEvents(buffer + value);
        buffer = parsed.rest;
        for (const event of parsed.events) onEvent(event);
      }
    } catch (error) {
      if (error instanceof SignedOutError) {
        onStatus("signed-out");
        return;
      }
    }
    if (signal.aborted) return;
    onStatus("disconnected");
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
