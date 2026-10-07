import { json } from "@sveltejs/kit";
import { bearerMatches } from "../../../agent-token";
import { serverToken, sessions } from "../../../lib/server/auth-state";
import type { RequestHandler } from "./$types";

// `attn signout`: revokes every browser session. Token only, so a stolen
// cookie cannot be used to lock the user out.
export const POST: RequestHandler = async ({ request }) => {
  if (!bearerMatches(serverToken(), request.headers.get("authorization"))) {
    return json({ ok: false, error: "Signing out needs the attn token." }, { status: 403 });
  }
  return json({ revoked: await sessions().revokeAll() });
};
