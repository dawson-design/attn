import { json } from "@sveltejs/kit";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sessionCookieValue } from "../../../auth";
import { loginCodes, serverToken } from "../../../lib/server/auth-state";
import type { RequestHandler } from "./$types";

// Trades a one-time login code from `attn open` for the browser session cookie.
export const POST: RequestHandler = async ({ request, cookies }) => {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (!loginCodes.redeem(body.code)) {
    return json({ ok: false, error: "That sign-in code has expired or was already used." }, { status: 401 });
  }
  cookies.set(SESSION_COOKIE, sessionCookieValue(serverToken()), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    // Plain http on loopback; a Secure cookie would not be sent back.
    secure: false,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return json({ ok: true });
};
