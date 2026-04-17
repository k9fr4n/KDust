/**
 * Advisory cron categories. Each project auto-provisions one cron per
 * category on creation (see POST /api/projects). A run produces a
 * strict JSON block that is parsed and stored in ProjectAdvice.
 */

export type AdviceCategory =
  | 'security'
  | 'performance'
  | 'code_quality'
  | 'improvement'
  | 'documentation';

export const ADVICE_CATEGORIES: AdviceCategory[] = [
  'security',
  'performance',
  'code_quality',
  'improvement',
  'documentation',
];

export const CATEGORY_LABELS: Record<AdviceCategory, string> = {
  security: 'Sécurité',
  performance: 'Performance',
  code_quality: 'Code quality',
  improvement: 'Amélioration',
  documentation: 'Documentation',
};

export const CATEGORY_EMOJI: Record<AdviceCategory, string> = {
  security: '🔒',
  performance: '⚡',
  code_quality: '🧹',
  improvement: '🚀',
  documentation: '📚',
};

/**
 * Per-category, weekly schedule (Monday). We stagger by 10 minutes so
 * the 5 concurrent Dust calls for a single project don't all hit at
 * the same second. The runner also has a per-project lock so siblings
 * would just skip rather than pile up, but spacing keeps logs clean.
 */
export const CATEGORY_SCHEDULES: Record<AdviceCategory, string> = {
  security: '0 3 * * 1',
  performance: '10 3 * * 1',
  code_quality: '20 3 * * 1',
  improvement: '30 3 * * 1',
  documentation: '40 3 * * 1',
};
