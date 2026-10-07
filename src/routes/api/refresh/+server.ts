import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  // A manual click is an explicit user request, so by default it overrides the
  // rate-limit backoff that the timer-driven refresh respects. Agents send
  // force: false so a loop of refreshes cannot use up the user's rate limit.
  const body = (await request.json().catch(() => ({}))) as { force?: unknown };
  const service = await getDashboardService();
  return json(await service.refresh({ force: body.force !== false }));
};
