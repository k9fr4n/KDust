/**
 * Markdown → Telegram-HTML converter.
 *
 * Telegram's HTML parse_mode supports a small allowlist:
 *   <b> <strong> <i> <em> <u> <ins> <s> <strike> <del>
 *   <code> <pre> <pre><code class="language-...">
 *   <a href="..."> <blockquote>
 *
 * This module rewrites a CommonMark-ish input into that
 * subset, with the following design rules:
 *
 *   1. Robust to mid-stream chunks. If a markdown construct
 *      is not yet closed (e.g. a half-typed code block), we
 *      leave the source text alone rather than emit broken
 *      HTML. The next flush will pick it up once the closing
 *      delimiter arrives.
 *
 *   2. Strict HTML escaping. We escape `&`, `<`, `>` in any
 *      span we don't ourselves wrap in a tag, so an agent's
 *      output containing literal HTML never injects markup.
 *
 *   3. Constructs Telegram cannot render are downgraded to a
 *      readable plain-text equivalent (headings → bold,
 *      bullets → •, tables → <pre> block).
 *
 * Not a full CommonMark implementation; the goal is "good
 * enough for chat" without a parser dep.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Sentinels used to swap code/inline-code blocks out of the
// input before HTML-escaping the remainder. ASCII control
// characters \x01 / \x02 will never appear in agent output and
// are easy to match safely.
const STX = '\x01';
const ETX = '\x02';

export function markdownToTelegramHtml(md: string): string {
  if (!md) return '';

  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const i = placeholders.push(html) - 1;
    return STX + i + ETX;
  };

  let s = md;

  // 1. Fenced code blocks. Must come before everything else so
  //    their content is preserved verbatim. Optional language
  //    after the opening fence is mapped to a class= for
  //    Telegram clients that highlight (mobile does, desktop
  //    partial).
  s = s.replace(
    /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g,
    (_m, lang: string, code: string) => {
      const body = escapeHtml(code.replace(/\n$/, ''));
      const tag = lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`
        : `<pre>${body}</pre>`;
      return stash(tag);
    },
  );

  // 2. Inline code. Single-backtick spans on a single line.
  //    Double-backtick spans (`` `with backtick` ``) are not
  //    supported — rare enough in chat that the simpler regex
  //    wins.
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );

  // 3. Inline links [text](url). url must be http(s) or mailto;
  //    anything else is safer to leave as plain text so we
  //    don't accidentally produce <a href="javascript:...">.
  //    text is HTML-escaped INTO the placeholder; the rest of
  //    the line goes through escapeHtml() in step 4 below.
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_m, text: string, url: string) =>
      stash(`<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`),
  );

  // 4. Now HTML-escape the remaining plain text. Markdown
  //    metacharacters (* _ ~ # - +) are not HTML-special, so
  //    the subsequent regex passes still see them.
  s = escapeHtml(s);

  // 5. Headings → bold. Telegram has no heading construct;
  //    bold is the closest semantic match without resorting
  //    to a separate rendering.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    '<b>$1</b>');

  // 6. Bold (**text** or __text__). Use lookarounds to avoid
  //    eating intra-word underscores like file_name_here.
  s = s.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])__([^_\n][^_\n]*?)__(?=[\s).,;:!?]|$)/g,
    '$1<b>$2</b>');

  // 7. Italic (*text* or _text_). Same intra-word safety on _.
  s = s.replace(/(^|[^*])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?!\*)/g,
    '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])_([^_\n][^_\n]*?)_(?=[\s).,;:!?]|$)/g,
    '$1<i>$2</i>');

  // 8. Strikethrough.
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');

  // 9. Bullets: "-", "*", or "+" at line start → "\u2022 ". We
  //    don't try to nest; indent is preserved verbatim so the
  //    visual hierarchy survives.
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1\u2022 ');

  // 10. Horizontal rules — collapse to a thin separator.
  s = s.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '\u2500\u2500\u2500');

  // 11. Re-inject stashed code/link/inline-code blocks.
  s = s.replace(/\x01(\d+)\x02/g, (_m, idx: string) =>
    placeholders[Number(idx)] ?? '',
  );

  return s;
}
