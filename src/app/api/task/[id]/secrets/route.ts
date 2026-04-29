// src/app/api/task/[id]/secrets/route.ts
//
// TaskSecret bindings for a given task (Franck 2026-04-21 21:45).
//   GET  /api/task/:id/secrets  - list bindings (env -> secret name)
//   POST /api/task/:id/secrets  - upsert a single binding
//
// DELETE lives at /api/task/:id/secrets/:envName.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { listBindingsForTask, upsertBinding } from '@/lib/secrets/repo';
import { badRequest, notFound } from "@/lib/api/responses";

export const runtime = 'nodejs';

async function taskExists(id: string): Promise<boolean> {
  const row = await db.task.findUnique({ where: { id }, select: { id: true } });
  return Boolean(row);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await taskExists(id))) {
    return notFound('Task not found');
  }
  const bindings = await listBindingsForTask(id);
  return NextResponse.json({ bindings });
}

const UpsertSchema = z.object({
  envName: z.string().min(1).max(64),
  secretName: z.string().min(2).max(64),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await taskExists(id))) {
    return notFound('Task not found');
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }
  const parsed = UpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    await upsertBinding(id, parsed.data.envName, parsed.data.secretName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'Failed to upsert binding' },
      { status: 400 },
    );
  }
}
