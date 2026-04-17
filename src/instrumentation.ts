// Next.js instrumentation hook: runs once on server startup (node runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installLogCapture } = await import('./lib/logs/buffer');
    installLogCapture();
  }
}
