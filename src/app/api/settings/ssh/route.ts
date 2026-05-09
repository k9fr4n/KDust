// src/app/api/settings/ssh/route.ts
//
// SSH identities collection endpoints (Franck 2026-05-09, ADR-0011).
//   GET  /api/settings/ssh   - list metadata (NEVER private keys)
//   POST /api/settings/ssh   - create + materialise to tmpfs

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createIdentity, listIdentities } from '@/lib/ssh/identity';
import { materializeSshIdentities } from '@/lib/ssh/bootstrap';
import { badRequest } from '@/lib/api/responses';
import { errMessage, errCode } from '@/lib/errors';

export const runtime = 'nodejs';

export async function GET() {
  const rows = await listIdentities();
  return NextResponse.json({ identities: rows });
}

const CreateSchema = z.object({
  name: z.string().min(2).max(64),
  hostPattern: z.string().min(1).max(128),
  privateKey: z.string().min(40),
  description: z.string().max(256).nullable().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return badRequest('Invalid JSON body'); }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const row = await createIdentity({
      name: parsed.data.name,
      hostPattern: parsed.data.hostPattern,
      privateKey: parsed.data.privateKey,
      description: parsed.data.description ?? null,
      priority: parsed.data.priority,
      enabled: parsed.data.enabled,
    });
    // Re-materialise so the new identity is immediately active.
    const m = await materializeSshIdentities();
    return NextResponse.json({ identity: row, materialize: m }, { status: 201 });
  } catch (e: unknown) {
    if (errCode(e) === 'P2002') {
      return NextResponse.json({ error: `An SSH identity named "${parsed.data.name}" already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: errMessage(e) || 'Failed to create identity' }, { status: 400 });
  }
}
