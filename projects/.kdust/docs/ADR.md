# Architecture Decision Records

## ADR-001 — Tasks KDust génériques avec registry projets

- **Status**   : Accepted (2026-04-22)
- **Context**  : Multiplication des projets → duplication de tasks quasi
  identiques (run-pester-X, audit-secrets-X…), coûteuse à maintenir.
- **Decision** : 3 couches
  1. Registry YAML central (`registry.yaml`) = métadonnées par projet.
  2. Entry-points génériques `bin/<verb>` = résolution + dispatch.
  3. Drivers shell réutilisables `lib/drivers/<tool>.sh` = exécution.
- **Consequences** :
  - (+) Ajout projet = 1 entrée YAML.
  - (+) Évolutions transverses propagées automatiquement.
  - (+) Drivers testables isolément.
  - (-) Niveau d'indirection supplémentaire.
  - (-) Discipline schéma requise (validation yq manuelle pour l'instant).

## ADR-002 — Drivers via Docker éphémère

- **Status**   : Accepted
- **Context**  : L'image KDust doit rester légère et agnostique.
- **Decision** : Tout driver lance ses outils dans un conteneur `--rm`,
  jamais installés sur l'image KDust (sauf `gh`, `git`, `rsync`, `yq`, `jq`
  qui sont l'armature minimale).
- **Consequences** :
  - (+) Mise à jour d'un outil = bump d'un tag Docker, pas un rebuild KDust.
  - (+) Isolation des dépendances.
  - (-) Premier run lent (pull image).
  - (-) Docker socket obligatoire (déjà assumé côté KDust).

## ADR-003 — Pester Windows en zero-commit sandbox

- **Status**   : Accepted
- **Context**  : PSWinOps ne tourne pas sur Linux ; GitHub Actions
  `windows-latest` est nécessaire mais le repo `WindowsRunner` doit rester
  vide (juste README) pour les opérations régulières.
- **Decision** : Le driver `pester-gha-windows` :
  - rsync le code projet dans un workdir tmp,
  - génère le workflow YAML à la volée,
  - push sur une branche éphémère `ci/kdust-<ts>-<rand>`,
  - déclenche via event `push` (pas `workflow_dispatch`),
  - attend via `gh run watch`, télécharge les artefacts,
  - supprime la branche sur EXIT (trap).
- **Consequences** :
  - (+) Zéro pollution permanente du repo distant.
  - (+) Workflow évolue avec le driver (pas de drift config/source).
  - (-) Un push (éphémère) par run = dépendance à l'API GitHub Git.
  - (-) `KEEP_ON_FAIL=1` possible mais nécessite cleanup manuel ensuite.
