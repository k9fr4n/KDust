/**
 * CopySourceButton — copies a raw string (markdown source, log,
 * prompt, …) to the clipboard with a transient ✓ flash.
 *
 * Drop-in companion for any section that renders Markdown via
 * <MessageMarkdown>: the rendered DOM is HTML, but the user (and
 * Franck, 2026-05-16) wants to recover the original source. This
 * button takes the raw string as a prop so what gets copied is
 * exactly what was passed to MessageMarkdown, not innerText.
 */
'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { UI_FLASH_MS } from '@/lib/constants';

export function CopySourceButton({
  text,
  label = 'Copy source',
  className = '',
}: {
  /** Raw text to write to the clipboard. */
  text: string;
  /** Tooltip / aria-label. */
  label?: string;
  /** Extra utility classes (positioning, sizing…). */
  className?: string;
}) {
  const [done, setDone] = useState(false);
  // Stop the click from bubbling up: the button is typically
  // mounted INSIDE a <summary>, and a bubbling click would toggle
  // the parent <details>, closing the section as soon as the user
  // clicks the icon (Franck 2026-05-16 "le bouton pour copier
  // semble ne pas fonctionner"). Combined with preventDefault to
  // be safe across browsers.
  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts (e.g. http://localhost
        // when not on a loopback exception, or http:// dev
        // deployments). Uses a hidden textarea + execCommand,
        // deprecated but still universally available.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand('copy');
        } finally {
          document.body.removeChild(ta);
        }
      }
      setDone(true);
      setTimeout(() => setDone(false), UI_FLASH_MS);
    } catch {
      /* clipboard blocked (permission); silent no-op */
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={done ? 'Copied!' : label}
      aria-label={label}
      className={
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ' +
        'text-slate-500 hover:text-brand-600 hover:bg-slate-100 ' +
        'dark:hover:bg-slate-800 transition-colors ' +
        className
      }
    >
      {done ? (
        <>
          <Check size={12} className="text-emerald-500" />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy size={12} />
          <span className="sr-only sm:not-sr-only">Copy</span>
        </>
      )}
    </button>
  );
}
