// Server-process auth state: the token loaded in hooks.server.ts `init`, and
// the outstanding login codes. Routes read it from here.
import { LoginCodes } from "../../auth";

let token: string | undefined;

export const loginCodes = new LoginCodes();

export function setServerToken(value: string): void {
  token = value;
}

export function serverToken(): string {
  if (!token) throw new Error("attn server token is not loaded yet");
  return token;
}
