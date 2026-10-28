/** Keep public transport alive while exact task admission waits. No tool runs here. */
export function admissionStream(request: Request, execute: () => Promise<Response>, intervalMs = 1000): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => { closed = true; clearInterval(timer); request.signal.removeEventListener('abort', abort); };
      const abort = () => { if (closed) return; stop(); void reader?.cancel().catch(() => undefined); controller.error(new Error('Request closed')); };
      if (request.signal.aborted) { abort(); return; }
      request.signal.addEventListener('abort', abort, { once: true });
      controller.enqueue(encoder.encode(': admission pending\n\n'));
      timer = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n')); }, intervalMs);
      timer.unref?.();
      void (async () => {
        try {
          const response = await execute();
          if (closed) { await response.body?.cancel(); return; }
          if (response.headers.get('content-type')?.includes('text/event-stream')) {
            if (response.body) {
              reader = response.body.getReader();
              for (;;) { const chunk = await reader.read(); if (closed || chunk.done) break; controller.enqueue(chunk.value); }
            }
          } else {
            const body = await response.text();
            if (!closed && body) controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(JSON.parse(body))}\n\n`));
          }
          if (!closed) { stop(); controller.close(); }
        } catch (error) { if (!closed) { stop(); controller.error(error); } }
      })();
    },
    cancel() { closed = true; clearInterval(timer); void reader?.cancel().catch(() => undefined); }
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}
