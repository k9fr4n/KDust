'use client';

/**
 * Inline image renderer with lightbox + download (Franck
 * 2026-04-23 16:46).
 *
 * Used from <MessageMarkdown /> in place of the default <img>.
 * Behaviour:
 *   - Renders a small thumbnail (max-h-48) inside the message
 *     bubble so long answers with images stay scannable.
 *   - Click thumbnail → full-screen lightbox overlay with the
 *     image at natural size (capped to viewport). Backdrop click
 *     or Escape closes it.
 *   - Download button in the lightbox toolbar calls
 *     /api/files/:sId?download=1 which adds Content-Disposition:
 *     attachment so the browser saves to disk instead of
 *     navigating. Falls back to the raw src (e.g. external http
 *     image) with a <a download> attribute.
 *
 * The component accepts the same src/alt/title as a markdown
 * <img>; src has already been rewritten to /api/files/fil_xxx by
 * the markdown component when the source was a Dust file id.
 */
import { useEffect, useState } from 'react';
import { Download, X, ExternalLink } from 'lucide-react';

type Props = {
  src: string;
  alt?: string;
  title?: string;
};

export function ChatImage({ src, alt, title }: Props) {
  const [open, setOpen] = useState(false);

  // Close on Escape when the lightbox is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Build the download href. If src points at our proxy, add
  // ?download=1 so the route handler sets Content-Disposition. For
  // external URLs (http(s) outside our origin), just use the raw
  // src with a `download` attr — browsers will honour it when the
  // resource is same-origin or CORS-allowed.
  const downloadHref = src.startsWith('/api/files/')
    ? `${src}${src.includes('?') ? '&' : '?'}download=1`
    : src;

  return (
    <>
      {/* Thumbnail wrapper: using a <span> rather than a <button>
          so we can nest a download <a> without breaking the DOM
          (buttons can't contain interactive descendants). The
          container is still keyboard-actionable via role+tabIndex
          so Enter / Space still open the lightbox. */}
      <span
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-block my-2 max-w-full group relative align-top"
        title={title ?? alt ?? 'Open image'}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? ''}
          className="max-h-48 max-w-full h-auto w-auto rounded-md border border-slate-200 dark:border-slate-700 object-contain group-hover:opacity-90 transition-opacity cursor-zoom-in"
          loading="lazy"
        />
        {/* Floating download button on the thumbnail (Franck
            2026-04-23 16:57). Absolute-positioned top-right,
            hidden by default, fades in on hover / focus-within
            so the thumbnail stays clean at rest. stopPropagation
            on click so the surrounding "open lightbox" handler
            does not fire. */}
        <a
          href={downloadHref}
          download
          onClick={(e) => e.stopPropagation()}
          className="absolute top-1 right-1 inline-flex items-center justify-center w-7 h-7 rounded-md bg-black/55 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-black/75"
          title="Download"
          aria-label="Download image"
        >
          <Download size={14} />
        </a>
      </span>

      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          {/* Toolbar: download + open-in-new-tab + close. Stop
              propagation so clicks on the buttons don't close
              the overlay via the backdrop handler. */}
          <div
            className="flex items-center justify-end gap-2 p-3 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <a
              href={downloadHref}
              download
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm"
              title="Download"
            >
              <Download size={14} /> Download
            </a>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm"
              title="Open in new tab"
            >
              <ExternalLink size={14} />
            </a>
            <button
              onClick={() => setOpen(false)}
              className="inline-flex items-center justify-center w-8 h-8 rounded bg-white/10 hover:bg-white/20"
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Image pane — click on the image does NOT close (user
              may want to right-click > Save As). Click on the
              surrounding padding still closes via the backdrop. */}
          <div className="flex-1 flex items-center justify-center px-4 pb-4 overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt ?? ''}
              onClick={(e) => e.stopPropagation()}
              className="max-w-full max-h-full object-contain rounded shadow-2xl"
            />
          </div>
        </div>
      )}
    </>
  );
}
