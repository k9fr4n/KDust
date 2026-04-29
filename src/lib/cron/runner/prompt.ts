/**
 * DooD host-path footer (Franck 2026-04-20 23:56).
 *
 * Why this exists:
 *   KDust runs in a container and the Docker daemon it talks to is on
 *   the host (socket bind-mount). When an agent writes
 *   `docker run -v "$(pwd):/workspace" ...`, $(pwd) is evaluated INSIDE
 *   KDust and returns /projects/<name> — a container-local path the
 *   host daemon cannot see. Mounts silently resolve to empty dirs,
 *   which is worse than a loud error.
 *
 * Fix:
 *   Inject the *host-side* project root into every agent prompt so the
 *   agent knows which path to put on the left side of -v. The value
 *   comes from KDUST_HOST_PROJECTS_ROOT, populated by docker-compose
 *   from ${PWD}/projects at compose parse time.
 *
 * Returns an empty string when the env var is unset (non-Docker
 * deployments, local `next dev`, …) so the prompt stays clean.
 */
export function buildDockerHostContext(projectPath: string): string {
  const hostRoot = process.env.KDUST_HOST_PROJECTS_ROOT;
  if (!hostRoot) return '';
  const hostProjectPath = `${hostRoot.replace(/\/+$/, '')}/${projectPath}`;
  return [
    '',
    '---',
    '[Docker-from-agent context]',
    'This KDust instance runs in a container that shares the host Docker socket',
    '(Docker-out-of-Docker). If you invoke `docker run -v <src>:<dst>` the daemon',
    'resolves <src> against the HOST filesystem, NOT this container. Use the',
    'path below for your project working tree:',
    '',
    `  HOST_PROJECT_PATH=${hostProjectPath}`,
    '',
    'Example (PowerShell lint inside a throw-away container):',
    '  docker run --rm \\\\',
    `    -v "${hostProjectPath}:/workspace" \\\\`,
    '    -w /workspace \\\\',
    '    mcr.microsoft.com/powershell:7.5-ubuntu-24.04 \\\\',
    '    pwsh -NoProfile -Command \'...your script...\'',
    '',
    'Never use $(pwd) on the -v left side — it would evaluate to /projects/…',
    'which does not exist on the host and the mount would be empty.',
  ].join('\n');
}

/**
 * Toolchain policy block (Franck 2026-04-25 19:13). KDust no longer
 * pre-installs language toolchains in its container — the projects
 * KDust manages span Go, Python, Terraform, Node, Ansible, etc.,
 * and trying to keep a single base image fat enough to satisfy all
 * of them rapidly turns into an unmaintainable kitchen sink.
 *
 * Instead, the Dust agent is instructed (via this prompt addendum)
 * to run ANY language-specific tool through Docker, using the
 * /var/run/docker.sock that's already mounted in the KDust runner
 * container (see Dockerfile, "Docker-out-of-Docker" Option A,
 * Franck 2026-04-20 23:46).
 *
 * The directive is appended to every task prompt regardless of
 * pushEnabled, because even in prompt-only mode the agent often
 * needs to run a `go test` / `pytest` / `terraform plan` to
 * diagnose. Without this guidance, the agent occasionally tried
 * native invocations first, hit "Go isn't installed", and only
 * THEN fell back to Docker — wasting tokens and adding noise to
 * the conversation.
 */
const TOOLCHAIN_POLICY_BLOCK = [
  '[Toolchain policy]',
  'No language toolchains are installed natively in this environment',
  '(no go, python, node-globally, terraform, ansible, etc. on PATH).',
  'For ANY toolchain command you need to run, use Docker:',
  '',
  '    docker run --rm \\',
  '      -v "$PWD":/work -w /work \\',
  '      <official-image>:<pinned-version> <command>',
  '',
  'The Docker daemon socket is mounted into this environment, so',
  '`docker run` works out of the box from your run_command tool.',
  'Pick official images sized to the task:',
  '  • Go         golang:1.23-bookworm',
  '  • Python     python:3.12-slim',
  '  • Node       node:22-bookworm-slim',
  '  • Terraform  hashicorp/terraform:1.10',
  '  • Ansible    quay.io/ansible/ansible-runner:latest',
  'Do NOT attempt `apt install`, `curl ... | sh`, or other in-place',
  'installs — they would only persist for this single command\'s',
  'lifetime and are blocked anyway. If you genuinely need a tool',
  'that has no obvious image, ask the user before building one.',
].join('\n');

/**
 * Build the final prompt sent to the Dust agent. When the task has
 * `pushEnabled=true`, KDust appends an automation-context footer so
 * the agent knows its edits will be auto-committed & pushed by the
 * runner (and therefore should NOT run git commands itself). When
 * `pushEnabled=false`, the prompt is passed through verbatim —
 * the task behaves like a recurring chat prompt: the agent reply is
 * captured, files it may write stay uncommitted in the working tree.
 *
 * The toolchain-policy block is ALWAYS appended (even in prompt-only
 * mode where the agent might still want to run tests/lints), unlike
 * the automation context which only makes sense when KDust is going
 * to commit on the agent's behalf.
 */
export function buildAutomationPrompt(
  job: {
    prompt: string;
    pushEnabled: boolean;
    branchMode: string;
    dryRun: boolean;
    maxDiffLines: number;
  },
  policy: { baseBranch: string; branchPrefix: string },
): string {
  const tail: string[] = ['', '---', TOOLCHAIN_POLICY_BLOCK];
  if (job.pushEnabled) {
    tail.push(
      '',
      '---',
      '[KDust automation context]',
      'This run will be auto-committed (and pushed unless dry-run) by KDust after your reply.',
      `- Base branch: ${policy.baseBranch}`,
      `- Branch mode: ${job.branchMode}`,
      `- Branch prefix: ${policy.branchPrefix}`,
      `- Dry-run: ${job.dryRun ? 'yes (local commit only, no push)' : 'no (commit + push)'}`,
      `- Max diff lines: ${job.maxDiffLines} (KDust aborts the push if exceeded)`,
      'Do NOT run `git add` / `git commit` / `git push` yourself — KDust handles',
      'all git writes from the working-tree diff after your reply. Just edit files',
      'via the fs-cli MCP server as needed and explain your changes in your reply.',
    );
  }
  return [job.prompt, ...tail].join('\n');
}
