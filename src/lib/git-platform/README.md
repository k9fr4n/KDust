# Git platform adapters

Small abstraction that lets KDust open a draft PR/MR on the upstream host
after every successful push. Supports **GitHub** (Phase 2, 2026-04-19) and
**GitLab** (Phase 3, 2026-05-10).

## Layout

| File | Purpose |
|------|---------|
| `types.ts`  | `GitPlatformAdapter` interface and result types. |
| `github.ts` | GitHub REST implementation (fetch, no Octokit dep). |
| `gitlab.ts` | GitLab v4 REST implementation (fetch, no @gitbeaker dep). |
| `index.ts`  | `resolveGitPlatform(project)` factory — async, auto-detects host and resolves the token from the Secret Manager. |

## Inputs (Project columns)

| Column | Meaning | Default |
|--------|---------|---------|
| `platform` | `github` / `gitlab` / `none` / null (auto) | null → detect from `gitUrl` |
| `platformApiUrl` | API root override | `https://api.github.com` (GitHub) / `https://<host>/api/v4` (GitLab) |
| `platformSecretName` | **Name** of a row in the Secret Manager (model `Secret`) | required for auto-PR |
| `remoteProjectRef` | `owner/repo` (GitHub) or `group/sub/repo` (GitLab) override | parsed from `gitUrl` |
| `autoOpenPR` | Master switch | `false` |
| `prTargetBranch` | PR base | falls back to `defaultBaseBranch` |
| `prRequiredReviewers` | CSV of GitHub logins (GitHub) / usernames resolved to numeric IDs (GitLab) | — |
| `prLabels` | CSV of labels | `kdust,automation` |

## Outputs (TaskRun columns)

| Column | When populated |
|--------|----------------|
| `prUrl` | PR/MR API call succeeded |
| `prNumber` | PR/MR number (GitHub) or iid (GitLab) |
| `prState` | `draft` / `open` / `merged` / `closed` / `failed` |

## ADR-0014 — Token storage via Secret Manager (2026-05-10)

Status   : Accepted (supersedes Phase 2 "env var name" decision).
Context  : KDust now has a first-class Secret Manager (model `Secret`,
           AES-256-GCM at rest, UI-driven rotation, audit via
           `Secret.lastUsedAt`). Storing platform PATs in `process.env`
           created a parallel secrets path with weaker guarantees:
           no rotation UX, no audit trail, full container env leak
           radius. ADR-0013 enshrines "CLIs + TaskSecret" as the
           canonical agent credential path; this ADR aligns the push
           pipeline with the same backend.
Decision : Store only the **NAME** of a Secret Manager row
           (`platformSecretName`). At resolve time, the factory looks
           up the row, decrypts `valueEnc` in memory, bumps
           `Secret.lastUsedAt`, and hands the plaintext to the
           adapter. Decrypt errors / missing row / empty value →
           PR step skipped with a structured reason; the run itself
           still succeeds.
Consequences :
  - Single secrets backend: the same `Secret` row can be reused as a
    `TaskSecret` binding (agents calling `gh`/`glab` via TaskRun) and
    as a push-pipeline credential (no duplication of PATs).
  - Rotation = update the Secret value in the UI; no container
    restart, no DB schema touch.
  - Per-project tokens are first-class: create one Secret per
    environment / org and bind it to the relevant Project rows.
  - `Secret.lastUsedAt` tracks both binding and platform usage,
    making orphan detection straightforward.
  - Trade-off: the master key `APP_ENCRYPTION_KEY` becomes the single
    point of compromise for both Tasks and the push pipeline. This
    was already true for Tasks; expanding the blast radius is
    acceptable given the alternative (two key managements).
  - Migration: the previous `platformTokenRef` column is dropped.
    No data migration step is bundled — the field was never used
    on the maintainer instance (see ADR commit message). External
    users with active `platformTokenRef` rows must recreate the
    binding via `/settings/secrets` + project edit.
