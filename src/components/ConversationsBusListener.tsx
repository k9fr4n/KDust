'use client';
/**
 * ConversationsBusListener — tiny headless component that subscribes
 * to the cross-tab conversations bus and triggers a router.refresh()
 * on any pin / delete event. Mount it once on server-rendered
 * conversation listings (`/`, `/conversation`) so they pick up
 * mutations performed on a sibling tab without requiring a manual
 * reload.
 *
 * Debounces refreshes to ~250ms so a burst of events (e.g. the user
 * pinning and immediately unpinning) coalesces into a single SSR
 * re-render.
 *
 * Franck 2026-04-20 17:04.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeConvEvents } from '@/lib/client/conversationsBus';

export function ConversationsBusListener() {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 250);
    };
    const unsub = subscribeConvEvents(() => scheduleRefresh());
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [router]);
  return null;
}
