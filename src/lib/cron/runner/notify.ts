import { postToTeams, type TeamsCardFact } from '../../teams';
import { postToTelegram, type TelegramFact } from '../../telegram';

/**
 * Fan-out notification function bound to a specific Teams webhook
 * + Telegram chat target. Either side may be null — the helper
 * silently skips that transport. Errors on either side are logged
 * and swallowed so a flaky webhook can't mark the run as failed
 * post-hoc — the run already wrote its terminal status before
 * notify() is called.
 *
 * Signature kept stable on purpose: it's used at every notification
 * site in runTask (no-op, prompt-only success, normal success,
 * dry-run, child-failure propagation, abort, hard failure). Adding
 * a new field means touching one place here, not 7 sites in runTask.
 */
export type NotifyFn = (
  title: string,
  summary: string,
  status: 'success' | 'failed',
  facts: TeamsCardFact[],
  details?: string,
) => Promise<void>;

/**
 * Build a NotifyFn closure capturing the resolved targets. When both
 * targets are null the returned function is effectively a no-op (the
 * inner Promise.all resolves immediately).
 *
 * Targets are passed in already-resolved (after applying the per-task
 * teamsNotifyEnabled / telegramNotifyEnabled toggles) so this module
 * doesn't need to know about Task / AppConfig shapes.
 */
export function buildNotifier(
  webhook: string | null,
  telegramChatId: string | null,
): NotifyFn {
  return async (title, summary, status, facts, details) => {
    const tasks: Promise<void>[] = [];
    if (webhook) {
      tasks.push(
        postToTeams(webhook, { title, summary, status, facts, details }).catch((e) =>
          console.warn(`[cron] Teams notification failed:`, e),
        ),
      );
    }
    if (telegramChatId) {
      // TelegramFact has the same shape as TeamsCardFact (name +
      // value strings) so the array can be passed through as-is.
      tasks.push(
        postToTelegram(telegramChatId, {
          title,
          summary,
          status,
          facts: facts as TelegramFact[],
          details,
        }).catch((e) => console.warn(`[cron] Telegram notification failed:`, e)),
      );
    }
    await Promise.all(tasks);
  };
}
