import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { ids?: string[]; acknowledged?: boolean };
  const service = await getDashboardService();
  await service.acknowledge(body.ids || [], body.acknowledged ?? true);
  return json({ ok: true });
};
