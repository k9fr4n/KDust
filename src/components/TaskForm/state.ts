/**
 * Shared types + initial-state builder for the TaskForm refactor
 * (#7, 2026-04-29). The refactor splits the 995-line monolithic
 * component into one-file-per-section under src/components/TaskForm/
 * with a shared form-state object passed to each section. The
 * component still uses a plain useState<CronFormValues> + setForm
 * pattern — useReducer was evaluated and rejected as net-negative
 * (typed actions are more verbose than the existing setForm calls
 * for our 27-field form, and the JSX split alone resolves the
 * navigability issue).
 */

export type CronFormValues = {
  name: string;
  schedule: string;
  timezone: string;
  agentSId: string;
  prompt: string;
  /**
   * NULL marks a GENERIC / template task. Only invokable via
   * `run_task(project=...)` from an orchestrator. The UI exposes a
   * dedicated checkbox; when ticked, projectPath is set to null and
   * dependent fields (schedule, pushEnabled) are forced to their
   * generic-safe defaults (server-side invariant in /api/task).
   */
  projectPath: string | null;
  teamsWebhook: string;
  /**
   * Per-task Telegram chat_id. Free-text (negative ids = groups,
   * -100... = supergroups). Empty string → fall back to
   * AppConfig.defaultTelegramChatId.
   */
  telegramChatId: string;
  /**
   * Per-transport notification toggles. Independent of webhook /
   * chat_id resolution: a user can keep an override stored but
   * pause notifications via these flags.
   */
  teamsNotifyEnabled: boolean;
  telegramNotifyEnabled: boolean;
  enabled: boolean;
  /**
   * Master switch for the git pipeline + prompt enrichment. See
   * src/lib/cron/runner.ts buildAutomationPrompt() for semantics.
   */
  pushEnabled: boolean;
  /**
   * Task-runner opt-in. When true, the agent gets the
   * `task-runner` MCP server (run_task tool). Only the orchestrator
   * task should have this on.
   */
  taskRunnerEnabled: boolean;
  /**
   * Command-runner opt-in. Provides `run_command` with a denylist,
   * a chroot to the project tree, and a full audit trail in DB.
   */
  commandRunnerEnabled: boolean;
  /**
   * Branch overrides (Phase 1, Franck 2026-04-19). NULL / empty
   * → inherit from the parent Project.
   */
  baseBranch: string | null;
  branchMode: 'timestamped' | 'stable';
  branchPrefix: string | null;
  dryRun: boolean;
  /**
   * Stored as `number | null` so the user can fully clear the
   * numeric input. On submit, null is replaced with default 2000.
   */
  maxDiffLines: number | null;
  protectedBranches: string | null;
  /**
   * Routing metadata (ADR-0002). Surfaced by the task-runner MCP
   * in list_tasks/describe_task so an orchestrator can pick the
   * right task without parsing the prompt.
   */
  description: string | null;
  tagsInput: string;
  inputsSchema: string | null;
  sideEffects: 'readonly' | 'writes' | 'pushes';
  /**
   * Wall-clock runtime cap in ms. Null = inherit env defaults
   * (30min leaf, 60min orchestrator). Clamp [30000, 21600000].
   */
  maxRuntimeMs: number | null;
};

export type Agent = { sId: string; name: string; description?: string };
export type Project = {
  id: string;
  name: string;
  gitUrl: string | null;
  branch: string;
  defaultAgentSId: string | null;
  defaultBaseBranch: string;
  branchPrefix: string;
  protectedBranches: string;
  /**
   * Phase 1 (2026-04-27): full path under /projects, e.g.
   * "clients/acme/myapp". Null only for legacy rows. The picker
   * uses this as the form value so a project is unambiguously
   * identified across the folder hierarchy.
   */
  fsPath: string | null;
};

import type { Dispatch, SetStateAction } from 'react';

/**
 * Standard prop shape every section receives. Sections call setForm
 * directly using the existing `setForm({ ...form, x: y })` idiom —
 * intentionally not migrated to per-field actions since that would
 * be more verbose for our 27-field form than the spread.
 */
export interface SectionProps {
  form: CronFormValues;
  setForm: Dispatch<SetStateAction<CronFormValues>>;
}

/**
 * Build the initial form state from optional `initial` overrides.
 * Centralised here so the defaults (especially the legacy/back-compat
 * fields like schedule='manual', sideEffects='writes') are documented
 * in one place.
 */
export function buildInitialFormState(
  initial: Partial<CronFormValues> | undefined,
): CronFormValues {
  return {
    name: initial?.name ?? '',
    // Legacy columns — defaulted server-side, hidden in UI. Kept
    // on the client form payload only to satisfy the shared type
    // and the API's Zod parser (which still accepts them for
    // back-compat).
    schedule: initial?.schedule ?? 'manual',
    timezone: initial?.timezone ?? 'Europe/Paris',
    agentSId: initial?.agentSId ?? '',
    prompt: initial?.prompt ?? '',
    projectPath:
      initial?.projectPath === null ? null : (initial?.projectPath ?? ''),
    teamsWebhook: initial?.teamsWebhook ?? '',
    telegramChatId: initial?.telegramChatId ?? '',
    teamsNotifyEnabled: initial?.teamsNotifyEnabled ?? true,
    telegramNotifyEnabled: initial?.telegramNotifyEnabled ?? true,
    enabled: initial?.enabled ?? true,
    pushEnabled: initial?.pushEnabled ?? true,
    taskRunnerEnabled: initial?.taskRunnerEnabled ?? false,
    commandRunnerEnabled: initial?.commandRunnerEnabled ?? false,
    baseBranch: initial?.baseBranch ?? null,
    branchMode: initial?.branchMode ?? 'timestamped',
    branchPrefix: initial?.branchPrefix ?? null,
    dryRun: initial?.dryRun ?? false,
    maxDiffLines: initial?.maxDiffLines ?? 2000,
    protectedBranches: initial?.protectedBranches ?? null,
    maxRuntimeMs: initial?.maxRuntimeMs ?? null,
    description: initial?.description ?? null,
    tagsInput: initial?.tagsInput ?? '',
    inputsSchema: initial?.inputsSchema ?? null,
    sideEffects: initial?.sideEffects ?? 'writes',
  };
}
