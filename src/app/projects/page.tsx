import { redirect } from 'next/navigation';

/**
 * The project-CRUD list has moved under Settings. Keep this entry
 * point as a permanent redirect so old bookmarks / inbound links
 * keep working.
 */
export default function LegacyProjectsRedirect() {
  redirect('/settings/projects');
}
