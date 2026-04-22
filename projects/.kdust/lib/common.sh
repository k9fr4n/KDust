#!/usr/bin/env bash
# =============================================================================
# KDust common shell helpers
# -----------------------------------------------------------------------------
# Sourced by every bin/* entry-point and driver. Provides:
#   - registry lookup (kdust::lookup <project> <yq-path>)
#   - output directory convention
#   - consistent log helpers
#   - preflight tool checks
# =============================================================================

# shellcheck shell=bash
set -euo pipefail

KDUST_ROOT="${KDUST_ROOT:-/projects/.kdust}"
KDUST_REGISTRY="${KDUST_REGISTRY:-$KDUST_ROOT/registry.yaml}"
KDUST_OUT_BASE="${KDUST_OUT_BASE:-/tmp/kdust}"

# ---------- Logging ----------------------------------------------------------
kdust::log()      { printf '[INFO] %s\n'     "$*" >&2; }
kdust::warn()     { printf '[WARN] %s\n'     "$*" >&2; }
kdust::error()    { printf '[ERROR] %s\n'    "$*" >&2; }
kdust::critical() { printf '[CRITICAL] %s\n' "$*" >&2; }

# ---------- Tool preflight ---------------------------------------------------
# Usage: kdust::require yq jq git
kdust::require() {
  local missing=()
  local t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    kdust::critical "Missing required tools: ${missing[*]}"
    kdust::critical "Rebuild KDust image: docker compose build"
    exit 127
  fi
}

# ---------- Registry ---------------------------------------------------------
# kdust::lookup <project> <yq-path-fragment>
# Example: kdust::lookup PSWinOps '.test.framework'
kdust::lookup() {
  local project="$1" path="$2"
  kdust::require yq
  yq -r ".projects.\"$project\"$path // \"\"" "$KDUST_REGISTRY"
}

# Fail if project unknown
kdust::require_project() {
  local project="$1"
  kdust::require yq
  local exists
  exists=$(yq -r "has(\"projects\") and (.projects | has(\"$project\"))" "$KDUST_REGISTRY")
  if [ "$exists" != "true" ]; then
    kdust::critical "Project '$project' not found in registry ($KDUST_REGISTRY)"
    kdust::log "Known projects:"
    yq -r '.projects | keys | .[]' "$KDUST_REGISTRY" | sed 's/^/  - /' >&2
    exit 2
  fi
}

kdust::project_path() {
  local project="$1"
  local p
  p=$(kdust::lookup "$project" '.path')
  [ -z "$p" ] && { kdust::critical "No .path defined for $project"; exit 2; }
  [ -d "$p" ] || { kdust::critical "Path does not exist: $p"; exit 2; }
  printf '%s\n' "$p"
}

# ---------- Output directory convention --------------------------------------
# /tmp/kdust/<task>/<project>/<ts>/
kdust::out_dir() {
  local task="$1" project="$2"
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local d="$KDUST_OUT_BASE/$task/$project/$ts"
  mkdir -p "$d"
  printf '%s\n' "$d"
}

# ---------- Summary banner ---------------------------------------------------
kdust::banner() {
  printf '\n========== %s ==========\n' "$*" >&2
}
