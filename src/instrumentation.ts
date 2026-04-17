export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Lazy import pour éviter d'embarquer Prisma dans l'edge runtime
  const { reloadScheduler } = await import('./lib/cron/scheduler');
  try {
    await reloadScheduler();
    console.log('[instrumentation] scheduler booted');
  } catch (err) {
    console.error('[instrumentation] scheduler failed to boot', err);
  }
}
