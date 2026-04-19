# Git platform adapters (Phase 2)

Small abstraction that lets KDust open a draft PR/MR on the upstream host after
every successful push. Currently supports **GitHub**; GitLab is Phase 3.

## Layout

| File | Purpose |
|------|---------|
| `types.ts`  | `GitPlatformAdapter` interface and result types. |
| `github.ts` | GitHub REST implementation (fetch, no Octokit dep). |
| `index.ts`  | `resolveGitPlatform(project)` factory — auto-detects host and resolves token from env var. |

## Inputs (Project columns)

| Column | Meaning | Default |
|--------|---------|---------|
| `platform` | `github` / `gitlab` / `none` / null (auto) | null → detect from `gitUrl` |
| `platformApiUrl` | API root override | `https://api.github.com` |
| `platformTokenRef` | **Name** of env var holding the PAT | required for auto-PR |
| `remoteProjectRef` | `owner/repo` override | parsed from `gitUrl` |
| `autoOpenPR` | Master switch | `false` |
| `prTargetBranch` | PR base | falls back to `defaultBaseBranch` |
| `prRequiredReviewers` | CSV of logins | — |
| `prLabels` | CSV of labels | `kdust,automation` |

## Outputs (TaskRun columns)

| Column | When populated |
|--------|----------------|
| `prUrl` | PR API call succeeded |
| `prNumber` | PR API call succeeded |
| `prState` | `draft` / `open` / `merged` / `closed` / `failed` |

## ADR — Token storage

Status   : Accepted
Context  : KDust needs a host token to open PRs. Raw PATs in the DB would require
           encryption at rest, a key-rotation story, and careful audit/log scrubbing.
Decision : Store only the **NAME** of an environment variable (`platformTokenRef`).
           The raw token lives in the container / pod environment (Key Vault-injected
           in Ecritel's deployment pattern). Missing env = PR step skipped with a
           warning; the run itself still succeeds.
Consequences :
  • Zero secret in DB, zero secret in Prisma Studio exports, zero secret in backups.
  • Rotation = update the secret in the vault + restart the pod; no DB write.
  • Per-project tokens require per-project env vars (`GITHUB_TOKEN_ACME`, ...),
    which the CD pipeline must inject; documented in the project settings UI.
  • Trade-off: a non-root operator cannot inject a new token via the KDust UI; this
    is acceptable given the sensitivity.
