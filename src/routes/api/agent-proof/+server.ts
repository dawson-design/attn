import { json } from "@sveltejs/kit";
import { isValidNonce, serverProof } from "../../../auth";
import { serverToken } from "../../../lib/server/auth-state";
import type { RequestHandler } from "./$types";

// Unauthenticated: lets a client confirm that the process on this port knows
// the token before it sends the token. Reveals only an HMAC of the nonce.
export const GET: RequestHandler = async ({ url }) => {
  const nonce = url.searchParams.get("nonce");
  if (!isValidNonce(nonce)) return json({ ok: false, error: "Missing or malformed nonce." }, { status: 400 });
  return json({ proof: serverProof(serverToken(), nonce) });
};
