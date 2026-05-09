// src/app/api/settings/ssh/[name]/route.ts
//
// Single-identity ops (Franck 2026-05-09, ADR-0011).
//   PATCH  /api/settings/ssh/:name  - update / rotate
//   DELETE /api/settings/ssh/:name  - delete
//
// No GET: listing already returns metadata, and the private key is
// never readable through HTTP by design.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deleteIdentity, updateIdentity } from '@/lib/ssh/identity';
import { materializeSshIdentities } from '@/lib/ssh/bootstrap';
import { badRequest, notFound } from '@/lib/api/responses';
import { errMessage, errCode } from '@/lib/errors';

export const runtime = 'nodejs';

const PatchSchema = z
  .object({
    hostPattern: z.string().min(1).max(128).optional(),
    privateKey: z.string().min(40).optional(),
    description: z.string().max(256).nullable().optional(),
    priority: z.number().int().min(0).max(9999).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

export async function PATCH(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return badRequest('Invalid JSON body'); }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const row = await updateIdentity(name, parsed.data);
    const m = await materializeSshIdentities();
    return NextResponse.json({ identity: row, materialize: m });
  } catch (e: unknown) {
    if (errCode(e) === 'P2025') return notFound(`SSH identity "${name}" not found`);
    return NextResponse.json({ error: errMessage(e) || 'Failed to update identity' }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    await deleteIdentity(name);
    const m = await materializeSshIdentities();
    return NextResponse.json({ ok: true, materialize: m });
  } catch (e: unknown) {
    if (errCode(e) === 'P2025') return notFound(`SSH identity "${name}" not found`);
    return NextResponse.json({ error: errMessage(e) || 'Failed to delete identity' }, { status: 400 });
  }
}
