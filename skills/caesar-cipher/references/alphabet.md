# Caesar shift reference table

Letters are shifted within their case-preserving alphabet. The
shift `n` is normalised to `[0, 25]` via `((n % 26) + 26) % 26`
before being applied.

## Shift table

| Shift | A | B | C | D | E | F | G | H | I | J | K | L | M |
|-------|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0     | A | B | C | D | E | F | G | H | I | J | K | L | M |
| 1     | B | C | D | E | F | G | H | I | J | K | L | M | N |
| 3     | D | E | F | G | H | I | J | K | L | M | N | O | P |
| 13    | N | O | P | Q | R | S | T | U | V | W | X | Y | Z |
| 25    | Z | A | B | C | D | E | F | G | H | I | J | K | L |

Shift 13 is the classical "ROT13": its own inverse (decrypt = encrypt).

## Non-letter passthrough

The scripts do **not** touch any character that is not in `[A-Za-z]`.
Digits, spaces, punctuation, accented letters (`é`, `ü`, ...),
emoji and any non-ASCII codepoint are emitted as-is.

If you need to cipher accented letters, normalise the input first
(e.g. `iconv -f UTF-8 -t ASCII//TRANSLIT`) before piping it into
`encrypt.sh`.
