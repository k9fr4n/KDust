// src/app/api/secrets/route.ts
//
// Secrets collection endpoints (Franck 2026-04-21 21:45).
//   GET    /api/secrets        - list metadata \(no values ever\)
//   POST   /api/secrets        - create a new secret
//
// All write endpoints expect a JSON body \(not multipart\) so the
// value transits encrypted over TLS only. We rely on the global
// middleware for auth \(APP_PASSWORD JWT cookie\) - no extra auth
// layer here.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSecret, listSecrets } from '@/lib/secrets/repo';
import { badRequest } from "@/lib/api/responses";

export const runtime = 'nodejs';

export async function GET() {
  const rows = await listSecrets();
  return NextResponse.json({ secrets: rows });
}

const CreateSchema = z.object({
  name: z.string().min(2).max(64),
  value: z.string().min(1),
  description: z.string().max(256).nullable().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const row = await createSecret(
      parsed.data.name,
      parsed.data.value,
      parsed.data.description ?? null,
    );
    // Ensure the value is not echoed back by mistake — we only
    // return the metadata DTO, which has no `value` field by design.
    return NextResponse.json({ secret: row }, { status: 201 });
  } catch (e: any) {
    // Common case: unique-constraint violation on `name`.
    if (String(e?.code) === 'P2002') {
      return NextResponse.json(
        { error: `A secret named "${parsed.data.name}" already exists.` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: e?.message ?? 'Failed to create secret' },
      { status: 400 },
    );
  }
}
