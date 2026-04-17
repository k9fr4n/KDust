import { Cron } from 'croner';
import { db } from '../db';
import { runCronJob } from './runner';

// On garde une référence des Cron instances pour pouvoir les arrêter / recharger.
const jobs = new Map<string, Cron>();

export async function reloadScheduler(): Promise<void> {
  // arrête tout
  for (const c of jobs.values()) c.stop();
  jobs.clear();

  const enabled = await db.cronJob.findMany({ where: { enabled: true } });
  for (const j of enabled) {
    try {
      const c = new Cron(
        j.schedule,
        { timezone: j.timezone, name: j.id, protect: true },
        () => {
          void runCronJob(j.id);
        },
      );
      jobs.set(j.id, c);
      console.log(`[scheduler] registered cron ${j.name} (${j.schedule} ${j.timezone})`);
    } catch (err) {
      console.error(`[scheduler] invalid cron ${j.name}:`, err);
    }
  }
}

export function stopScheduler(): void {
  for (const c of jobs.values()) c.stop();
  jobs.clear();
}
