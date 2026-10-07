import { json } from "@sveltejs/kit";
import { SESSION_COOKIE } from "../../../auth";
import { loginCodes, sessions } from "../../../lib/server/auth-state";
import { SESSION_TTL_MS } from "../../../sessions";
import type { RequestHandler } from "./$types";

// Trades a one-time login code from `attn open` for a new browser session.
export const POST: RequestHandler = async ({ request, cookies }) => {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (!loginCodes.redeem(body.code)) {
    return json({ ok: false, error: "That sign-in code has expired or was already used." }, { status: 401 });
  }
  cookies.set(SESSION_COOKIE, await sessions().create(), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    // Plain http on loopback; a Secure cookie would not be sent back.
    secure: false,
    maxAge: SESSION_TTL_MS / 1000,
  });
  return json({ ok: true });
};
