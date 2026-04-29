'use client';
import { useEffect, useRef } from 'react';
import type { SectionProps } from './state';
import { field, sectionCls, legendCls } from './styles';

/**
 * Prompt textarea with the auto-grow effect (Franck 2026-04-21
 * 22:40). Owns its own ref + useEffect so the parent component
 * doesn't have to plumb them through.
 */
export function PromptSection({ form, setForm }: SectionProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [form.prompt]);
  return (
      <fieldset className={sectionCls}>
        <legend className={legendCls}>Prompt</legend>
        <textarea
          ref={promptRef}
          // resize:none disables the manual drag handle because the
          // effect above already sizes the field to its content. We
          // also cap max-h to 75vh so extreme prompts scroll internally
          // instead of pushing the rest of the form off-screen.
          className={`${field} min-h-48 max-h-[75vh] resize-none font-mono text-sm overflow-y-auto`}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          required
        />
        <p className="text-xs text-slate-500">
          Sent as-is to the agent. When <em>Automation push</em> is on,
          KDust appends a context footer summarizing branch, task id,
          and safety constraints. Placeholders{' '}
          <code className="font-mono">{'{{PROJECT}}'}</code> and{' '}
          <code className="font-mono">{'{{PROJECT_PATH}}'}</code> are
          substituted at dispatch time — essential for{' '}
          <strong>generic tasks</strong>, optional (DRY) for
          project-bound tasks.
        </p>
      </fieldset>

  );
}
