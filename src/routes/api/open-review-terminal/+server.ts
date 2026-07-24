import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return json({ ok: false, error: "Missing notification item id." }, { status: 400 });

  try {
    const service = await getDashboardService();
    return json(await service.openReviewTerminal(body.id));
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
