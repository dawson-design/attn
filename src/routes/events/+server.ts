import { bearerToken } from "../../auth";
import { authState } from "../../lib/server/auth-state";
import { getDashboardService } from "../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

// How often an open stream rechecks its session, so an expired session stops
// receiving snapshots. `attn signout` closes every stream at once.
const SESSION_CHECK_MS = 60_000;

export const GET: RequestHandler = async ({ request }) => {
  const service = await getDashboardService();
  const token = bearerToken(request.headers.get("authorization"));
  const { sessions } = authState();
  let streamController: ReadableStreamDefaultController<string>;
  let check: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<string>({
    start(controller) {
      streamController = controller;
      service.addClient(controller);
      check = setInterval(() => {
        if (sessions.has(token)) return;
        clearInterval(check);
        service.removeClient(controller);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }, SESSION_CHECK_MS);
    },
    cancel() {
      clearInterval(check);
      service.removeClient(streamController);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};
