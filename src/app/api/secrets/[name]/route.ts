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
  renameSecret,
  updateSecretDescription,
  updateSecretShellInject,
  updateSecretValue,
} from '@/lib/secrets/repo';
import { badRequest, conflict, notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';

// PUT accepts any subset of {name, value, description}. `name` is
// a rename and propagates via Prisma's onUpdate: Cascade to every
// TaskSecret / McpServerSecret binding. Order of application below
// is: value (privileged rotation), then description, then rename
// last — so a partial failure on rename does not leave a half-
// rotated secret in an inconsistent state.
const UpdateSchema = z
  .object({
    name: z.string().min(2).max(64).optional(),
    value: z.string().min(1).optional(),
    description: z.string().max(256).nullable().optional(),
    // ADR-0031: toggle IDE-terminal exposure. Metadata-only flag.
    shellInject: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.value !== undefined ||
      d.description !== undefined ||
      d.shellInject !== undefined,
    {
      message: 'At least one of name/value/description/shellInject must be provided',
    },
  );

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
    if (parsed.data.shellInject !== undefined) {
      await updateSecretShellInject(name, parsed.data.shellInject);
    }
    if (parsed.data.name !== undefined && parsed.data.name !== name) {
      await renameSecret(name, parsed.data.name);
    }
    return NextResponse.json({ ok: true, name: parsed.data.name ?? name });
  } catch (e: unknown) {
    if (errCode(e) === 'P2025') {
      return notFound(`Secret "${name}" not found`);
    }
    // Unique-constraint on the new name during a rename.
    if (errCode(e) === 'P2002') {
      return conflict(
        `A secret named "${parsed.data.name ?? name}" already exists.`,
      );
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
