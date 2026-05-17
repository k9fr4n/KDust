/**
 * useBlobDownload (Franck 2026-05-17)
 * -----------------------------------
 * Triggers a file download by routing the bytes through a
 * `blob:` URL instead of letting the browser follow an `<a
 * href="http://..." download>` link directly.
 *
 * Why: Chrome's "Insecure download blocking" policy blocks an
 * ever-growing list of file types when the download target lives
 * on an HTTP origin (we run KDust on `http://<ip>:4000`). The
 * page itself loads fine but the moment Chrome sees a download
 * coming from HTTP it silently aborts and surfaces a console
 * warning:
 *
 *   "The file at 'http://.../api/files/fil_xxx?download=1' was
 *    loaded over an insecure connection. This file should be
 *    served over HTTPS."
 *
 * Workaround: fetch the bytes via XHR (same auth cookie, same
 * route), wrap them in a Blob, then trigger a synthetic click on
 * an anchor pointing at the `blob:` URL. Blob URLs inherit the
 * document's secure-context flag and are not subject to the
 * insecure-download check.
 *
 * Trade-off: the entire file transits in RAM client-side. Fine
 * for agent artefacts (kB–MB range), would be wasteful for
 * hundred-MB downloads — not our use case.
 *
 * Note: the real fix is to put KDust behind TLS. This hook is
 * the in-app stopgap so downloads keep working until that's
 * done.
 */
'use client';
import { useCallback, useState } from 'react';

export type BlobDownloadState = {
  isDownloading: boolean;
  error: string | null;
};

export function useBlobDownload(): BlobDownloadState & {
  download: (url: string, filename: string) => Promise<void>;
  reset: () => void;
} {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(async (url: string, filename: string) => {
    setIsDownloading(true);
    setError(null);
    let objectUrl: string | null = null;
    try {
      // `credentials: 'same-origin'` is the default for fetch on
      // a same-origin URL; spelled out so reviewers don't second
      // guess the auth path (cookie session is required by the
      // /api/files route).
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      // Must be in the DOM in some browsers for the click to take
      // effect; rip it out immediately after.
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      // Defer revoke to the next tick so the click has time to
      // start the download in all browsers.
      if (objectUrl) {
        const u = objectUrl;
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      }
      setIsDownloading(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { isDownloading, error, download, reset };
}
