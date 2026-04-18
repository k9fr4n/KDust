import { db } from '@/lib/db';
import {
  BUILTIN_ADVICE_CATEGORIES,
  LEGACY_BUILTIN_KEYS,
  POINT_CATEGORY_KEYS,
} from './categories';

/**
 * Idempotently seed the built-in audit categories (v5) + clean up
 * any legacy v1/v3 leftovers. Called lazily from any read/write path
 * so we never need an explicit boot step.
 *
 * Cleanup semantics (per Franck 2026-04-18): legacy rows are
 * DELETED, not demoted. Specifically:
 *   - any AdviceCategoryDefault whose key isn't in v5 is deleted;
 *   - any Task with kind='advice' tied to a non-v5 category is deleted;
 *   - any ProjectAdvice tied to a non-v5 category is deleted.
 *
 * Safe to call concurrently (upsert by unique key; deletes are
 * idempotent).
 */
export async function ensureBuiltinsSeeded(): Promise<void> {
  // --- (1) upsert the 6 v5 builtins --------------------------------------
  for (const b of BUILTIN_ADVICE_CATEGORIES) {
    await db.adviceCategoryDefault.upsert({
      where: { key: b.key },
      create: {
        key: b.key,
        label: b.label,
        emoji: b.emoji,
        prompt: b.prompt,
        schedule: b.schedule,
        sortOrder: b.sortOrder,
        builtIn: true,
        enabled: true,
      },
      // Never overwrite user-edited fields on seed; only ensure the
      // row is flagged built-in (some legacy rows may have had it off).
      update: { builtIn: true },
    });
  }

  // --- (2) delete legacy AdviceCategoryDefault rows (anything not in v5)
  // We can't simply delete by LEGACY_BUILTIN_KEYS because the user
  // may have created custom categories. Strategy: delete only the
  // known legacy keys (priority + code_coverage), PLUS any builtIn
  // row whose key isn't in v5 (catches old FR-era labels or any
  // previously-shipped builtin that isn't listed anymore).
  const v5 = new Set<string>(POINT_CATEGORY_KEYS);
  const knownLegacy = [...LEGACY_BUILTIN_KEYS];
  const allDefaults = await db.adviceCategoryDefault.findMany({
    select: { id: true, key: true, builtIn: true },
  });
  const keysToWipe: string[] = [];
  for (const d of allDefaults) {
    if (v5.has(d.key)) continue; // current v5 builtin -> keep
    if (knownLegacy.includes(d.key as (typeof LEGACY_BUILTIN_KEYS)[number])) {
      keysToWipe.push(d.key);
      continue;
    }
    // Custom-created by the user: leave it alone (only builtIn legacy
    // rows are auto-wiped). This preserves any ad-hoc category the
    // user might have added via the Settings UI.
    if (d.builtIn) keysToWipe.push(d.key);
  }
  if (keysToWipe.length > 0) {
    const [deletedAdvices, deletedTasks, deletedDefaults] = await db.$transaction([
      db.projectAdvice.deleteMany({ where: { category: { in: keysToWipe } } }),
      db.task.deleteMany({
        where: { kind: 'advice', category: { in: keysToWipe } },
      }),
      db.adviceCategoryDefault.deleteMany({
        where: { key: { in: keysToWipe } },
      }),
    ]);
    console.log(
      `[audit/defaults] v5 migration: wiped ${deletedDefaults.count} legacy default(s) (${keysToWipe.join(', ')}), ` +
        `${deletedTasks.count} task(s), ${deletedAdvices.count} advice row(s). ` +
        `New audit tasks will be auto-provisioned on first /projects/:id visit or API call.`,
    );
  }

  // --- (3) rename old advice task display names that still carry the
  // v3 "priority" wording. Cheap sweep so dashboards stay consistent.
  const legacyNamed = await db.task.findMany({
    where: {
      kind: 'advice',
      OR: [
        { name: { startsWith: 'Advice: Priority advice ' } },
        { name: { startsWith: 'Conseils: ' } },
      ],
    },
    select: { id: true, name: true, category: true },
  });
  for (const t of legacyNamed) {
    // These should have been deleted in step (2). Only left over if
    // someone manually re-tagged the task to a v5 category slug.
    const category = t.category ?? '';
    const label =
      BUILTIN_ADVICE_CATEGORIES.find((c) => c.key === category)?.label ?? category;
    const next = t.name.replace(
      /^(Conseils: |Advice: Priority advice )/,
      `Audit: ${label} — `,
    );
    if (next !== t.name) {
      await db.task.update({ where: { id: t.id }, data: { name: next } });
    }
  }
}

export type AdviceDefault = {
  id: string;
  key: string;
  label: string;
  emoji: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  sortOrder: number;
  builtIn: boolean;
};

/** Fetch all categories, seeded if needed. */
export async function listAdviceDefaults(): Promise<AdviceDefault[]> {
  await ensureBuiltinsSeeded();
  return db.adviceCategoryDefault.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Fetch only the categories currently enabled for new projects. */
export async function listEnabledAdviceDefaults(): Promise<AdviceDefault[]> {
  await ensureBuiltinsSeeded();
  return db.adviceCategoryDefault.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Lookup a single category by slug. */
export async function getAdviceDefaultByKey(key: string): Promise<AdviceDefault | null> {
  await ensureBuiltinsSeeded();
  return db.adviceCategoryDefault.findUnique({ where: { key } });
}
