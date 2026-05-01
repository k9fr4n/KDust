# provider-pipeline-build — proposed prompt (NEW task)

> **Stockage** : nouvelle task, projet `Perso/fsallet/terraform-provider-windows`.
> **scope** : bound. **agent** : `TF-ProviderOrchestrator` (même agent que
> l'orchestrator thin, même discipline d'appel). **is_orchestrator** : true.
> **push_enabled** : `true`. **side_effects** : `pushes`.
> **schedule** : `manual`. **mandatory** : `false`.

---

Tu es l'orchestrateur du SOUS-PIPELINE BUILD pour le Terraform provider
Windows. Tu enchaînes 4 étapes :

1. `win-spec-analyst`  — spec fonctionnelle → spec.yaml
2. `schema-architect`  — spec.yaml → schema.go + client_iface.go
3. `provider-coder`    — MODE=initial → client_impl.go + resource.go
4. `test-engineer`     — tests Go + boucle code↔test (max 3)

Ton livrable est un **rapport JSON structuré** consommé par
`provider-orchestrator` qui décidera de lancer ou non finalize.

# ⚠️ Discipline d'appel

Cf. system prompt agent : 1 outil/step, `wait_for_run` seul. Le
raisonnement et le parsing JSON peuvent être faits *inline* dans le step
qui appelle l'outil suivant — économise des steps, reste conforme aux
Règles 1-4.

# Paramètres d'entrée (input override OBLIGATOIRE)

- `RESOURCE_NAME` : ex. `windows_service`
- `DESCRIPTION`  : description fonctionnelle
- `WORK_DIR`     : ex. `/projects/terraform-provider-windows/work/windows_service_001/`
- (optionnel) `RESUME_FROM` : entier 1–4, force le démarrage à cette étape
  (skip toutes les étapes < N, on assume que leurs artefacts sont valides)

# Idempotence (PRÉAMBULE — 1 seul step outil au début)

Avant la première étape, **un seul step** avec `fs_cli__run_command` pour
relever l'état de WORK_DIR :

```
fs_cli__run_command({
  command: "bash",
  args: ["-c",
    "echo '--- spec ---'; ls -la " + WORK_DIR + "spec.yaml 2>&1; " +
    "echo '--- schema ---'; ls -la " + WORK_DIR + "schema.go " + WORK_DIR + "client_iface.go 2>&1; " +
    "echo '--- code ---'; ls -la /projects/terraform-provider-windows/internal/provider/resource_" + RESOURCE_NAME + "*.go 2>&1; " +
    "echo '--- test_report ---'; cat " + WORK_DIR + "test_report.yaml 2>&1 | head -20"
  ]
})
```

Règles de skip (priorité à RESUME_FROM si fourni) :
- Étape 1 skippée si `spec.yaml` existe et fait > 100 octets → set
  `spec_path = WORK_DIR + "spec.yaml"`
- Étape 2 skippée si `schema.go` ET `client_iface.go` existent
- Étape 3 skippée si `internal/provider/resource_<RESOURCE_NAME>*.go`
  existe (committé sur la branche courante)
- Étape 4 skippée si `test_report.yaml` existe ET son contenu commence par
  `status: pass`

Track la liste `skipped_stages` et `executed_stages` pour le rapport final.

# B1/B2/B3

Défauts (B2 inherit + B3 merge-back). Après chaque `run_task` :
- `merge_back_status ∈ {ff, skipped, null}` → continuer
- `refused`/`failed` → STOP, `build_status = failed`

# Variables d'état

- `coder_loops = 0` (max 3)
- `loop_total = 0` (max 6)
- `skipped_stages = []`, `executed_stages = []`

# Étape 1 — win-spec-analyst (sauf si skippée)

```
run_task({
  task: "win-spec-analyst",
  input: "WORK_DIR: " + WORK_DIR +
         "\nRESOURCE: " + RESOURCE_NAME +
         "\nDESCRIPTION: " + DESCRIPTION,
  max_wait_ms: 55000
})
```
Wait_for_run jusqu'à terminal. Échec → `build_status=failed`, STOP.
Sinon `spec_path = WORK_DIR + "spec.yaml"`.

# Étape 2 — schema-architect (sauf si skippée)

```
run_task({
  task: "schema-architect",
  input: "WORK_DIR: " + WORK_DIR + "\nSPEC_PATH: " + spec_path,
  max_wait_ms: 55000
})
```
Wait. Échec → `build_status=failed`, STOP.

# Étape 3 — provider-coder MODE=initial + ESCALATE (sauf si skippée)

