#!/usr/bin/env bash
# Caesar cipher encryption.
# Usage: encrypt.sh <shift> <text>
# - Preserves case.
# - Passes through non-letters unchanged.
# - Normalises shift modulo 26 (handles negative values too).
# - Echoes only the resulting string (no labels).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: encrypt.sh <shift> <text>" >&2
  exit 64
fi

shift_arg="$1"
text="$2"

if ! [[ "$shift_arg" =~ ^-?[0-9]+$ ]]; then
  echo "shift must be an integer, got: $shift_arg" >&2
  exit 64
fi

# Normalise to [0, 25].
shift_n=$(( ((shift_arg % 26) + 26) % 26 ))

# Build per-char shift using bash + tr.
result=""
for (( i=0; i<${#text}; i++ )); do
  ch="${text:i:1}"
  case "$ch" in
    [A-Z])
      code=$(printf '%d' "'${ch}")
      shifted=$(( (code - 65 + shift_n) % 26 + 65 ))
      result+=$(printf "\\$(printf '%03o' "$shifted")")
      ;;
    [a-z])
      code=$(printf '%d' "'${ch}")
      shifted=$(( (code - 97 + shift_n) % 26 + 97 ))
      result+=$(printf "\\$(printf '%03o' "$shifted")")
      ;;
    *)
      result+="$ch"
      ;;
  esac
done
printf '%s\n' "$result"
