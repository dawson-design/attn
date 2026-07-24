import { json } from "@sveltejs/kit";
import { getDashboardService } from "../../../lib/server/dashboard";

export async function GET() {
  const service = await getDashboardService();
  return json(service.getSnapshot());
}
