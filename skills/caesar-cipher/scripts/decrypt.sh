#!/usr/bin/env bash
# Caesar cipher decryption.
# Usage: decrypt.sh <shift> <text>
# Equivalent to encrypt.sh with the opposite shift.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: decrypt.sh <shift> <text>" >&2
  exit 64
fi

shift_arg="$1"
if ! [[ "$shift_arg" =~ ^-?[0-9]+$ ]]; then
  echo "shift must be an integer, got: $shift_arg" >&2
  exit 64
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/encrypt.sh" "$(( -shift_arg ))" "$2"
