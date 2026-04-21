// src/app/api/tasks/[id]/secrets/[envName]/route.ts
// Remove a single env-var binding for a task. Idempotent.
import { NextResponse } from 'next/server';
import { removeBinding } from '@/lib/secrets/repo';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; envName: string }> },
) {
  const { id, envName } = await params;
  await removeBinding(id, envName);
  return NextResponse.json({ ok: true });
}
