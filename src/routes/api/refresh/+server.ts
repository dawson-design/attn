import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";

export async function POST() {
  // A manual click is an explicit user request, so override the rate-limit
  // backoff window that the timer-driven refresh respects.
  const service = await getDashboardService();
  return json(await service.refresh({ force: true }));
}
