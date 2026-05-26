import { notFound } from 'next/navigation';
import { resolveScopeFromSegments } from '@/lib/project-url';
import { PageHeader } from '@/components/PageHeader';
import { FolderChatStub } from '@/components/folder/FolderAggregateLists';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Chat' };

export default async function FolderSubPage({ params }: { params: Promise<{ l1: string }> }) {
  const { l1 } = await params;
  const scope = await resolveScopeFromSegments([l1]);
  if (!scope || scope.kind !== 'folder') notFound();
  return (
    <div className="space-y-4">
      <PageHeader title="Chat" scope={scope.fsPath} />
      <FolderChatStub scope={scope} />
    </div>
  );
}
