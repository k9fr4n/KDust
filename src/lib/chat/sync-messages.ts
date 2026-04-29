/**
 * Pull-on-open sync of conversation messages from Dust to the local
 * KDust DB (Franck 2026-04-29).
 *
 * Why
 * ---
 * Until 2026-04-29 the local `Message` table was the sole source of
 * truth on a conv reopen. Continuing a conversation on app.dust.tt
 * (web UI) and coming back to KDust silently dropped those new
 * turns from the client view because GET /api/conversation/:id only
 * read the local mirror. This helper reconciles the local cache
 * with Dust's authoritative `content` array on every conv open.
 *
 * Idempotency
 * -----------
 * The reconciliation key is `Message.dustMessageSId` (column added
 * by the same change). For each Dust message:
 *
 *   - if a local row already carries that sId → skip (already
 *     mirrored).
 *   - else, attempt to backfill: find an unlinked local row that
 *     "looks like" the Dust message (same role, similar content,
 *     close in time) and stamp the sId on it. This handles legacy
 *     rows created before the sId column existed.
 *   - else, INSERT a new row using Dust's content + created
 *     timestamp.
 *
 * Backfill heuristic
 * ------------------
 * KDust's local user messages may have a markdown attachment
 * suffix appended (`![file.png](fil_xxx)\n…`) that is absent from
 * the Dust user_message.content (Dust models attachments as separate
 * `content_fragment` messages, not inline markdown). So we match
 * on:
 *
 *   - same role
 *   - createdAt within ±60s of Dust's `created`
 *   - local.content === dust.content  OR
 *     local.content.startsWith(dust.content + '\n\n')  (KDust path)
 *
 * Greedy first-match-wins; never re-uses a local row already linked.
 *
 * What we DO NOT sync
 * -------------------
 *   - `content_fragment` messages — Dust's standalone attachment
 *     entries. KDust represents attachments as inline markdown on
 *     the user message; cloning them as separate rows would create
 *     phantom messages in the UI.
 *   - tool calls / chain-of-thought — Dust does not re-expose CoT
 *     deltas via getConversation, and tool-call detail lives only
 *     in our own SSE event loop. Messages pulled from Dust web
 *     therefore land with `toolCalls=0`, `streamStats=null`,
 *     `toolNames='[]'`. /settings/usage already tolerates these
 *     defaults for legacy rows.
 *
 * The function never throws on a per-message failure — it logs and
 * keeps going, so a single malformed row from Dust can't break a
 * conversation open. A top-level throw still propagates so the
 * caller can decide whether to swallow it (the GET handler does).
 */
import { db } from '@/lib/db';

/**
 * Subset of the Dust `getConversation` value we actually consume.
 * Typed loosely on purpose: the SDK's full `ConversationPublicType`
 * is enormous and changes shape across Dust versions; we only
 * touch sId / type / content / created.
 */
interface DustConvLite {
  sId: string;
  content?: Array<Array<DustMessageLite>>;
}

interface DustMessageLite {
  type: string; // 'user_message' | 'agent_message' | 'content_fragment' | …
  sId?: string;
  version?: number;
  content?: string | null;
  created?: number; // epoch ms
}

export interface SyncStats {
  /** New rows inserted (messages sent from Dust web). */
  created: number;
  /** Existing local rows that got their dustMessageSId backfilled. */
  linked: number;
  /** Rows already in sync, no-op. */
  skipped: number;
}

const BACKFILL_TIME_WINDOW_MS = 60_000;

/**
 * Pick the latest version of each message rank. Dust keeps history
 * of edits/retries in the inner array; the highest `version` (or,
 * defensively, the last entry) is the current visible message.
 */
function latestPerRank(content: Array<Array<DustMessageLite>>): DustMessageLite[] {
  return content
    .map((versions) => {
      if (!versions || versions.length === 0) return null;
      const sorted = [...versions].sort(
        (a, b) => (a.version ?? 0) - (b.version ?? 0),
      );
      return sorted[sorted.length - 1] ?? null;
    })
    .filter((m): m is DustMessageLite => m !== null);
}

function dustRoleToLocal(type: string): 'user' | 'agent' | null {
  if (type === 'user_message') return 'user';
  if (type === 'agent_message') return 'agent';
  return null; // content_fragment, etc. — skipped
}

export async function syncMessagesFromDust(
  localConvId: string,
  dustConv: DustConvLite,
): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, linked: 0, skipped: 0 };
  if (!dustConv.content || dustConv.content.length === 0) return stats;

  const dustMessages = latestPerRank(dustConv.content).filter(
    (m) => dustRoleToLocal(m.type) !== null && typeof m.sId === 'string',
  );

  if (dustMessages.length === 0) return stats;

  // Pre-fetch all local messages once. Conversations are bounded
  // (typically <500 messages) so this is cheap and lets us run the
  // backfill heuristic in memory without N+1 queries.
  const local = await db.message.findMany({
    where: { conversationId: localConvId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
      dustMessageSId: true,
    },
  });

  const linkedSIds = new Set(
    local.map((m) => m.dustMessageSId).filter((s): s is string => !!s),
  );
  // Track local rows already used by the backfill pass so we don't
  // bind two Dust messages to the same local row.
  const claimedLocalIds = new Set<string>();

  for (const m of dustMessages) {
    const sId = m.sId!;
    const role = dustRoleToLocal(m.type)!;
    const content = m.content ?? '';
    const created =
      typeof m.created === 'number' ? new Date(m.created) : new Date();

    if (linkedSIds.has(sId)) {
      stats.skipped += 1;
      continue;
    }

    // Backfill: try to attach the sId to an unlinked local row.
    const candidate = local.find((row) => {
      if (row.dustMessageSId) return false;
      if (claimedLocalIds.has(row.id)) return false;
      if (row.role !== role) return false;
      const dt = Math.abs(row.createdAt.getTime() - created.getTime());
      if (dt > BACKFILL_TIME_WINDOW_MS) return false;
      if (row.content === content) return true;
      if (content.length > 0 && row.content.startsWith(content + '\n\n'))
        return true;
      return false;
    });

    if (candidate) {
      try {
        await db.message.update({
          where: { id: candidate.id },
          data: { dustMessageSId: sId },
        });
        claimedLocalIds.add(candidate.id);
        linkedSIds.add(sId);
        stats.linked += 1;
        continue;
      } catch (e) {
        console.warn(
          '[sync-messages] backfill update failed',
          candidate.id,
          e instanceof Error ? e.message : e,
        );
        // fall through to create a fresh row
      }
    }

    // Otherwise — message that originated outside KDust (Dust web,
    // another client). Insert a new row carrying Dust's createdAt
    // so the chronological ordering matches what users see on
    // dust.tt.
    try {
      await db.message.create({
        data: {
          conversationId: localConvId,
          role,
          content,
          createdAt: created,
          dustMessageSId: sId,
        },
      });
      linkedSIds.add(sId);
      stats.created += 1;
    } catch (e) {
      // Most likely a unique-constraint race (concurrent open of
      // the same conv). Safe to ignore — the other request won.
      console.warn(
        '[sync-messages] insert failed',
        sId,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return stats;
}
