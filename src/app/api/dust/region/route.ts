import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadTokens } from '@/lib/dust/tokens';
import { getDustClient } from '@/lib/dust/client';
import { badRequest } from "@/lib/api/responses";

export const runtime = 'nodejs';

/**
 * Module-level memo so we don't hit `/api/v1/me` on every header mount.
 * Dust's `User` object is stable for the lifetime of a session; when the
 * workspaceId changes (reconnect / switch workspace) we invalidate.
 * TTL is belt-and-suspenders in case Dust updates a display name.
 */
type CachedMe = {
  workspaceId: string | null;
  email: string | null;
  name: string | null;
  fetchedAt: number;
};
const ME_TTL_MS = 5 * 60 * 1000;
let meCache: CachedMe | null = null;

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

  // Best-effort identity via Dust's OAuth-only /me endpoint. If it fails
  // (network, 5xx, expired token caught by the SDK) we still return the
  // region/workspaceId so the header just falls back to "Signed in" —
  // it's a display nicety, not a security gate.
  let email: string | null = null;
  let name: string | null = null;

  const cached = meCache;
  if (
    cached &&
    cached.workspaceId === s.workspaceId &&
    Date.now() - cached.fetchedAt < ME_TTL_MS
  ) {
    email = cached.email;
    name = cached.name;
  } else {
    try {
      const cli = await getDustClient();
      if (cli) {
        const res = await cli.client.me();
        if (!res.isErr()) {
          const u: any = res.value;
          // Dust's UserType exposes fullName/firstName/lastName/email.
          // We defensively cover a few shapes in case the SDK evolves.
          email = u?.email ?? u?.user?.email ?? null;
          const composed =
            [u?.firstName ?? u?.first_name, u?.lastName ?? u?.last_name]
              .filter(Boolean)
              .join(' ')
              .trim();
          name =
            (u?.fullName as string | undefined) ??
            (u?.full_name as string | undefined) ??
            (u?.name as string | undefined) ??
            (u?.user?.fullName as string | undefined) ??
            (composed.length > 0 ? composed : null) ??
            null;
          meCache = {
            workspaceId: s.workspaceId,
            email,
            name,
            fetchedAt: Date.now(),
          };
        } else {
          console.warn('[dust/region] me() returned error:', res.error?.message);
        }
      }
    } catch (err) {
      console.warn('[dust/region] me() threw:', err instanceof Error ? err.message : err);
    }
  }

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
    return badRequest('invalid region');
  }
  await db.dustSession.update({ where: { id: 1 }, data: { region } });
  return NextResponse.json({ ok: true, region });
}
