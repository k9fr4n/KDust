#!/usr/bin/env bash
# =============================================================================
# Driver : pester-gha-windows
# -----------------------------------------------------------------------------
# Runs Pester 5 test suites on a GitHub-hosted windows-latest runner via a
# zero-commit ephemeral branch. Nothing persists in the remote repo beyond
# the lifetime of the task (branch is deleted on exit).
#
# Flow:
#   1. rsync project source into a tmp workdir
#   2. generate .github/workflows/pester.yml on the fly
#   3. git init / commit / push to ci/kdust-<ts>-<rand>
#   4. GitHub fires workflow on 'push' event
#   5. poll + watch via gh CLI
#   6. download artifacts
#   7. delete branch (trap EXIT)
#
# Inputs (env, set by caller bin/run-tests):
#   PROJECT          : project name (for logs/output dir)
#   SRC_DIR          : local path to the project source
#   REMOTE_REPO      : owner/repo on GitHub (e.g. k9fr4n/WindowsRunner)
#   SUITES           : 'all' or comma-separated suite list
#   PWSH_VERSION     : '7' (default) or '5.1'
#   GH_TOKEN         : PAT with contents:write + actions:read on REMOTE_REPO
#   KEEP_ON_FAIL=1   : keep remote branch when tests fail (debug)
# =============================================================================

set -euo pipefail

# shellcheck source=../common.sh
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"

kdust::require git gh rsync

: "${PROJECT:?PROJECT required}"
: "${SRC_DIR:?SRC_DIR required}"
: "${REMOTE_REPO:?REMOTE_REPO required}"
: "${GH_TOKEN:?GH_TOKEN required (PAT for $REMOTE_REPO)}"
SUITES="${SUITES:-all}"
PWSH_VERSION="${PWSH_VERSION:-7}"
KEEP_ON_FAIL="${KEEP_ON_FAIL:-0}"

TS=$(date -u +%Y%m%d-%H%M%S)
RAND=$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')
BRANCH="ci/kdust-${TS}-${RAND}"
WORKDIR=$(mktemp -d -t kdust-pester-XXXXXXXX)
OUT_DIR=$(kdust::out_dir run-tests "$PROJECT")

kdust::log "Driver  : pester-gha-windows"
kdust::log "Project : $PROJECT"
kdust::log "Source  : $SRC_DIR"
kdust::log "Remote  : $REMOTE_REPO"
kdust::log "Branch  : $BRANCH"
kdust::log "Suites  : $SUITES"
kdust::log "PS ver  : $PWSH_VERSION"
kdust::log "Output  : $OUT_DIR"

# ---------- Cleanup trap ----------------------------------------------------
cleanup() {
  local rc=$?
  if [ "$KEEP_ON_FAIL" = "1" ] && [ "$rc" -ne 0 ]; then
    kdust::warn "KEEP_ON_FAIL=1 -> branch '$BRANCH' kept on $REMOTE_REPO for debug"
  else
    kdust::log "Deleting remote branch '$BRANCH'"
    git -C "$WORKDIR" push origin --delete "$BRANCH" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
  exit $rc
}
trap cleanup EXIT

# ---------- 1. Init --------------------------------------------------------
cd "$WORKDIR"
git init -q -b "$BRANCH"
git config user.email "kdust-bot@ecritel.local"
git config user.name  "KDust Bot"
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${REMOTE_REPO}.git"

# ---------- 2. Rsync source ------------------------------------------------
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.vs' \
  --exclude='*.log' \
  --exclude='TestResults*.xml' \
  --exclude='bin/Debug' --exclude='bin/Release' --exclude='obj/' \
  "$SRC_DIR"/ "$WORKDIR"/

# ---------- 3. Generate workflow ------------------------------------------
mkdir -p .github/workflows
cat > .github/workflows/pester.yml <<'YAML'
name: Pester (Windows) - KDust sandbox
on:
  push:
    branches: ['ci/kdust-**']
permissions:
  contents: read
