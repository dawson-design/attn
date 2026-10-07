import { json } from "@sveltejs/kit";
import { bearerMatches } from "../../../agent-token";
import { loginCodes, serverToken } from "../../../lib/server/auth-state";
import type { RequestHandler } from "./$types";

// Token only: a browser session must not be able to mint new sign-ins, or a
// stolen cookie would outlive `attn signout`.
export const POST: RequestHandler = ({ request }) => {
  if (!bearerMatches(serverToken(), request.headers.get("authorization"))) {
    return json({ ok: false, error: "Login codes need the attn token." }, { status: 403 });
  }
  return json({ code: loginCodes.issue() });
};
