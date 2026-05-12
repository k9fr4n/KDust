---
name: caesar-cipher
description: Encrypt or decrypt a message with a Caesar shift cipher.
---

# Caesar cipher

A toy classical cipher: each letter is shifted by a fixed integer
amount in the alphabet. Useful for demos, smoke tests of the
skills MCP server, and the occasional CTF challenge.

## When to use

- The user asks to encrypt or decrypt a short string with a
  fixed shift ("Caesar", "ROT-N", "shift cipher").
- The shift is known. For unknown shifts (brute force,
  frequency analysis), this skill is **not** the right tool;
  iterate `decrypt` over shifts 1..25 manually.

## How to call

Use `run_skill_script` with `command` set to one of:

- `["scripts/encrypt.sh", "<shift>", "<text>"]`
- `["scripts/decrypt.sh", "<shift>", "<text>"]`

`<shift>` is a small integer (positive or negative). `<text>`
is the plaintext or ciphertext. Both scripts:

- Preserve case (`A-Z` stays uppercase, `a-z` stays lowercase).
- Pass through any non-letter character unchanged (spaces,
  digits, punctuation).
- Normalise the shift modulo 26 (so `27` behaves like `1`).
- Echo only the resulting string on stdout, no trailing label
  (the agent should not need to parse the output).

Example (shift = 3, text = "Hello, World!"):

```
run_skill_script {
  "skill": "caesar-cipher",
  "command": ["scripts/encrypt.sh", "3", "Hello, World!"]
}
-> { "ok": true, "exitCode": 0,
     "stdout": "Khoor, Zruog!\n", "stderr": "" }
```

## References

See [`references/alphabet.md`](references/alphabet.md) for the
shift table used by the scripts.
