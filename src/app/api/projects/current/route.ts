import { NextResponse } from 'next/server';
import { getCurrentProjectName } from '@/lib/current-project';

export const runtime = 'nodejs';

export async function GET() {
  const name = await getCurrentProjectName();
  return NextResponse.json({ name });
}
