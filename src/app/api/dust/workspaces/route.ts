import { NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/dust/client';
import { getAppConfig } from '@/lib/config';

export const runtime = 'nodejs';

export async function GET() {
  const token = await getValidAccessToken();
  if (!token) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

  const cfg = await getAppConfig();
  // endpoint /api/v1/me pour récupérer les workspaces de l'utilisateur connecté
  const res = await fetch(`${cfg.dustBaseUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return NextResponse.json({ error: await res.text() }, { status: res.status });
  return NextResponse.json(await res.json());
}
