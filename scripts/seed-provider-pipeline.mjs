#!/usr/bin/env node
/**
 * Seed / refactor of the provider-* pipeline tasks (ADR-0003, 2026-05-01).
 *
 * What this does:
 *   1. Archives the current `provider-orchestrator` prompt in
 *      docs/legacy/provider-orchestrator-v1.md (overwrite-safe).
 *   2. Deletes legacy thin launchers `windows_feature` and
 *      `windows_services` (no longer needed; provider-orchestrator is
 *      now invoked directly with an input override).
 *   3. Upserts `provider-pipeline-build` and `provider-pipeline-finalize`
 *      (NEW orchestrator tasks, bound to terraform-provider-windows).
 *   4. Rewrites `provider-orchestrator` (same id) to the v2 thin chainer.
 *
 * Idempotent: rerunning is a no-op if the prompts already match.
 *
 * MUST be run inside the KDust container (Prisma client is generated
 * for the container's libc/openssl tuple). Typical invocation:
 *
 *   docker compose exec kdust node scripts/seed-provider-pipeline.mjs --apply
 *
 * Without --apply the script runs in DRY-RUN mode and prints a diff
 * summary without touching the DB.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force'); // skip confirm prompts

const PROJECT_PATH = 'terraform-provider-windows';
const AGENT_NAME = 'TF-ProviderOrchestrator';

// IDs of tasks to delete (legacy launchers, see chat 2026-05-01).
const LEGACY_LAUNCHER_IDS = [
  'cmoe1w88100086ypjubtcnqlf', // windows_feature
  'cmoaj1yst000y6q6824wt7gam', // windows_services
];

// Existing orchestrator id we rewrite in place.
const PROVIDER_ORCHESTRATOR_ID = 'cmoai9h72000k6q68hxwnjk5c';

const LEGACY_DUMP_PATH = resolve(REPO, 'docs/legacy/provider-orchestrator-v1.md');

// ---------------------------------------------------------------------------
// Prompt body extraction from docs/prompts/*.md
//
// Each .md follows the shape:
//   # Title
//   > blockquote metadata
//   ---           <- separator 1
//   ACTUAL PROMPT BODY
//   ---           <- separator 2
//   ## inputs_schema (doc only)
//
// We split on `\n---\n` and take parts[1].trim().
// ---------------------------------------------------------------------------
function extractPromptBody(mdPath) {
  const raw = readFileSync(mdPath, 'utf8');
  const parts = raw.split(/\n---\n/);
  if (parts.length < 3) {
    throw new Error(`Malformed prompt doc ${mdPath}: expected 2 '---' separators, got ${parts.length - 1}`);
  }
  return parts[1].trim() + '\n';
}

// Static metadata for each task. Kept in JS (not parsed from the .md)
// so the seed contract is unambiguous and lint-checked.
const PROMPT_BODIES = {
  orchestrator: extractPromptBody(resolve(REPO, 'docs/prompts/provider-orchestrator-v2.md')),
  build:        extractPromptBody(resolve(REPO, 'docs/prompts/provider-pipeline-build.md')),
  finalize:     extractPromptBody(resolve(REPO, 'docs/prompts/provider-pipeline-finalize.md')),
};

const META = {
  orchestrator: {
    name: 'provider-orchestrator',
    description:
      'Thin two-stage orchestrator that chains provider-pipeline-build (spec → schema → code → local tests) then provider-pipeline-finalize (quality gate → real Windows GHA validation) for a single windows_* resource. Supports RESUME_FROM=build|finalize for cheap retries. Inherits and merges back the parent branch via B2/B3.',
    tags: ['orchestrator', 'terraform', 'provider', 'codegen', 'pipeline', 'thin'],
    inputsSchema: {
      type: 'object',
      required: ['RESOURCE_NAME', 'DESCRIPTION', 'WORK_DIR'],
      properties: {
        RESOURCE_NAME: { type: 'string' },
        DESCRIPTION:   { type: 'string' },
        WORK_DIR:      { type: 'string' },
        RESUME_FROM:   { type: 'string', enum: ['build', 'finalize'] },
      },
    },
    sideEffects: 'pushes',
    pushEnabled: true,
    taskRunnerEnabled: true,
    commandRunnerEnabled: false,
  },
  build: {
    name: 'provider-pipeline-build',
    description:
      'Build sub-pipeline of the terraform-provider-windows resource pipeline: orchestrates spec analysis, schema design, initial Go codegen, and local test loop (code↔test, max 3). Idempotent via WORK_DIR detection + RESUME_FROM. Returns a structured JSON build_status (ready_for_qa | failed | escalated) consumed by provider-orchestrator. Picked exclusively by provider-orchestrator.',
    tags: ['orchestrator', 'terraform', 'provider', 'codegen', 'build', 'pipeline'],
    inputsSchema: {
      type: 'object',
      required: ['RESOURCE_NAME', 'DESCRIPTION', 'WORK_DIR'],
      properties: {
        RESOURCE_NAME: { type: 'string' },
        DESCRIPTION:   { type: 'string' },
        WORK_DIR:      { type: 'string' },
        RESUME_FROM:   { type: 'integer', minimum: 1, maximum: 4 },
      },
    },
    sideEffects: 'pushes',
    pushEnabled: true,
    taskRunnerEnabled: true,
    commandRunnerEnabled: true, // needs fs_cli__run_command for idempotence preamble
  },
  finalize: {
    name: 'provider-pipeline-finalize',
    description:
      'Finalize sub-pipeline of the terraform-provider-windows resource pipeline: quality gate (lint+sec+doc, with review↔code loop max 2) then real Windows GHA validation (test-gh-runner, with gh↔code loop max 2). Assumes build artefacts already committed. Returns finalize_status (pass | failed | escalated) and a resume_recommendation pointer when needed. Picked exclusively by provider-orchestrator.',
    tags: ['orchestrator', 'terraform', 'provider', 'qualitygate', 'finalize', 'pipeline'],
    inputsSchema: {
      type: 'object',
      required: ['RESOURCE_NAME', 'WORK_DIR'],
      properties: {
        RESOURCE_NAME: { type: 'string' },
        WORK_DIR:      { type: 'string' },
        RESUME_FROM:   { type: 'integer', minimum: 5, maximum: 6 },
      },
    },
    sideEffects: 'pushes',
    pushEnabled: true,
    taskRunnerEnabled: true,
    commandRunnerEnabled: true,
  },
};

const db = new PrismaClient();

async function confirm(question) {
  if (FORCE || !APPLY) return true;
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

function log(prefix, msg) { console.log(`[${prefix}] ${msg}`); }

async function archiveLegacyOrchestrator() {
  const t = await db.task.findUnique({ where: { id: PROVIDER_ORCHESTRATOR_ID } });
  if (!t) {
    log('WARN', `provider-orchestrator (id=${PROVIDER_ORCHESTRATOR_ID}) not found — skipping archive`);
    return null;
  }
  const archived = `# provider-orchestrator (v1, archived ${new Date().toISOString().slice(0, 10)})

Archived prompt of the monolithic 6-stage \`provider-orchestrator\` task,
before the split into \`provider-pipeline-build\` + \`provider-pipeline-finalize\`
(ADR-0003).

Reason for archival: step-budget exhaustion. Full run with bounded retry
loops dispatches up to ~17-20 child tasks, each consuming ~5-8 agent
steps (run_task + wait_for_run polls + analysis), pushing the total
past the planner budget (~50 steps) and forcing premature \`success\`
finalisation mid-pipeline.

Kept here verbatim as historical reference and rollback source.

## Routing metadata at archival time

- **id**          : ${t.id}
- **name**        : ${t.name}
- **agentSId**    : ${t.agentSId}
- **agentName**   : ${t.agentName ?? 'null'}
- **projectPath** : ${t.projectPath ?? 'null'}
- **schedule**    : ${t.schedule}
- **pushEnabled** : ${t.pushEnabled}
- **taskRunnerEnabled** : ${t.taskRunnerEnabled}
- **sideEffects** : ${t.sideEffects}
- **tags**        : ${t.tags ?? 'null'}
- **inputsSchema** : ${t.inputsSchema ? '(see below)' : 'null'}

## Stored prompt (verbatim, fenced with ~~~ to avoid backtick collisions)

~~~
${t.prompt}
~~~

## Stored inputsSchema (verbatim)

~~~json
${t.inputsSchema ?? 'null'}
~~~
`;
  if (APPLY) {
    mkdirSync(dirname(LEGACY_DUMP_PATH), { recursive: true });
    writeFileSync(LEGACY_DUMP_PATH, archived);
    log('OK', `archived legacy prompt → ${LEGACY_DUMP_PATH} (${t.prompt.length} chars)`);
  } else {
    log('DRY', `would archive legacy prompt → ${LEGACY_DUMP_PATH} (${t.prompt.length} chars)`);
  }
  return t;
}

async function deleteLegacyLaunchers() {
  for (const id of LEGACY_LAUNCHER_IDS) {
    const t = await db.task.findUnique({ where: { id } });
    if (!t) {
      log('SKIP', `legacy launcher id=${id} not found (already deleted?)`);
      continue;
    }
    if (t.mandatory) {
      log('WARN', `task ${t.name} (id=${id}) is mandatory — cannot delete via this script`);
      continue;
    }
    if (!APPLY) {
      log('DRY', `would delete task ${t.name} (id=${id})`);
      continue;
    }
    if (!(await confirm(`Delete task ${t.name} (id=${id}, projectPath=${t.projectPath}) ?`))) {
      log('SKIP', `kept ${t.name} (user declined)`);
      continue;
    }
    await db.task.delete({ where: { id } });
    log('OK', `deleted task ${t.name} (id=${id})`);
  }
}

function commonTaskFields(meta, prompt, agentSId) {
  return {
    name:                 meta.name,
    schedule:             'manual',
    timezone:             'Europe/Paris',
    agentSId,
    agentName:            AGENT_NAME,
    prompt,
    projectPath:          PROJECT_PATH,
    enabled:              true,
    pushEnabled:          meta.pushEnabled,
    taskRunnerEnabled:    meta.taskRunnerEnabled,
    commandRunnerEnabled: meta.commandRunnerEnabled,
    branchMode:           'timestamped',
    dryRun:               false,
    maxDiffLines:         2000,
    description:          meta.description,
    tags:                 JSON.stringify(meta.tags),
    inputsSchema:         JSON.stringify(meta.inputsSchema),
    sideEffects:          meta.sideEffects,
  };
}

async function upsertSubPipeline(meta, prompt, agentSId) {
  const existing = await db.task.findFirst({
    where: { name: meta.name, projectPath: PROJECT_PATH },
  });
  const data = commonTaskFields(meta, prompt, agentSId);
  if (existing) {
    if (
      existing.prompt === data.prompt &&
      existing.description === data.description &&
      existing.tags === data.tags &&
      existing.inputsSchema === data.inputsSchema &&
      existing.sideEffects === data.sideEffects &&
      existing.pushEnabled === data.pushEnabled &&
      existing.taskRunnerEnabled === data.taskRunnerEnabled &&
      existing.commandRunnerEnabled === data.commandRunnerEnabled
    ) {
      log('NOOP', `${meta.name} already up to date (id=${existing.id})`);
      return existing;
    }
    if (!APPLY) {
      log('DRY', `would UPDATE ${meta.name} (id=${existing.id})`);
      return existing;
    }
    const updated = await db.task.update({ where: { id: existing.id }, data });
    log('OK', `UPDATED ${meta.name} (id=${updated.id})`);
    return updated;
  }
  if (!APPLY) {
    log('DRY', `would CREATE ${meta.name}`);
    return null;
  }
  const created = await db.task.create({ data });
  log('OK', `CREATED ${meta.name} (id=${created.id})`);
  return created;
}

async function rewriteOrchestrator(legacyTask) {
  const meta = META.orchestrator;
  const prompt = PROMPT_BODIES.orchestrator;
  const agentSId = legacyTask?.agentSId ?? null;
  if (!agentSId) {
    log('WARN', `cannot rewrite provider-orchestrator: source row not found and no agentSId fallback`);
    return;
  }
  const data = commonTaskFields(meta, prompt, agentSId);
  const cur = await db.task.findUnique({ where: { id: PROVIDER_ORCHESTRATOR_ID } });
  if (!cur) {
    log('WARN', `provider-orchestrator id=${PROVIDER_ORCHESTRATOR_ID} not found — SKIPPED rewrite`);
    return;
  }
  if (
    cur.prompt === data.prompt &&
    cur.description === data.description &&
    cur.tags === data.tags &&
    cur.inputsSchema === data.inputsSchema &&
    cur.sideEffects === data.sideEffects
  ) {
    log('NOOP', `provider-orchestrator already up to date`);
    return;
  }
  if (!APPLY) {
    log('DRY', `would REWRITE provider-orchestrator (id=${PROVIDER_ORCHESTRATOR_ID})`);
    return;
  }
  if (!(await confirm(`Rewrite provider-orchestrator prompt (id=${PROVIDER_ORCHESTRATOR_ID}) ?`))) {
    log('SKIP', `kept legacy provider-orchestrator (user declined)`);
    return;
  }
  await db.task.update({ where: { id: PROVIDER_ORCHESTRATOR_ID }, data });
  log('OK', `REWROTE provider-orchestrator (id=${PROVIDER_ORCHESTRATOR_ID})`);
}

async function pickAgentSId() {
  // Reuse the agentSId of provider-orchestrator if present (same agent
  // for all 3 tasks per ADR-0003).
  const o = await db.task.findUnique({ where: { id: PROVIDER_ORCHESTRATOR_ID } });
  if (o?.agentSId) return o.agentSId;
  // Fallback: any task for this project using TF-ProviderOrchestrator.
  const t = await db.task.findFirst({
    where: { projectPath: PROJECT_PATH, agentName: AGENT_NAME },
  });
  if (t?.agentSId) return t.agentSId;
  throw new Error(`Cannot resolve agentSId for ${AGENT_NAME} — set provider-orchestrator agentSId first.`);
}

async function main() {
  log('INFO', `mode = ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`);
  const agentSId = await pickAgentSId();
  log('INFO', `agentSId resolved = ${agentSId}`);

  const legacy = await archiveLegacyOrchestrator();
  await deleteLegacyLaunchers();
  await upsertSubPipeline(META.build,    PROMPT_BODIES.build,    agentSId);
  await upsertSubPipeline(META.finalize, PROMPT_BODIES.finalize, agentSId);
  await rewriteOrchestrator(legacy);

  log('DONE', APPLY ? 'all changes committed' : 'dry-run complete');
}

main()
  .catch((e) => { console.error('[FAIL]', e); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
