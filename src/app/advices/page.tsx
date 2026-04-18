import { redirect } from 'next/navigation';

/**
 * The cross-project digest moved from /advices to /audits (Advice
 * → Audits rename, v5). Permanent redirect for old bookmarks.
 */
export default function LegacyAdvicesRedirect() {
  redirect('/audits');
}