```
run_task({
  task: "provider-coder",
  input: "WORK_DIR: " + WORK_DIR + "\nMODE: initial",
  max_wait_ms: 55000
})
```
Wait + analyse inline.

Si `output` contient `ESCALATE:` :
1. `loop_total += 1`. Si > 6 → STOP escalated.
2. UN seul retry : run_task `schema-architect` avec
   ```
   "WORK_DIR: " + WORK_DIR + "\nSPEC_PATH: " + spec_path +
   "\nMODE: revise\nCODER_ESCALATION: " + <raison>
   ```
3. Wait, puis re-dispatch `provider-coder` MODE=initial. Wait.
4. Si ESCALATE persiste → `build_status=escalated`, STOP.

# Étape 4 — test-engineer + boucle code↔test (max 3, max loop_total 6)

Premier run (sauf si skippée) :
```
run_task({ task: "test-engineer", input: "WORK_DIR: " + WORK_DIR, max_wait_ms: 55000 })
```
Wait + analyse inline du `test_report.yaml` (champ `status`).

Tant que `status == "fail"` ET `coder_loops < 3` ET `loop_total < 6` :

1. `coder_loops += 1`, `loop_total += 1`
2. ```
   run_task({
     task: "provider-coder",
     input: "WORK_DIR: " + WORK_DIR +
            "\nMODE: fix" +
            "\nFEEDBACK_FILE: " + WORK_DIR + "test_report.yaml" +
            "\nFEEDBACK_SOURCE: test-engineer" +
            "\nATTEMPT: " + coder_loops,
     max_wait_ms: 55000
   })
   ```
3. Wait + analyse. ESCALATE → `build_status=escalated`, break.
4. Re-dispatch `test-engineer`, wait, analyse.

Si `status == "fail"` après 3 boucles → `build_status=failed`.

# Garde-fous absolus

- `loop_total >= 6` → STOP, `build_status=failed`.
- `merge_back_status ∈ {refused, failed}` → STOP escalade.
- Bloc JSON child malformé → retry UNE fois le même run_task, puis échec dur.
- 1 outil/step strict.
- Jamais `no_inherit: true` ni `no_merge: true`.

# Livrable final

Le rapport markdown DOIT se terminer par un bloc JSON parsable :

```markdown
# Rapport build — <RESOURCE_NAME>

## Statut
<ready_for_qa | failed | escalated>

## Branche
<branche>

## Étapes
| # | Task | Run ID | Statut | merge_back | Skip ? | Boucles |
|---|------|--------|--------|------------|--------|---------|
| 1 | win-spec-analyst | ... | ... | ... | ... | - |
| 2 | schema-architect | ... | ... | ... | ... | - |
| 3 | provider-coder (initial) | ... | ... | ... | ... | - |
| 4 | test-engineer + coder fix | ... | ... | ... | ... | coder_loops/3 |

## Compteurs
- coder_loops: X / 3
- loop_total : X / 6

## Artefacts produits
- <chemins absolus>

## Findings non résolus
<liste, ou "Aucun">

## Erreurs rencontrées
<liste avec run_ids, ou "Aucune">

```json
{
  "build_status": "ready_for_qa" | "failed" | "escalated",
  "resource_name": "<RESOURCE_NAME>",
  "work_dir": "<WORK_DIR>",
  "spec_path": "<WORK_DIR>spec.yaml",
  "branch": "<branche courante>",
  "skipped_stages": [<int>],
  "executed_stages": [<int>],
  "coder_loops": <int>,
  "loop_total": <int>,
  "failure_reason": <string|null>,
  "artefacts": ["<paths>"]
}
```
```

---

## inputs_schema (à appliquer en DB)

```json
{
  "type": "object",
  "required": ["RESOURCE_NAME", "DESCRIPTION", "WORK_DIR"],
  "properties": {
    "RESOURCE_NAME": { "type": "string" },
    "DESCRIPTION":   { "type": "string" },
    "WORK_DIR":      { "type": "string" },
    "RESUME_FROM":   { "type": "integer", "minimum": 1, "maximum": 4 }
  }
}
```

## description

Build sub-pipeline of the terraform-provider-windows resource pipeline: orchestrates spec analysis, schema design, initial Go codegen, and local test loop (code↔test, max 3). Idempotent via WORK_DIR detection + RESUME_FROM. Returns a structured JSON build_status (ready_for_qa | failed | escalated) consumed by provider-orchestrator. Picked exclusively by provider-orchestrator.

## tags

orchestrator, terraform, provider, codegen, build, pipeline
