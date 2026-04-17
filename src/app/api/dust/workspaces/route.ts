import { NextResponse } from 'next/server';
import { DustAPI } from '@dust-tt/client';
import { getValidAccessToken } from '@/lib/dust/client';
import { loadTokens } from '@/lib/dust/tokens';
import { resolveDustUrl } from '@/lib/dust/region';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const token = await getValidAccessToken();
    if (!token) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

    const stored = await loadTokens();
    const url = await resolveDustUrl(stored?.region);
    console.log('[workspaces] region=%s url=%s', stored?.region, url);

    // Tentative 1 : via le SDK
    const client = new DustAPI(
      { url },
      { workspaceId: '', apiKey: token },
      { error: console.error, info: console.log } as any,
    );
    const sdkRes = await client.me();
    if (!sdkRes.isErr()) {
      const workspaces = (sdkRes.value as any).workspaces ?? [];
      return NextResponse.json({ workspaces, user: sdkRes.value });
    }
    console.error('[workspaces] SDK me() failed:', sdkRes.error);

    // Tentative 2 : fetch direct, utile si le SDK a une shape différente
    const raw = await fetch(`${url}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rawText = await raw.text();
    console.log('[workspaces] raw /me status=%s body=%s', raw.status, rawText.slice(0, 500));

    return NextResponse.json(
      {
        error: 'me() failed',
        sdkError: String(sdkRes.error?.message ?? sdkRes.error),
        rawStatus: raw.status,
        rawBody: rawText.slice(0, 2000),
      },
      { status: 500 },
    );
  } catch (err) {
    console.error('[workspaces] unhandled', err);
    return NextResponse.json(
      { error: 'unhandled', message: (err as Error).message, stack: (err as Error).stack },
      { status: 500 },
    );
  }
}
