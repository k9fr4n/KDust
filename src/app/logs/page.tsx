import { getAppTimezone } from '@/lib/config';
import LogsView from './LogsView';

export const dynamic = 'force-dynamic';

/**
 * Server shell for /logs: resolves the operator-configured
 * AppConfig timezone (Franck 2026-04-24 17:07) once and threads
 * it down to the client viewer so log timestamps render in the
 * same tz as /run, /task, /settings — instead of the previous
 * always-UTC ISO substring (Franck 2026-05-01).
 */
export default async function LogsPage() {
  const tz = await getAppTimezone();
  return <LogsView tz={tz} />;
}
