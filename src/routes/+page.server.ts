import { getDashboardService } from "../lib/server/dashboard";

export async function load() {
  const service = await getDashboardService();
  return {
    snapshot: service.getSnapshot(),
  };
}
