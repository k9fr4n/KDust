import { notFound } from 'next/navigation';
import { FolderTree } from 'lucide-react';
import { resolveScopeFromSegments } from '@/lib/project-url';
import { PageHeader } from '@/components/PageHeader';
import { FolderChildrenBrowser } from '@/components/folder/FolderChildrenBrowser';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ l1: string }> }): Promise<import('next').Metadata> {
  const { l1 } = await params;
  return { title: l1 };
}

export default async function L1Page({ params }: { params: Promise<{ l1: string }> }) {
  const { l1 } = await params;
  const scope = await resolveScopeFromSegments([l1]);
  if (!scope || scope.kind !== 'folder') notFound();
  return (
    <div className="space-y-6">
      <PageHeader icon={<FolderTree className="h-5 w-5" />} title={scope.folder.name} scope={scope.fsPath} />
      <FolderChildrenBrowser folderId={scope.folder.id} fsPath={scope.fsPath} />
    </div>
  );
}
