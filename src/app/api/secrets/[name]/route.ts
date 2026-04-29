// src/app/api/secrets/[name]/route.ts
//
// Single-secret operations (Franck 2026-04-21 21:45).
//   PUT    /api/secrets/:name         - update value and/or description
//   DELETE /api/secrets/:name[?force] - delete the secret
//
// No GET here on purpose: listing returns metadata only, and we
// refuse to ever expose a plaintext value through the HTTP surface.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errMessage, errCode } from '@/lib/errors';
import {
  deleteSecret,
  updateSecretDescription,
  updateSecretValue,
} from '@/lib/secrets/repo';
import { badRequest, conflict, notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';

const UpdateSchema = z
  .object({
    value: z.string().min(1).optional(),
    description: z.string().max(256).nullable().optional(),
  })
  .refine((d) => d.value !== undefined || d.description !== undefined, {
    message: 'At least one of value/description must be provided',
  });

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    // Order matters only for idempotency — value update is the
    // privileged op; we apply description after so a partial
    // failure still leaves the value rotated.
    if (parsed.data.value !== undefined) {
      await updateSecretValue(name, parsed.data.value);
    }
    if (parsed.data.description !== undefined) {
      await updateSecretDescription(name, parsed.data.description);
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    if (errCode(e) === 'P2025') {
      return notFound(`Secret "${name}" not found`);
    }
    return NextResponse.json(
      { error: (errMessage(e) || 'Failed to update secret') },
      { status: 400 },
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const force = new URL(req.url).searchParams.get('force') === 'true';
  try {
    await deleteSecret(name, force);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    if (errCode(e) === 'P2025') {
      return notFound(`Secret "${name}" not found`);
    }
    // "still bound" — surface a 409 so the UI can prompt confirmation.
    if (errMessage(e).includes('still bound')) {
      return conflict(errMessage(e));
    }
    return NextResponse.json(
      { error: (errMessage(e) || 'Failed to delete secret') },
      { status: 400 },
    );
  }
}
