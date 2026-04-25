'use client';

/**
 * conversationsBus — cross-tab / cross-page sync of conversation
 * mutations (pin / delete). Used so that a user pinning a
 * conversation on /chat sees the change appear on a /conversation
 * or / (dashboard) tab without a manual reload, and vice-versa.
 *
 * Transport: BroadcastChannel (native cross-tab, same-origin).
 * Fallback:  localStorage `storage` event for browsers that do not
 *            support BroadcastChannel on plain http (old Safari).
 *            Both can coexist — subscribers are idempotent via
 *            a small dedupe on event id.
 *
 * Franck 2026-04-20 17:04.
 */

export type ConvEvent =
  | { type: 'pinned'; id: string; pinned: boolean; t?: number }
  | { type: 'deleted'; id: string; t?: number }
  // Run-scoped events (Franck 2026-04-20 18:04): piggy-backing on the
  // same bus to avoid a second BroadcastChannel connection. The
  // dashboard\u0027s ConversationsBusListener calls router.refresh()
  // on every event regardless of type, so a run pin/delete on one
  // tab re-renders the RecentRuns listing on sibling tabs.
  | { type: 'run-pinned'; id: string; pinned: boolean; t?: number }
  | { type: 'run-deleted'; id: string; t?: number };

const CHANNEL = 'kdust:conversations';
const STORAGE_KEY = 'kdust:conv:event';

/** Emit an event to all other listeners (same-origin, any tab). */
export function publishConvEvent(ev: ConvEvent): void {
  const payload: ConvEvent = { ...ev, t: Date.now() };
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(payload);
    bc.close();
  } catch {
    /* BroadcastChannel unsupported — use storage fallback only. */
  }
  try {
    // Storage event does NOT fire in the tab that set the key, which
    // is the desired behaviour here (the emitting tab already has
    // the local state up to date).
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* Private-browsing / quota — silently give up. */
  }
}

/** Subscribe to events. Returns an unsubscribe function. */
export function subscribeConvEvents(
  handler: (ev: ConvEvent) => void,
): () => void {
  let seenT = 0; // crude dedupe across BC + storage fallback.
  const dispatch = (ev: ConvEvent) => {
    const t = ev.t ?? 0;
    if (t && t === seenT) return;
    if (t) seenT = t;
    handler(ev);
  };

  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => dispatch(e.data as ConvEvent);
  } catch {
    /* BroadcastChannel unsupported — rely on the storage fallback. */
  }

  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      dispatch(JSON.parse(e.newValue) as ConvEvent);
    } catch {
      /* Malformed payload — drop. */
    }
  };
  window.addEventListener('storage', onStorage);

  return () => {
    bc?.close();
    window.removeEventListener('storage', onStorage);
  };
}
