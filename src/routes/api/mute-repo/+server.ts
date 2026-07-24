import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => ({}))) as { repo?: string; muted?: boolean };
  const service = await getDashboardService();
  if (body.repo) await service.muteRepo(body.repo, Boolean(body.muted));
  return json({ ok: true });
};