jobs:
  pester:
    runs-on: windows-latest
    timeout-minutes: 25
    env:
      SUITES_INPUT: __SUITES_PLACEHOLDER__
      PWSH_VERSION: __PWSH_PLACEHOLDER__
    steps:
      - uses: actions/checkout@v4

      - name: Install Pester 5.7+
        shell: pwsh
        run: |
          Set-StrictMode -Version Latest
          $ErrorActionPreference = 'Stop'
          if (-not (Get-Module -ListAvailable Pester | Where-Object Version -ge '5.7')) {
              Install-Module Pester -MinimumVersion 5.7 -Force -SkipPublisherCheck -Scope CurrentUser
          }

      - name: Resolve suites
        id: resolve
        shell: pwsh
        run: |
          Set-StrictMode -Version Latest
          $ErrorActionPreference = 'Stop'
          $raw = $env:SUITES_INPUT
          if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq 'all') {
              $paths = @('./Tests')
          } else {
              $paths = $raw.Split(',') | ForEach-Object { "./Tests/$($_.Trim())" }
          }
          $missing = $paths | Where-Object { -not (Test-Path $_) }
          if ($missing) { Write-Host "::error::Missing: $($missing -join ', ')"; exit 2 }
          "paths=$([string]::Join(';', $paths))" | Out-File $env:GITHUB_OUTPUT -Append

      - name: Run Pester (pwsh 7)
        if: env.PWSH_VERSION == '7'
        shell: pwsh
        run: |
          Set-StrictMode -Version Latest
          $ErrorActionPreference = 'Stop'
          Import-Module Pester -MinimumVersion 5.7 -Force
          $cfg = New-PesterConfiguration
          $cfg.Run.Path     = '${{ steps.resolve.outputs.paths }}'.Split(';')
          $cfg.Run.Exit     = $false
          $cfg.Run.PassThru = $true
          $cfg.Output.Verbosity = 'Detailed'
          $cfg.TestResult.Enabled      = $true
          $cfg.TestResult.OutputPath   = 'TestResults.xml'
          $cfg.TestResult.OutputFormat = 'NUnitXml'
          $r = Invoke-Pester -Configuration $cfg
          $summary = [pscustomobject]@{
              Passed = $r.PassedCount; Failed = $r.FailedCount
              Skipped = $r.SkippedCount; Total = $r.TotalCount
              Duration = [int]$r.Duration.TotalSeconds; Result = $r.Result
          }
          $summary | ConvertTo-Json | Set-Content TestSummary.json -Encoding UTF8
          @"
          ### Pester Results
          | Passed | Failed | Skipped | Total | Duration |
          |-------:|-------:|--------:|------:|---------:|
          | $($r.PassedCount) | $($r.FailedCount) | $($r.SkippedCount) | $($r.TotalCount) | $([int]$r.Duration.TotalSeconds)s |
          "@ | Out-File $env:GITHUB_STEP_SUMMARY -Append -Encoding UTF8
          if ($r.FailedCount -gt 0) { exit 1 }

      - name: Run Pester (Windows PowerShell 5.1)
        if: env.PWSH_VERSION == '5.1'
        shell: powershell
        run: |
          Set-StrictMode -Version Latest
          $ErrorActionPreference = 'Stop'
          [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
          if (-not (Get-Module -ListAvailable Pester | Where-Object Version -ge '5.7')) {
              Install-PackageProvider NuGet -Force -Scope CurrentUser | Out-Null
              Set-PSRepository PSGallery -InstallationPolicy Trusted
              Install-Module Pester -MinimumVersion 5.7 -Force -SkipPublisherCheck -Scope CurrentUser
          }
          Import-Module Pester -MinimumVersion 5.7 -Force
          $cfg = New-PesterConfiguration
          $cfg.Run.Path     = '${{ steps.resolve.outputs.paths }}'.Split(';')
          $cfg.Run.Exit     = $false
          $cfg.Run.PassThru = $true
          $cfg.Output.Verbosity = 'Detailed'
          $cfg.TestResult.Enabled      = $true
          $cfg.TestResult.OutputPath   = 'TestResults.xml'
          $cfg.TestResult.OutputFormat = 'NUnitXml'
          $r = Invoke-Pester -Configuration $cfg
          if ($r.FailedCount -gt 0) { exit 1 }

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: |
            TestResults.xml
            TestSummary.json
          if-no-files-found: warn
          retention-days: 7
YAML

sed -i "s|__SUITES_PLACEHOLDER__|${SUITES}|g" .github/workflows/pester.yml
sed -i "s|__PWSH_PLACEHOLDER__|${PWSH_VERSION}|g" .github/workflows/pester.yml

# ---------- 4. Commit + push -----------------------------------------------
git add -A
git commit -q -m "ci(kdust): sandbox $PROJECT $TS (suites=$SUITES pwsh=$PWSH_VERSION)"
SHA=$(git rev-parse HEAD)
kdust::log "Commit  : $SHA"
git push -q -u origin "$BRANCH"
kdust::log "Pushed, waiting for run..."

# ---------- 5. Find run_id -------------------------------------------------
RUN_ID=""
for i in $(seq 1 20); do
  sleep 3
  RUN_ID=$(gh run list \
    --repo "$REMOTE_REPO" \
    --branch "$BRANCH" \
    --limit 5 \
    --json databaseId,headSha \
    --jq "[.[] | select(.headSha == \"$SHA\")] | .[0].databaseId // empty")
  [ -n "$RUN_ID" ] && break
  kdust::log "Waiting for run (attempt $i/20)..."
done
[ -z "$RUN_ID" ] && { kdust::critical "No run found for SHA $SHA"; exit 4; }

kdust::log "Run ID  : $RUN_ID"
kdust::log "URL     : https://github.com/$REMOTE_REPO/actions/runs/$RUN_ID"

# ---------- 6. Watch -------------------------------------------------------
WATCH_RC=0
gh run watch "$RUN_ID" --repo "$REMOTE_REPO" --exit-status || WATCH_RC=$?

# ---------- 7. Download artifacts -----------------------------------------
gh run download "$RUN_ID" --repo "$REMOTE_REPO" --dir "$OUT_DIR" 2>/dev/null \
  || kdust::warn "No artifacts retrieved (likely failed before upload step)"

kdust::banner "PESTER RESULTS (run $RUN_ID)"
find "$OUT_DIR" -type f -printf '%p (%s bytes)\n' 2>/dev/null || ls -laR "$OUT_DIR"

if [ -f "$OUT_DIR/test-results/TestSummary.json" ]; then
  jq -r '"Passed=\(.Passed) Failed=\(.Failed) Skipped=\(.Skipped) Total=\(.Total) Duration=\(.Duration)s Result=\(.Result)"' \
    "$OUT_DIR/test-results/TestSummary.json"
fi

exit $WATCH_RC
