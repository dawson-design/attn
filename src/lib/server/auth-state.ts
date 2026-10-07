// Server-process auth state, loaded in hooks.server.ts `init`: the token, the
// browser sessions, and the outstanding login codes. Routes read it from here.
import { LoginCodes } from "../../auth";
import type { SessionStore } from "../../sessions";

let token: string | undefined;
let sessionStore: SessionStore | undefined;

export const loginCodes = new LoginCodes();

export function setAuthState(value: { token: string; sessions: SessionStore }): void {
  token = value.token;
  sessionStore = value.sessions;
}

export function serverToken(): string {
  if (!token) throw new Error("attn server token is not loaded yet");
  return token;
}

export function sessions(): SessionStore {
  if (!sessionStore) throw new Error("attn sessions are not loaded yet");
  return sessionStore;
}
