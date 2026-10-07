import { json } from "@sveltejs/kit";
import { loginCodes } from "../../../lib/server/auth-state";

// Authenticated by the hook (bearer token from `attn open`).
export function POST() {
  return json({ code: loginCodes.issue() });
}
