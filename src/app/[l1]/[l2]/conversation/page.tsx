import { notFound } from 'next/navigation';
import { resolveScopeFromSegments } from '@/lib/project-url';
import { PageHeader } from '@/components/PageHeader';
import { FolderConversationList } from '@/components/folder/FolderAggregateLists';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Conversations' };

export default async function FolderSubPage({ params }: { params: Promise<{ l1: string; l2: string }> }) {
  const { l1, l2 } = await params;
  const scope = await resolveScopeFromSegments([l1, l2]);
  if (!scope || scope.kind !== 'folder') notFound();
  return (
    <div className="space-y-4">
      <PageHeader title="Conversations" scope={scope.fsPath} />
      <FolderConversationList scope={scope} />
    </div>
  );
}
