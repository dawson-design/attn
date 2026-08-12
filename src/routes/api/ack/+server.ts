import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown; acknowledged?: unknown };
  // Only accept an array of string ids; a non-array would throw in the service
  // and an unbounded one is a cheap DoS. The ids are matched against known
  // snapshot items, so unknown values are simply ignored.
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 1000)
    : [];
  const service = await getDashboardService();
  await service.acknowledge(ids, body.acknowledged !== false);
  return json({ ok: true });
};
