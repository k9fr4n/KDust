// src/app/api/mcp/catalog/route.ts
//
// Static catalog of MCP servers KDust knows about (Franck 2026-05-09).
// Read-only. Powers the chat header bubble at /chat/[id]; could also
// feed a future /settings/mcp dashboard.
//
// Auth: relies on the global APP_PASSWORD JWT middleware.

import { NextResponse } from 'next/server';
import { MCP_CATALOG } from '@/lib/mcp/catalog';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ catalog: MCP_CATALOG });
}
