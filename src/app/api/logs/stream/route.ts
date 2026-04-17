import { getLogs, subscribe, type LogEntry } from '@/lib/logs/buffer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const { signal } = req;

  const stream = new ReadableStream({
    start(controller) {
      const send = (e: LogEntry) => {
        controller.enqueue(
          encoder.encode(`event: log\ndata: ${JSON.stringify(e)}\n\n`),
        );
      };

      // Replay recent buffer first (last 500)
      const backlog = getLogs().slice(-500);
      for (const e of backlog) send(e);

      const unsub = subscribe(send);

      // Heartbeat to keep the connection alive
      const hb = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* ignore */ }
      }, 15000);

      signal.addEventListener('abort', () => {
        clearInterval(hb);
        unsub();
        try { controller.close(); } catch { /* ignore */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
