import { notFound } from 'next/navigation';
import { FolderTree } from 'lucide-react';
import { resolveScopeFromSegments } from '@/lib/project-url';
import { PageHeader } from '@/components/PageHeader';
import { FolderChildrenBrowser } from '@/components/folder/FolderChildrenBrowser';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ l1: string; l2: string }> }): Promise<import('next').Metadata> {
  const { l2 } = await params;
  return { title: l2 };
}

export default async function L2Page({ params }: { params: Promise<{ l1: string; l2: string }> }) {
  const { l1, l2 } = await params;
  const scope = await resolveScopeFromSegments([l1, l2]);
  if (!scope || scope.kind !== 'folder') notFound();
  return (
    <div className="space-y-6">
      <PageHeader icon={<FolderTree className="h-5 w-5" />} title={scope.folder.name} scope={scope.fsPath} />
      <FolderChildrenBrowser folderId={scope.folder.id} fsPath={scope.fsPath} />
    </div>
  );
}
