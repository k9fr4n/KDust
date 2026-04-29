/**
 * Shared className tokens. Pulled out of the legacy TaskForm.tsx so
 * each section component gets the same visual chrome without
 * duplicating long Tailwind strings. Pure constants; no logic.
 */
export const field =
  'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';
export const optCls =
  'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100';
export const sectionCls =
  'border border-slate-300 dark:border-slate-700 rounded-md p-4 space-y-3 bg-white/60 dark:bg-slate-900/30';
export const legendCls =
  'px-2 text-sm font-semibold text-slate-700 dark:text-slate-300';
