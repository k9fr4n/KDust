// /ide — embedded code-server IDE scoped to the current project/folder
// (ADR-0028, Franck 2026-06-03).
//
// Server component: resolves the caller's current scope (ADR-0020/0023
// getCurrentScope) into an absolute workspace path inside the IDE
// sidecar, then hands off to the client <IdeFrame>. Access is already
// gated by src/middleware.ts (kdust_session JWT); the IDE proxy
// re-verifies the same cookie before reaching code-server.

import { IdeFrame } from '@/components/IdeFrame';
import { getCurrentScope } from '@/lib/project-url';

export const dynamic = 'force-dynamic';

export default async function IdePage() {
  const scope = await getCurrentScope();
  // The sidecar mounts the host ./projects at /projects. Root scope
  // opens the whole tree; a folder/project scope deep-links into it.
  const folder = scope.kind === 'root' ? '/projects' : `/projects/${scope.fsPath}`;

  // Always-on by default (ADR-0028 follow-up): disabled only when
  // IDE_ENABLED is explicitly 'false'.
  const enabled = process.env.IDE_ENABLED !== 'false';
  // Runtime (not NEXT_PUBLIC_): the image is prebuilt, so this is read
  // server-side and passed as a prop. Empty => client derives
  // <host>:4001 from window.location.
  const baseUrl = process.env.IDE_PUBLIC_URL?.trim() || null;

  return (
    <div className="h-[calc(100vh-3.5rem)]">
      <IdeFrame folder={folder} baseUrl={baseUrl} enabled={enabled} />
    </div>
  );
}
