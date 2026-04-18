/**
 * MessageMarkdown
 * ---------------
 * Renders a chat message's content as Markdown with:
 *  - GitHub-flavoured extensions (tables, strikethrough, task lists,
 *    autolinks) via remark-gfm
 *  - Syntax-highlighted fenced code blocks via rehype-highlight
 *    (powered by highlight.js; theme imported in layout.tsx)
 *  - Links forced to open in a new tab with a safe rel attribute
 *
 * We intentionally do NOT pull in rehype-sanitize: the content comes
 * from the Dust agent pipe (not untrusted user HTML), react-markdown
 * already escapes raw HTML by default (no `rehype-raw` here), and
 * adding a sanitizer would strip syntax-highlighted class names on
 * code blocks.
 *
 * Performance note: react-markdown re-parses on every prop change.
 * During streaming the `streamedText` prop changes on each token; a
 * full re-parse on each token is fine in practice (<5ms for typical
 * agent replies) but we keep the tree shallow and avoid extra plugins.
 */
'use client';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** Shared prop: the raw markdown text to render. */
export interface MessageMarkdownProps {
  /** Raw markdown string (empty or partial is fine, used for streams). */
  children: string;
  /**
   * Tone: 'user' forces a white-on-blue bubble look where links
   * stay readable; 'agent'/'system' use the default neutral theme.
   * Purely a styling hint — the markdown pipeline is the same.
   */
  tone?: 'user' | 'agent' | 'system';
}

export function MessageMarkdown({ children, tone = 'agent' }: MessageMarkdownProps) {
  const linkCls =
    tone === 'user'
      ? 'underline decoration-white/60 hover:decoration-white'
      : 'text-brand-600 dark:text-brand-400 hover:underline';
  const codeInlineCls =
    tone === 'user'
      ? 'bg-white/15 rounded px-1 py-0.5 font-mono text-[0.85em]'
      : 'bg-slate-200 dark:bg-slate-900 rounded px-1 py-0.5 font-mono text-[0.85em]';
  // Code blocks: wrap long lines instead of showing a horizontal
  // scrollbar (per Franck 2026-04-19 00:17 "je ne veux pas de
  // scrollbar horizontal, je veux que le texte aille a la ligne").
  // whitespace-pre-wrap preserves indentation and line breaks while
  // wrapping at whitespace; break-words handles unbroken tokens
  // (long URLs, hashes) without overflowing the bubble.
  const preCls =
    tone === 'user'
      ? 'bg-slate-900 text-slate-100 rounded-md p-3 my-2 whitespace-pre-wrap break-words text-[0.85em]'
      : 'bg-slate-900 text-slate-100 dark:bg-black rounded-md p-3 my-2 whitespace-pre-wrap break-words text-[0.85em]';

  return (
    <div className="kdust-md leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // We cast the plugin tuple because rehype-highlight's types don't
        // export an exact options shape compatible with the generic we
        // get here. `ignoreMissing: true` prevents a hard error when the
        // agent tags a code block with an unknown language.
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: true }]]}
        components={{
          a: ({ href, children: c, ...rest }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={linkCls}
              {...rest}
            >
              {c}
            </a>
          ),
          // Inline <code> vs. fenced block <pre><code>: react-markdown v9
          // passes `inline` in a non-standard place. We detect a block
          // via the presence of a `language-*` className.
          code: ({ className, children: c, ...rest }) => {
            const isBlock = /language-/.test(className ?? '');
            if (isBlock) {
              return (
                <code className={(className ?? '') + ' hljs'} {...rest}>
                  {c}
                </code>
              );
            }
            return (
              <code className={codeInlineCls} {...rest}>
                {c}
              </code>
            );
          },
          pre: ({ children: c, ...rest }) => (
            <pre className={preCls} {...rest}>
              {c}
            </pre>
          ),
          // Tables: give them a subtle border + header shade.
          table: ({ children: c }) => (
            <div className="overflow-x-auto my-2">
              <table className="text-xs border-collapse border border-slate-300 dark:border-slate-700">
                {c}
              </table>
            </div>
          ),
          th: ({ children: c }) => (
            <th className="border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-1 text-left font-semibold">
              {c}
            </th>
          ),
          td: ({ children: c }) => (
            <td className="border border-slate-300 dark:border-slate-700 px-2 py-1">
              {c}
            </td>
          ),
          ul: ({ children: c }) => <ul className="list-disc pl-5 my-1">{c}</ul>,
          ol: ({ children: c }) => <ol className="list-decimal pl-5 my-1">{c}</ol>,
          li: ({ children: c }) => <li className="my-0.5">{c}</li>,
          h1: ({ children: c }) => <h1 className="text-lg font-bold mt-2 mb-1">{c}</h1>,
          h2: ({ children: c }) => <h2 className="text-base font-bold mt-2 mb-1">{c}</h2>,
          h3: ({ children: c }) => <h3 className="text-sm font-bold mt-1.5 mb-0.5">{c}</h3>,
          blockquote: ({ children: c }) => (
            <blockquote className="border-l-4 border-slate-300 dark:border-slate-600 pl-3 my-2 italic text-slate-600 dark:text-slate-400">
              {c}
            </blockquote>
          ),
          p: ({ children: c }) => <p className="my-1 whitespace-pre-wrap">{c}</p>,
          hr: () => <hr className="my-3 border-slate-200 dark:border-slate-700" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
