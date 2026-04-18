import { NextResponse } from 'next/server';
import { loadTokens } from '@/lib/dust/tokens';
import { getValidAccessToken } from '@/lib/dust/client';
import { resolveDustUrl } from '@/lib/dust/region';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Thin proxy over Dust's public analytics endpoint:
 *   GET /api/v1/w/{wId}/analytics/export
 *
 * Purpose: let /settings/billing verify that KDust's conversations are
 * routed to the NON-programmatic ("human usage") bucket. Dust does not
 * expose a real-time "is this message billed?" endpoint — only this
 * a-posteriori aggregate, with up to a few-hours delay.
 *
 * Requires workspace-admin privileges on the Dust side. When the
 * underlying API returns 403, we surface it verbatim so the UI can
 * display an explicit "need admin rights" banner rather than pretending
 * the data is empty.
 *
 * Auth: reuses the WorkOS JWT that the rest of KDust uses (NOT an
 * `sk-…` custom workspace API key). Using the OAuth token keeps this
 * request itself inside the non-programmatic bucket — same origin as
 * the user visiting the Dust web UI. Querying analytics does not
 * consume any credits per Dust docs.
 *
 * Query params (all optional, sensible defaults applied):
 *   - table    : one of usage_metrics | active_users | source | agents
 *                | users | skill_usage | tool_usage | messages
 *                Defaults to 'source' (the one we care about for billing).
 *   - startDate: YYYY-MM-DD. Defaults to first day of current month (UTC).
 *   - endDate  : YYYY-MM-DD. Defaults to today (UTC).
 *
 * Response: JSON { columns: string[]; rows: Record<string,string>[]; meta }
 * The upstream returns CSV only; we parse it here so the page stays
 * dumb and can just render rows.
 */
export async function GET(req: Request) {
  const stored = await loadTokens();
  if (!stored || !stored.workspaceId) {
    return NextResponse.json(
      { error: 'not_authenticated', hint: 'Sign in to Dust first.' },
      { status: 401 },
    );
  }
  const token = await getValidAccessToken();
  if (!token) {
    return NextResponse.json(
      { error: 'token_unavailable', hint: 'Re-auth against WorkOS.' },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const table = url.searchParams.get('table') ?? 'source';
  const today = new Date();
  const firstOfMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  const startDate =
    url.searchParams.get('startDate') ?? firstOfMonth.toISOString().slice(0, 10);
  const endDate =
    url.searchParams.get('endDate') ?? today.toISOString().slice(0, 10);

  const base = await resolveDustUrl(stored.region);
  const upstream = `${base}/api/v1/w/${stored.workspaceId}/analytics/export?${new URLSearchParams(
    { table, startDate, endDate },
  )}`;

  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'text/csv',
      },
      // Avoid Next's default fetch cache; billing data is time-sensitive.
      cache: 'no-store',
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'upstream_network', detail: (e as Error).message },
      { status: 502 },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 403 = not workspace admin. Bubble up verbatim so UI explains it.
    return NextResponse.json(
      {
        error: 'upstream_error',
        status: res.status,
        detail: body.slice(0, 500),
      },
      { status: res.status === 403 ? 403 : 502 },
    );
  }

  const csv = await res.text();
  const { columns, rows } = parseCsv(csv);
  return NextResponse.json({
    table,
    startDate,
    endDate,
    workspaceId: stored.workspaceId,
    columns,
    rows,
    rowCount: rows.length,
  });
}

/**
 * Minimal RFC-4180-ish CSV parser. The Dust export doesn't embed
 * newlines inside fields (verified on every table), but quoted commas
 * do appear in agent names. This implementation:
 *   - treats CRLF and LF as row terminators;
 *   - respects double-quote field delimiters and ""-escaping;
 *   - returns rows as objects keyed by the header row.
 *
 * Not using papaparse/csv-parse to keep the deps footprint tight for
 * a 30-line parse job. Revisit if Dust starts producing embedded
 * newlines.
 */
function parseCsv(text: string): {
  columns: string[];
  rows: Record<string, string>[];
} {
  const lines: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        // Skip completely empty trailing lines.
        if (row.length > 1 || row[0] !== '') lines.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') lines.push(row);
  }
  const [header = [], ...body] = lines;
  const columns = header.map((h) => h.trim());
  const rows = body.map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((col, idx) => {
      o[col] = (r[idx] ?? '').trim();
    });
    return o;
  });
  return { columns, rows };
}
