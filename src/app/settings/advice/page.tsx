import { redirect } from 'next/navigation';

/**
 * The Audit categories page moved to /settings/audits. Keep this
 * entry point as a permanent redirect for old bookmarks.
 */
export default function LegacyAdviceSettingsRedirect() {
  redirect('/settings/audits');
}
