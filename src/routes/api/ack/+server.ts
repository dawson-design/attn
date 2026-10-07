import { json } from "@sveltejs/kit";
import { ackIds } from "../../../lib/server/agent-socket";
import { getDashboardService } from "../../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown; acknowledged?: unknown };
  const ids = ackIds(body);
  const service = await getDashboardService();
  await service.acknowledge(ids, body.acknowledged !== false);
  return json({ ok: true });
};
