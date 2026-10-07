// Server-process auth state, created once in hooks.server.ts `init`: the
// dashboard's host and origin, the browser sessions, and the outstanding login
// codes. Kept on globalThis so a dev-server module reload keeps them.
import { LoginCodes } from "../../auth";
import { dashboardHost, dashboardOrigin } from "../../host-guard";
import type { SessionStore } from "../../sessions";

export interface AuthState {
  host: string;
  origin: string;
  sessions: SessionStore;
  loginCodes: LoginCodes;
}

declare global {
  var attnAuthState: AuthState | undefined;
}

export function startAuthState(port: number, sessions: SessionStore): AuthState {
  globalThis.attnAuthState ??= {
    host: dashboardHost(port),
    origin: dashboardOrigin(port),
    sessions,
    loginCodes: new LoginCodes(),
  };
  return globalThis.attnAuthState;
}

export function authState(): AuthState {
  if (!globalThis.attnAuthState) throw new Error("attn auth state is not started yet");
  return globalThis.attnAuthState;
}
