import { redirect } from 'next/navigation';
import { getCurrentProjectName } from '@/lib/current-project';

export const dynamic = 'force-dynamic';

/**
 * Chat is project-scoped. Without a current project selected, redirect the
 * user back to the global dashboard where they can pick one.
 */
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const project = await getCurrentProjectName();
  if (!project) {
    redirect('/?reason=select-a-project');
  }
  return <>{children}</>;
}
