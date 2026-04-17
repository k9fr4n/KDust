import { db } from '../db';
import { postToTeams, type TeamsCardFact } from '../teams';
import { getAppConfig } from '../config';
import { createDustConversation, streamAgentReply } from '../dust/chat';
import { getFsServerId } from '../mcp/registry';
import {
  parseGitRepo,
  buildGitLinks,
  composeBranchName,
  resetToBase,
  checkoutWorkingBranch,
  diffStatFromHead,
  commitAll,
  pushBranch,
} from '../git';

/**
 * Registry of in-flight runs so the HTTP API can abort them on demand.
 * Key: CronRun.id. Value: AbortController that aborts the agent stream.
 * Entries are added at the start of runCronJob and always cleaned up in a
 * finally block. Because Node.js modules are singletons within a process,
 * this survives across requests but is of course NOT cross-process.
 */
const activeRuns = new Map<string, AbortController>();

/** Abort an in-flight run. Returns true if the runId was active. */
export function cancelCronRun(runId: string): boolean {
  const ac = activeRuns.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/**
 * End-to-end cron run pipeline (automation-push flavour):
 *
 *   [1]  concurrency lock (skip if another run is still `running` for this job)
 *   [2]  pre-run git sync     : fetch + reset --hard origin/<baseBranch> + clean -fd
 *   [3]  branch setup         : create/checkout the work branch (timestamped|stable)
 *                               + guard against pushing to a protected branch
 *   [4]  MCP fs register      : mcpServerIds = [fs-cli for /projects/<projectPath>]
 *   [5]  Dust agent run       : createConversation + streamAgentReply (10min timeout)
 *   [6]  diff measurement     : git add -A + numstat to count files/lines changed
 *   [7]  guard-rails          : abort if diff exceeds maxDiffLines (hallucination safety)
 *   [8]  auto-commit + push   : conventional message; force-with-lease in stable mode;
 *                               dryRun => no push
 *   [9]  persist CronRun + local Conversation for audit trail
 *   [10] Teams report with branch/commit/MR links + diff stats
 */
export async function runCronJob(cronJobId: string): Promise<void> {
  const job = await db.cronJob.findUnique({ where: { id: cronJobId } });
  if (!job) return;

  // [1] Concurrency lock ------------------------------------------------------
  const concurrent = await db.cronRun.findFirst({
    where: { cronJobId, status: 'running' },
    orderBy: { startedAt: 'desc' },
  });
  if (concurrent) {
    // Consider runs older than 1h as stale (process crash etc.)
    const ageMs = Date.now() - concurrent.startedAt.getTime();
    if (ageMs < 60 * 60 * 1000) {
      console.warn(`[cron] skip job="${job.name}": previous run ${concurrent.id} still running (${Math.round(ageMs/1000)}s)`);
      await db.cronRun.create({
        data: {
          cronJobId,
          status: 'skipped',
          output: `Previous run ${concurrent.id} still running since ${concurrent.startedAt.toISOString()}`,
          finishedAt: new Date(),
        },
      });
      return;
    }
    // Stale: mark the ghost run as failed and proceed
    await db.cronRun.update({
      where: { id: concurrent.id },
      data: { status: 'failed', error: 'stale (no completion signal >1h)', finishedAt: new Date() },
    });
  }

  const run = await db.cronRun.create({
    data: {
      cronJobId,
      status: 'running',
      dryRun: job.dryRun,
      baseBranch: job.baseBranch,
      phase: 'queued',
      phaseMessage: 'Starting',
    },
  });
  const startedAt = Date.now();
  console.log(`[cron] starting job="${job.name}" agent=${job.agentSId} project=${job.projectPath} base=${job.baseBranch} mode=${job.branchMode}`);

  const setPhase = (phase: string, message: string) =>
    db.cronRun.update({ where: { id: run.id }, data: { phase, phaseMessage: message } }).catch(() => {});

  const project = job.projectPath
    ? await db.project.findFirst({ where: { name: job.projectPath } })
    : null;

  const webhook = job.teamsWebhook || (await getAppConfig()).defaultTeamsWebhook;
  let branch: string | null = null;
  let commitSha: string | null = null;
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let agentText = '';

  try {
    if (!project) {
      throw new Error(`project "${job.projectPath}" not found in DB; add it in Projects first`);
    }

    // [2] Pre-run sync --------------------------------------------------------
    await setPhase('syncing', `git fetch + reset --hard origin/${job.baseBranch}`);
    console.log(`[cron] git sync base=${job.baseBranch}`);
    const sync = await resetToBase(project.name, job.baseBranch);
    if (!sync.ok) throw new Error(`pre-sync failed: ${sync.error}\n${sync.output}`);

    // [3] Branch setup --------------------------------------------------------
    branch = composeBranchName(
      (job.branchMode === 'stable' ? 'stable' : 'timestamped') as 'stable' | 'timestamped',
      job.branchPrefix,
      job.name,
    );
    const protectedList = job.protectedBranches
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (protectedList.includes(branch) || protectedList.includes(job.baseBranch) && branch === job.baseBranch) {
      throw new Error(`refusing to work on protected branch "${branch}"`);
    }
    await setPhase('branching', `Creating work branch ${branch}`);
    const co = await checkoutWorkingBranch(project.name, branch);
    if (!co.ok) throw new Error(`branch checkout failed: ${co.error}\n${co.output}`);
    console.log(`[cron] branch=${branch}`);

    // [4] MCP fs -------------------------------------------------------------
    await setPhase('mcp', 'Registering fs-cli MCP server');
    let mcpServerIds: string[] | null = null;
    try {
      const id = await getFsServerId(project.name);
      mcpServerIds = [id];
      console.log(`[cron] mcp serverId=${id}`);
    } catch (e) {
      console.warn(`[cron] MCP register failed: ${(e as Error).message} — running without fs tools`);
    }

    // [5] Dust agent ---------------------------------------------------------
    await setPhase('agent', `Agent ${job.agentName ?? job.agentSId} is thinking…`);
    const convTitle = `[cron] ${job.name} @ ${new Date().toISOString()}`;
    const conv = await createDustConversation(job.agentSId, job.prompt, convTitle, mcpServerIds);
    const ac = new AbortController();
    // Register so the HTTP cancel endpoint can abort from outside this scope.
    activeRuns.set(run.id, ac);
    const killTimer = setTimeout(() => ac.abort(), 10 * 60 * 1000);
    let streamErr: string | null = null;
    try {
      agentText = await streamAgentReply(
        conv.conversation,
        conv.userMessageSId,
        ac.signal,
        (kind, payload) => { if (kind === 'error') streamErr = String(payload); },
      );
    } finally {
      clearTimeout(killTimer);
      activeRuns.delete(run.id);
    }
    if (ac.signal.aborted) {
      throw Object.assign(new Error('run aborted by user'), { aborted: true });
    }
    if (streamErr) throw new Error(`agent stream error: ${streamErr}`);
    if (!agentText.trim()) agentText = '(agent returned an empty response)';

    // Persist conversation (audit trail)
    try {
      await db.conversation.create({
        data: {
          dustConversationSId: conv.dustConversationSId,
          agentSId: job.agentSId,
          agentName: job.agentName ?? null,
          title: convTitle,
          projectName: project.name,
          messages: {
            create: [
              { role: 'user', content: job.prompt },
              { role: 'agent', content: agentText },
            ],
          },
        },
      });
    } catch (e) {
      console.warn(`[cron] could not persist conv: ${(e as Error).message}`);
    }

    // [6] Diff measurement ---------------------------------------------------
    await setPhase('diff', 'Computing diff');
    const diff = await diffStatFromHead(project.name);
    filesChanged = diff.filesChanged;
    linesAdded = diff.linesAdded;
    linesRemoved = diff.linesRemoved;
    console.log(`[cron] diff files=${filesChanged} +${linesAdded}/-${linesRemoved}`);

    const repo = parseGitRepo(project.gitUrl);

    // No-op short-circuit
    if (filesChanged === 0) {
      const durationMs = Date.now() - startedAt;
      await db.cronRun.update({
        where: { id: run.id },
        data: {
          status: 'no-op',
          phase: 'done',
          phaseMessage: 'No changes produced',
          branch,
          filesChanged: 0,
          linesAdded: 0,
          linesRemoved: 0,
          output: agentText,
          finishedAt: new Date(),
        },
      });
      await db.cronJob.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), lastStatus: 'no-op' },
      });
      if (webhook) {
        await postToTeams(webhook, {
          title: `ℹ️ KDust cron : ${job.name} (no-op)`,
          summary: `Agent ran but produced no file changes on ${project.name}`,
          status: 'success',
          details: agentText,
          facts: [
            { name: 'Project', value: project.name },
            { name: 'Base branch', value: job.baseBranch },
            { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
          ],
        });
      }
      console.log(`[cron] no-op job="${job.name}" duration=${durationMs}ms`);
      return;
    }

    // [7] Guard-rail: diff too large ----------------------------------------
    const totalLines = linesAdded + linesRemoved;
    if (totalLines > job.maxDiffLines) {
      throw new Error(
        `diff too large: +${linesAdded}/-${linesRemoved} over ${filesChanged} file(s) exceeds maxDiffLines=${job.maxDiffLines}. Refusing to commit/push. Review the agent's work manually in /projects/${project.name}.`,
      );
    }

    // [8] Commit + push ------------------------------------------------------
    await setPhase('committing', `Committing ${filesChanged} file(s)`);
    const commitMsg =
      `chore(${job.branchPrefix}): ${job.name}\n\n` +
      `Automated by KDust cron "${job.name}".\n` +
      `Agent: ${job.agentName ?? job.agentSId}\n` +
      `Base: origin/${job.baseBranch}\n` +
      `Files: ${filesChanged} | +${linesAdded} / -${linesRemoved}`;
    commitSha = await commitAll(project.name, commitMsg, 'KDust Bot', 'kdust-bot@ecritel.net');
    if (!commitSha) throw new Error('commitAll returned null despite diff being non-empty');
    console.log(`[cron] commit ${commitSha.slice(0, 8)}`);

    if (!job.dryRun) {
      if (protectedList.includes(branch)) {
        throw new Error(`aborting push: target branch "${branch}" is protected`);
      }
      await setPhase('pushing', `git push origin ${branch}`);
      const push = await pushBranch(project.name, branch, job.branchMode === 'stable');
      if (!push.ok) throw new Error(`push failed: ${push.error}\n${push.output}`);
      console.log(`[cron] pushed ${branch}`);
    } else {
      console.log(`[cron] dryRun=true, skipping push`);
    }

    const durationMs = Date.now() - startedAt;
    await db.cronRun.update({
      where: { id: run.id },
      data: {
        status: 'success',
        phase: 'done',
        phaseMessage: job.dryRun ? 'Done (dry-run, no push)' : 'Completed successfully',
        branch,
        commitSha,
        filesChanged,
        linesAdded,
        linesRemoved,
        output: agentText,
        finishedAt: new Date(),
      },
    });
    await db.cronJob.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: job.dryRun ? 'dry-run' : 'success' },
    });

    // [10] Teams report -----------------------------------------------------
    if (webhook) {
      const links = buildGitLinks(repo, branch, job.baseBranch, commitSha);
      const fileList =
        diff.files.slice(0, 15).map((f) => `• ${f}`).join('\n') +
        (diff.files.length > 15 ? `\n(… +${diff.files.length - 15} more)` : '');
      const linkLines: string[] = [];
      if (links.branch) linkLines.push(`🌿 Branch: ${links.branch}`);
      if (links.commit) linkLines.push(`🔖 Commit: ${links.commit}`);
      if (links.newMr && !job.dryRun) linkLines.push(`🚀 Open MR/PR: ${links.newMr}`);
      const details =
        (linkLines.length ? linkLines.join('\n') + '\n\n' : '') +
        `Agent output:\n${agentText.slice(0, 1500)}${agentText.length > 1500 ? '…' : ''}\n\n` +
        `Files changed:\n${fileList}`;
      const facts: TeamsCardFact[] = [
        { name: 'Project', value: project.name },
        { name: 'Branch', value: branch },
        { name: 'Base', value: job.baseBranch },
        { name: 'Commit', value: commitSha ? commitSha.slice(0, 10) : '-' },
        { name: 'Diff', value: `${filesChanged} file(s), +${linesAdded}/-${linesRemoved}` },
        { name: 'Duration', value: `${(durationMs / 1000).toFixed(1)}s` },
        { name: 'Mode', value: job.dryRun ? 'dry-run (no push)' : job.branchMode },
      ];
      await postToTeams(webhook, {
        title: `${job.dryRun ? '🧪' : '✅'} KDust cron : ${job.name}`,
        summary: `${filesChanged} file(s) changed on ${project.name}`,
        status: 'success',
        details,
        facts,
      });
    }
    console.log(`[cron] success job="${job.name}" duration=${durationMs}ms`);
  } catch (err) {
    const wasAborted = !!(err as { aborted?: boolean })?.aborted;
    const msg = err instanceof Error ? err.message : String(err);
    const terminalStatus = wasAborted ? 'aborted' : 'failed';
    await db.cronRun.update({
      where: { id: run.id },
      data: {
        status: terminalStatus,
        phase: 'done',
        phaseMessage: wasAborted ? 'Aborted by user' : `Failed: ${msg.slice(0, 120)}`,
        error: msg,
        branch,
        commitSha,
        filesChanged,
        linesAdded,
        linesRemoved,
        output: agentText || null,
        finishedAt: new Date(),
      },
    });
    await db.cronJob.update({
      where: { id: job.id },
      data: { lastRunAt: new Date(), lastStatus: terminalStatus },
    });
    if (webhook) {
      await postToTeams(webhook, {
        title: `${wasAborted ? '⏹️' : '❌'} KDust cron : ${job.name}`,
        summary: wasAborted ? `Aborted on ${job.projectPath}` : `Failed on ${job.projectPath}`,
        status: 'failed',
        details: msg,
        facts: branch ? [
          { name: 'Branch attempt', value: branch },
          { name: 'Base', value: job.baseBranch },
        ] : undefined,
      });
    }
    console.error(`[cron] ${wasAborted ? 'ABORTED' : 'FAILED'} job="${job.name}": ${msg}`);
  }
}
