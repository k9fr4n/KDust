import { startFsServer, type FsServerHandle } from './fs-server';

// Module-level singleton (survives across requests in a given node process)
const g = globalThis as unknown as { __kdustMcp?: Map<string, Promise<FsServerHandle>> };
if (!g.__kdustMcp) g.__kdustMcp = new Map();
const cache = g.__kdustMcp!;

/**
 * Get or start the MCP fs server for a given project.
 * Each project has a dedicated MCP server chrooted to /projects/{name}.
 */
export async function getFsServerId(projectName: string): Promise<string> {
  const existing = cache.get(projectName);
  if (existing) {
    try {
      const handle = await existing;
      if (handle.serverId) return handle.serverId;
    } catch {
      cache.delete(projectName);
    }
  }
  const p = startFsServer(projectName);
  cache.set(projectName, p);
  try {
    const handle = await p;
    return handle.serverId;
  } catch (e) {
    cache.delete(projectName);
    throw e;
  }
}

/**
 * Drops the cached handle for a project so the next getFsServerId will
 * re-register a new transport with a freshly refreshed Dust access token.
 * Called from fs-server when the SSE stream errors out with 401 Unauthorized.
 */
export async function invalidateFsServer(projectName: string): Promise<void> {
  const entry = cache.get(projectName);
  cache.delete(projectName);
  if (!entry) return;
  try {
    const handle = await entry;
    await handle.transport.close().catch(() => {});
  } catch {
    /* ignore */
  }
}
