// src/app/settings/mcp/page.tsx
//
// Docker MCP Gateway settings UI (Franck 2026-05-10, ADR-0012 V2).
// Replaces scripts/seed-mcp-gateway.mjs with a click-driven flow:
//
//   1. Servers section          declare which catalog servers are
//                               active in KDust (slug, name, toggle)
//   2. Secret bindings section  per-server, bind a Secret (by name)
//                               to a catalog secret key (e.g.
//                               `github.personal_access_token`)
//   3. Project filters section  per-project allow-list of tools
//                               (default-deny). Multi-select against
//                               the live tools list from the gateway
//
// The page is a server component; mutation forms are delegated to
// the McpGatewayEditor client component which hits the JSON API.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { listServers, listFilters } from '@/lib/mcp/gateway-repo';
import { listSecrets } from '@/lib/secrets/repo';
import { db } from '@/lib/db';
import { McpGatewayEditor } from './McpGatewayEditor';
import { listGatewayTools } from '@/lib/mcp/gateway-client';
import { loadCatalogToolsBySlug } from '@/lib/mcp/catalog-yaml';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: import('next').Metadata = { title: 'MCP' };

export default async function McpSettingsPage() {
  const [servers, filters, secretRows, projectRows, gatewayToolsResult, catalogToolsBySlug] =
    await Promise.all([
      listServers().catch((e) => {
        console.warn('[settings/mcp] listServers failed:', e);
        return [];
      }),
      listFilters().catch(() => []),
      listSecrets().catch(() => []),
      db.project.findMany({
        select: { fsPath: true, name: true },
        orderBy: { fsPath: 'asc' },
      }).catch(() => []),
      // Read-only probe of the live gateway. If unreachable we still
      // render the page so the operator can configure servers — the
      // tools list will just be empty.
      listGatewayTools().then(
        (tools) => ({ ok: true as const, tools }),
        (e: unknown) => ({
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        }),
      ),
      // Per-server tool inventory from kdust-custom.yaml — used
      // to scope the FilterEditorModal to the server being edited
      // (Franck 2026-05-18). Returns {} if the catalog file is
      // not mounted, in which case the modal falls back to the
      // full gateway tool list.
      loadCatalogToolsBySlug().catch((e) => {
        console.warn('[settings/mcp] loadCatalogToolsBySlug failed:', e);
        return {} as Record<string, string[]>;
      }),
    ]);

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-1">
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft size={14} /> Settings
        </Link>
        <h1 className="text-2xl font-bold">MCP Gateway</h1>
        <p className="text-sm text-slate-500">
          Docker MCP catalog servers exposed to your Dust agents,
          multiplexed through the sibling{' '}
          <code className="rounded bg-slate-100 dark:bg-slate-800 px-1">mcp-gateway</code>{' '}
          Compose service. Default-deny: an unconfigured project sees{' '}
          <strong>zero</strong> tools.
        </p>
        <p className="text-xs text-slate-500">
          Active servers in the gateway are the union of{' '}
          <code>--servers=...</code> in <code>docker-compose.yml</code>{' '}
          and the rows declared below. Tools listed below come from the{' '}
          live gateway; if the list is empty the gateway is either
          unreachable, exposes no enabled server, or just started
          (refresh in a few seconds).
        </p>
      </header>
      <McpGatewayEditor
        initialServers={servers}
        initialFilters={filters}
        secretNames={secretRows.map((s) => s.name)}
        projectFsPaths={projectRows.flatMap((p) => (p.fsPath ? [p.fsPath] : []))}
        gatewayTools={
          gatewayToolsResult.ok
            ? gatewayToolsResult.tools.map((t) => ({
                name: t.name,
                description: t.description ?? null,
              }))
            : []
        }
        gatewayError={gatewayToolsResult.ok ? null : gatewayToolsResult.error}
        catalogToolsBySlug={catalogToolsBySlug}
      />
    </div>
  );
}
