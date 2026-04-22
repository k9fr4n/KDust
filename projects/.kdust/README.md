# KDust — Tasks génériques multi-projets

> Factorisation des opérations transverses (tests, lint, format, audits, build)
> via un registry central + drivers réutilisables. Ajouter un projet = une
> entrée YAML dans `registry.yaml`, zéro code.

## Arborescence

```
.kdust/
├── registry.yaml          # Catalogue des projets + métadonnées
├── bin/                   # Entry points appelés par l'agent KDust
│   ├── run-tests          # run-tests <project> [suites]
│   ├── run-lint           # run-lint <project>
│   ├── run-format         # run-format <project> [--check]
│   ├── run-build          # run-build <project>
│   ├── audit-secrets      # audit-secrets <project>
│   ├── audit-deps         # audit-deps <project>
│   ├── audit-iac          # audit-iac <project>
│   ├── audit-all          # audit-all <project>
│   └── list-projects      # show registry as table
├── lib/
│   ├── common.sh          # Helpers (logs, registry lookup, out dirs)
│   └── drivers/           # Un fichier par outil
│       ├── pester-gha-windows.sh   [IMPLEMENTED]
│       ├── gitleaks.sh             [IMPLEMENTED]
│       ├── checkov.sh              [IMPLEMENTED]
│       ├── trivy-fs.sh             [IMPLEMENTED]
│       ├── psscriptanalyzer.sh     [IMPLEMENTED]
│       ├── terraform-fmt.sh        [IMPLEMENTED]
│       ├── tflint.sh               [IMPLEMENTED]
│       ├── shellcheck.sh           [IMPLEMENTED]
│       └── *.sh                    [STUB — TODO]
└── docs/
    └── ADR.md
```

## Flux

```
 agent KDust
     │   invoke: bash /projects/.kdust/bin/<verb> <project> [args]
     ▼
  bin/<verb>  ──► lit registry.yaml via yq
     │         ──► résout driver + options
     ▼
  lib/drivers/<tool>.sh  ──► exécute (souvent via Docker)
     │
     ▼
  /tmp/kdust/<verb>/<project>/<ts>/   (artefacts normalisés)
```

## Usage (depuis l'agent ou en CLI)

```bash
# Lister les projets
/projects/.kdust/bin/list-projects

# Tests Pester sur Windows (GitHub Actions, zero-commit)
GH_TOKEN="$KDUST_SECRET_GH_TOKEN" \
  /projects/.kdust/bin/run-tests PSWinOps

# ... avec suites filtrées
GH_TOKEN=... /projects/.kdust/bin/run-tests PSWinOps Public/utils,Private

# Lint PowerShell
/projects/.kdust/bin/run-lint PSWinOps

# Format automatique (écrit dans le source)
/projects/.kdust/bin/run-format PSWinOps

# Format en mode check seulement
/projects/.kdust/bin/run-format PSWinOps --check

# Audits
/projects/.kdust/bin/audit-secrets PSWinOps
/projects/.kdust/bin/audit-iac    EUDONET_Terraform
/projects/.kdust/bin/audit-all    EUDONET_Terraform
```

## Ajouter un projet

1. Éditer `registry.yaml` :

```yaml
projects:
  MonProjet:
    path: /projects/MonProjet
    type: python
    test:
      framework: pytest
      runner: local
    lint:
      tool: pylint
    audit:
      secrets: true
      deps: true
```

2. Si le driver du framework/tool n'existe pas encore, passer le stub
   correspondant dans `lib/drivers/` en implementation réelle.

3. Tester : `/projects/.kdust/bin/list-projects` puis appeler une task.

## Ajouter un driver

Template minimal :

```bash
#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker jq
: "${PROJECT:?}"; : "${SRC_DIR:?}"

OUT_DIR=$(kdust::out_dir <task-name> "$PROJECT")

# ... run tool, write reports to $OUT_DIR ...

kdust::banner "<tool> — $PROJECT"
kdust::log "Report: $OUT_DIR/..."
```

## Conventions

| Règle | Raison |
|---|---|
| Un driver = un outil | Testabilité, clarté |
| `set -euo pipefail` partout | Fail fast |
| Sortie dans `/tmp/kdust/<task>/<project>/<ts>/` | Uniformité, rétention facile |
| Tout en Docker `--rm` | Pas de pollution de l'image KDust |
| Secrets via env var uniquement | Jamais en dur, jamais loggés |
| `kdust::*` helpers pour logs | Préfixes `[INFO]/[WARN]/[CRITICAL]` cohérents |

## Prérequis (fournis par l'image KDust)

- `bash` 5+
- `git`, `gh`, `rsync`
- `yq` (Mike Farah v4), `jq`
- `docker` CLI (socket monté depuis l'hôte)

## Secrets

Un seul secret requis pour l'instant :

| Nom | Scope | Utilisé par |
|---|---|---|
| `GH_TOKEN` (ou `KDUST_SECRET_GH_TOKEN`) | `contents:write` + `actions:read` sur le(s) repo(s) remote | `pester-gha-windows` driver |

Injection recommandée via `docker-compose.yml` ou le secret store applicatif
KDust — **jamais** committé dans le registry ou le code.
