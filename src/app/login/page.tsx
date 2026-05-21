'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/Button';
import { DocumentTitle } from '@/components/DocumentTitle';

/**
 * Safe JSON-or-text reader for an error response. The server always
 * answers `{ error: string }` on the happy unhappy path, but if a
 * reverse-proxy rewrites the body, or Next.js serves a generic HTML
 * 500 page (e.g. SESSION_SECRET unset → issueSession throws), the
 * naive `(await res.json()).error` crashes the submit handler and
 * the form looks frozen ("nothing happens"). This helper degrades
 * to plain text and finally to the HTTP status.
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.clone().json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error.length > 0) return data.error;
  } catch {
    /* not JSON — fall through */
  }
  try {
    const text = (await res.text()).trim();
    if (text.length > 0 && text.length < 200) return text;
  } catch {
    /* unreadable body */
  }
  return `HTTP ${res.status}`;
}

function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return; // anti double-submit
    setErr(null);
    if (password.length === 0) {
      setErr('Mot de passe requis');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        // Belt-and-suspenders: ensure cookies set in the response are
        // honoured by the browser even when the page is served from a
        // different host than the API in dev / proxy setups.
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) {
        setErr(await readErrorMessage(res));
        return;
      }
      // Resolve target before navigation; fall back to / on anything fishy.
      const from = params.get('from');
      const target = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';
      // Hard navigation, NOT router.replace(). Rationale: the root
      // layout decides chrome visibility (Nav / DustAuthBanner /
      // padded <main>) from the request `x-pathname` header, and
      // Next.js App Router does NOT re-render the root layout on a
      // soft client-side navigation between segments under the same
      // tree. So a router.replace from /login to / would leave the
      // chromeless decision cached and the user would land on / with
      // no menu until a manual reload (Franck 2026-05-09 23:54).
      // window.location.replace forces a full document load that
      // re-evaluates the root layout with x-pathname = "/".
      window.location.replace(target);
      // Keep the spinner up: location.replace tears down the page
      // shortly after, but flipping `loading` back off would briefly
      // re-enable the button and let the user re-click.
      return;
    } catch (e) {
      // Network error, CSP block, aborted request, etc. Surface it
      // instead of leaving the user staring at "Connexion...".
      const msg = e instanceof Error ? e.message : 'Network error';
      setErr(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-80 space-y-3 p-6 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <h1 className="text-xl font-semibold">KDust — Login</h1>
      <input
        type="password"
        placeholder="mot de passe"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2"
        autoFocus
      />
      {err && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 break-words">
          {err}
        </p>
      )}
      <Button type="submit" disabled={loading || password.length === 0} className="w-full">
        {loading ? 'Connexion...' : 'Se connecter'}
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <DocumentTitle title="Sign in" />
      {/* Stylised KDust watermark. `aria-hidden` because it is purely
          decorative — screen readers should not read the brand name
          twice (the form heading already says "KDust — Login").
          `select-none` and `pointer-events-none` keep it from
          interfering with the form interaction. */}
      <div
        aria-hidden
        className="pointer-events-none select-none absolute inset-0 flex items-center justify-center"
      >
        <span
          className={[
            // Huge, responsive, italic, ultra-bold.
            'font-black italic tracking-tighter',
            'text-[24vw] sm:text-[20vw] md:text-[18vw] leading-none',
            // Brand gradient text — relies on Tailwind brand-* palette
            // already used elsewhere in the app.
            'bg-gradient-to-br from-brand-500 via-brand-600 to-indigo-500',
            'bg-clip-text text-transparent',
            // Faded so it stays a background, not a foreground.
            'opacity-10 dark:opacity-[0.08]',
            'drop-shadow-sm',
          ].join(' ')}
        >
          KDust
        </span>
      </div>
      <div className="relative z-10">
        <Suspense fallback={<div>Chargement...</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
