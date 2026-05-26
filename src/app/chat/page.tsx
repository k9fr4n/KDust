import type { Metadata } from 'next';
import ChatClient from './_ChatClient';
import { getCurrentScope } from '@/lib/project-url';

export const metadata: Metadata = { title: 'Chat' };
export const dynamic = 'force-dynamic';

/**
 * /chat \u2014 fresh chat surface (no conversation pre-selected).
 *
 * Resolves the active hierarchy node from the URL via the shared
 * getCurrentScope() helper (ADR-0020 follow-up, Franck 2026-05-26
 * 21:29) so the client renders project-bound / folder-aggregate /
 * root mode without a `/api/projects/current` round-trip. The
 * matching dynamic route /chat/[id]/page.tsx forwards params.id.
 */
export default async function ChatRootPage() {
  const scope = await getCurrentScope();
  return (
    <ChatClient
      initialConversationId={null}
      initialScope={{
        kind: scope.kind,
        fsPath: scope.fsPath,
        projectName: scope.kind === 'project' ? scope.project.fsPath : null,
        defaultAgentSId:
          scope.kind === 'project' ? scope.project.defaultAgentSId ?? null : null,
      }}
    />
  );
}
