import { db } from '@/lib/db';
import {
  BUILTIN_ADVICE_CATEGORIES,
  LEGACY_BUILTIN_KEYS,
  PRIORITY_CATEGORY_KEY,
} from './categories';

/**
 * One-shot translations for labels that shipped in French in earlier
 * versions of KDust. We only overwrite the row when its label STILL
 * matches the old French default — that way any user who manually
 * renamed the category keeps their custom label.
 *
 * Structure: { categoryKey: { from: oldLabel, to: newLabel } }
 */
const LEGACY_FRENCH_LABELS: Record<string, { from: string; to: string }> = {
  security: { from: 'Sécurité', to: 'Security' },
  improvement: { from: 'Amélioration', to: 'Improvement' },
};

/**
 * Idempotently seed the built-in advice categories into the DB on
 * first run. Called lazily from any read/write path so we never need
 * an explicit boot step. Safe to call concurrently (uses upsert by
 * unique key).
 *
 * Also relabels the legacy French builtins (Sécurité → Security,
 * Amélioration → Improvement) when we detect the row is still on the
 * old default, and renames any existing Task whose display name
 * still carries the old French "Conseils: …" prefix.
 */
export async function ensureBuiltinsSeeded(): Promise<void> {
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
      // Only promote older rows to builtIn status; never overwrite
      // user-edited fields (label/emoji/prompt/schedule/enabled) on seed.
      update: { builtIn: true },
    });
  }

  // --- v3 migration: collapse the 6 old per-area builtins into the single
  // "priority" builtin above. Idempotent; only acts on rows that still
  // look like the legacy default (builtIn=true on one of the legacy keys).
  // We:
  //   (a) force-disable the legacy default rows + demote builtIn=false
  //       so /settings/advice shows them greyed out and the user can
  //       delete them manually if they want;
  //   (b) delete every materialised advice Task for those legacy keys
  //       (they are all mandatory → regular DELETE would refuse, so we
  //       bypass via prisma deleteMany on the FK set);
  //   (c) delete every ProjectAdvice row for those legacy keys so the
  //       dashboard doesn't keep rendering stale per-area cards.
  const legacyKeys = [...LEGACY_BUILTIN_KEYS];
  const stillBuiltIn = await db.adviceCategoryDefault.findMany({
    where: { key: { in: legacyKeys }, builtIn: true },
    select: { key: true },
  });
  if (stillBuiltIn.length > 0) {
    const keysToMigrate = stillBuiltIn.map((r) => r.key);
    const [updatedDefaults, deletedTasks, deletedAdvices] = await db.$transaction([
      db.adviceCategoryDefault.updateMany({
        where: { key: { in: keysToMigrate } },
        data: { enabled: false, builtIn: false },
      }),
      db.task.deleteMany({
        where: { kind: 'advice', category: { in: keysToMigrate } },
      }),
      db.projectAdvice.deleteMany({
        where: { category: { in: keysToMigrate } },
      }),
    ]);
    console.log(
      `[advice/defaults] v3 migration: demoted ${updatedDefaults.count} legacy default(s), ` +
        `deleted ${deletedTasks.count} legacy advice task(s) and ${deletedAdvices.count} stale advice row(s). ` +
        `Run "Provision advice" (or let it auto-provision) to create the new "${PRIORITY_CATEGORY_KEY}" task per project.`,
    );
  }

  // --- one-shot FR → EN relabelling for legacy installs -----------------
  for (const [key, t] of Object.entries(LEGACY_FRENCH_LABELS)) {
    await db.adviceCategoryDefault.updateMany({
      where: { key, label: t.from },
      data: { label: t.to },
    });
  }

  // --- rename legacy advice tasks: "Conseils: X — proj" → "Advice: X — proj"
  // SQLite doesn't expose REPLACE() via Prisma without $queryRaw, so we
  // fetch the affected rows (small set) and rewrite each name.
  const legacyCrons = await db.task.findMany({
    where: { kind: 'advice', name: { startsWith: 'Conseils: ' } },
    select: { id: true, name: true },
  });
  for (const c of legacyCrons) {
    let next = c.name.replace(/^Conseils: /, 'Advice: ');
    // Also swap any French label embedded in the name (e.g.
    // "Conseils: Sécurité — foo" → "Advice: Security — foo").
    for (const t of Object.values(LEGACY_FRENCH_LABELS)) {
      next = next.replace(`Advice: ${t.from} —`, `Advice: ${t.to} —`);
    }
    await db.task.update({ where: { id: c.id }, data: { name: next } });
  }
  if (legacyCrons.length > 0) {
    console.log(
      `[advice/defaults] relabelled ${legacyCrons.length} legacy advice cron(s) (Conseils → Advice)`,
    );
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
