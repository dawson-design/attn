import { json } from "@sveltejs/kit";
import { authState } from "../../../lib/server/auth-state";
import type { RequestHandler } from "./$types";

// Trades a one-time login code from `attn open` for a session token, which the
// page keeps in the tab's sessionStorage and sends as a bearer header (see auth.ts).
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  const { loginCodes, sessions } = authState();
  if (!loginCodes.redeem(body.code)) {
    return json({ ok: false, error: "That sign-in code has expired or was already used." }, { status: 401 });
  }
  return json({ ok: true, token: sessions.create() });
};
