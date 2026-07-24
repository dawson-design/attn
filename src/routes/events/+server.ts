import { getDashboardService } from "../../lib/server/dashboard";

export async function GET() {
  const service = await getDashboardService();
  let streamController: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(controller) {
      streamController = controller;
      service.addClient(controller);
    },
    cancel() {
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
}
