// fetchPatch.ts
// Workaround temporaire pour dust-tt/dust#26472.
// Le serveur Dust émet un 307 vers /api/sse/api/v1/... (double /api prefix),
// ce qui 404. Le SDK suit les redirects automatiquement et ne voit que le 404.
// Ce patch intercepte le redirect et corrige l'URL avant que le SDK ne le voie.
// → Devient un no-op une fois le fix serveur (#26513) déployé.

const SSE_EVENTS_RE =
  /\/api\/v1\/w\/[^/]+\/assistant\/conversations\/[^/]+\/(events|messages\/[^/]+\/events)/;

let patched = false;

export function applyDustFetchPatch(): void {
  if (patched) return;
  patched = true;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1] = {},
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url ?? '';

    // Hors scope SSE → fetch natif inchangé
    if (!SSE_EVENTS_RE.test(url)) {
      return originalFetch(input, init);
    }

    // On prend le contrôle du redirect pour corriger la Location
    let res = await originalFetch(input, { ...init, redirect: 'manual' });

    let hops = 0;
    while ([301, 302, 307, 308].includes(res.status) && hops < 5) {
      hops++;
      const location = res.headers.get('location');
      if (!location) break;

      // Le fix : supprime le double prefix /api/sse/api/ → /api/sse/
      const fixed = location.replace('/api/sse/api/', '/api/sse/');
      const nextUrl = new URL(fixed, url).toString();

      console.log(
        `[fetchPatch] SSE redirect fix (hop ${hops}): ${location} → ${fixed}`,
      );

      res = await originalFetch(nextUrl, { ...init, redirect: 'manual' });
    }

    return res;
  };

  console.log('[fetchPatch] Dust SSE redirect patch applied (#26472)');
}