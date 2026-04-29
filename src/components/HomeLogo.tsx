'use client';
import { useRouter } from 'next/navigation';
import { apiSend } from '@/lib/api/client';

/**
 * Brand logo that clears the current project selection and navigates to the
 * root dashboard ("all projects" view).
 */
export function HomeLogo() {
  const router = useRouter();
  async function goHome(e: React.MouseEvent) {
    e.preventDefault();
    try {
      await apiSend('POST', '/api/current-project', { name: null });
    } catch {
      /* ignore */
    }
    // Broadcast so other client components (ProjectSwitcher, …) refresh their state
    window.dispatchEvent(new CustomEvent('kdust:project-changed', { detail: { name: null } }));
    router.push('/');
    router.refresh();
  }
  return (
    <a
      href="/"
      onClick={goHome}
      className="text-lg font-bold tracking-tight hover:text-brand-600"
      title="Back to all projects"
    >
      KDust
    </a>
  );
}
