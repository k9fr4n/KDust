'use client';

import { useEffect } from 'react';

/**
 * Reference-counted body scroll lock (Franck 2026-05-21).
 *
 * Replaces ad-hoc `document.body.style.overflow = 'hidden'` /
 * restore-on-cleanup patterns that race when multiple components
 * lock the body concurrently:
 *
 *   t0  body.overflow = ''
 *   t1  ChatClient locks: prev=''     → body='hidden'
 *   t2  SideNav locks:    prev='hidden' → body='hidden'
 *   t3  ChatClient unmounts: restore prev=''       → body=''
 *   t4  SideNav cleanup:     restore prev='hidden' → body='hidden' [STUCK]
 *
 * With a single global counter and one captured baseline, each
 * acquire() increments and only the first acquire snapshots the
 * pre-lock body.overflow. Each release() decrements; only the LAST
 * release restores the baseline. Mount/unmount order no longer
 * matters.
 *
 * Server-rendered, so the module-level state lives per-tab — fine
 * for a browser-side concern. Strict-mode double effect-run also
 * balances correctly because acquire and release pair via the
 * useEffect cleanup.
 */

let lockCount = 0;
let baselineOverflow: string | null = null;

function acquire() {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) {
    baselineOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}

function release() {
  if (typeof document === 'undefined') return;
  if (lockCount === 0) return; // defensive: never go negative
  lockCount -= 1;
  if (lockCount === 0) {
    document.body.style.overflow = baselineOverflow ?? '';
    baselineOverflow = null;
  }
}

/**
 * Lock the body's vertical scroll for as long as `enabled` is true.
 * Multiple concurrent locks are safe; the body is restored only
 * when the LAST locker releases.
 */
export function useBodyScrollLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    acquire();
    return () => {
      release();
    };
  }, [enabled]);
}
