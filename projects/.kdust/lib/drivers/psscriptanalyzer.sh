#!/usr/bin/env bash
# =============================================================================
# Driver : PSScriptAnalyzer (lint PowerShell via throwaway pwsh container)
# Inputs (env): PROJECT, SRC_DIR, FIX=0|1 (applies -Fix when 1)
# =============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../common.sh"
kdust::require docker
: "${PROJECT:?}"; : "${SRC_DIR:?}"
FIX="${FIX:-0}"

TASK="run-lint"; [ "$FIX" = "1" ] && TASK="run-format"
OUT_DIR=$(kdust::out_dir "$TASK" "$PROJECT")

MOUNT_MODE="ro"; [ "$FIX" = "1" ] && MOUNT_MODE="rw"

kdust::log "PSScriptAnalyzer on $SRC_DIR (fix=$FIX, mount=$MOUNT_MODE)"

docker run --rm \
  -v "$SRC_DIR:/workspace:$MOUNT_MODE" \
  -v "$OUT_DIR:/out" \
  -w /workspace \
  mcr.microsoft.com/powershell:7.5-ubuntu-24.04 \
  pwsh -NoProfile -NoLogo -Command "
    \$ErrorActionPreference='Continue'
    if (-not (Get-Module -ListAvailable PSScriptAnalyzer)) {
      Install-Module PSScriptAnalyzer -Force -Scope CurrentUser *>\$null
    }
    Import-Module PSScriptAnalyzer
    \$params = @{ Path='/workspace'; Recurse=\$true }
    if ('$FIX' -eq '1') { \$params['Fix'] = \$true }
    \$results = Invoke-ScriptAnalyzer @params
    \$results | ConvertTo-Json -Depth 5 | Set-Content /out/psscriptanalyzer.json -Encoding UTF8
    \$results | Format-Table -AutoSize | Out-String -Width 4096 | Write-Output
    \$err  = (\$results | Where-Object Severity -eq 'Error').Count
    \$warn = (\$results | Where-Object Severity -eq 'Warning').Count
    \$info = (\$results | Where-Object Severity -eq 'Information').Count
    Write-Output ''
    Write-Output \"Error=\$err Warning=\$warn Information=\$info\"
    if (\$err -gt 0) { exit 1 }
  "

kdust::banner "PSScriptAnalyzer — $PROJECT"
kdust::log "Report: $OUT_DIR/psscriptanalyzer.json"
