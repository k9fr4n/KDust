import { permanentRedirect } from 'next/navigation';

/**
 * Legacy route preserved as a permanent redirect so old bookmarks,
 * Teams messages and external docs keep resolving. The canonical
 * path is now /advices to match the plural convention of /runs,
 * /tasks, /conversations, /projects.
 *
 * Remove once analytics confirm traffic has drained (≥30 days after
 * deploy).
 */
export default function LegacyAdviceRedirect() {
  permanentRedirect('/audits');
}
