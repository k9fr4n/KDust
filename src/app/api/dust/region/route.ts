import { NextResponse } from 'next/server';
import { jwtDecode } from 'jwt-decode';
import { db } from '@/lib/db';
import { loadTokens } from '@/lib/dust/tokens';

export const runtime = 'nodejs';

/**
 * Pull best-effort user identity from the access token's JWT claims.
 * WorkOS tokens carry `email`, `first_name` / `last_name` or similar.
 * Namespaced claims are also supported to match Dust's custom claim prefix.
 */
function extractUser(accessToken: string): { email: string | null; name: string | null } {
  try {
    const d = jwtDecode<Record<string, unknown>>(accessToken);
    const pickStr = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = d[k];
        if (typeof v === 'string' && v.length > 0) return v;
      }
      return null;
    };
    const email = pickStr(
      'email',
      'https://dust.tt/email',
      'https://eu.dust.tt/email',
      'preferred_username',
    );
    const first = pickStr('first_name', 'given_name', 'https://dust.tt/first_name');
    const last = pickStr('last_name', 'family_name', 'https://dust.tt/last_name');
    const full = pickStr('name', 'fullName', 'full_name', 'https://dust.tt/name');
    const name = full ?? ([first, last].filter(Boolean).join(' ') || null);
    return { email, name };
  } catch {
    return { email: null, name: null };
  }
}

export async function GET() {
  const s = await loadTokens();
  if (!s) {
    return NextResponse.json({
      region: null,
      workspaceId: null,
      email: null,
      name: null,
    });
  }
  const { email, name } = extractUser(s.accessToken);
  return NextResponse.json({
    region: s.region ?? null,
    workspaceId: s.workspaceId ?? null,
    email,
    name,
  });
}

export async function POST(req: Request) {
  const { region } = (await req.json()) as { region: string };
  if (!['us-central1', 'europe-west1'].includes(region)) {
    return NextResponse.json({ error: 'invalid region' }, { status: 400 });
  }
  await db.dustSession.update({ where: { id: 1 }, data: { region } });
  return NextResponse.json({ ok: true, region });
}
