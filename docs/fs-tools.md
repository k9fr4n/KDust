# fs-cli MCP tools

The `fs-cli` MCP server (`src/lib/mcp/fs-server.ts`, tools in
`src/lib/mcp/fs-tools.ts`) gives a Dust agent project-scoped file-system
access. Every tool is **chrooted** to `/projects/<project>` via `chroot()`
and its output is byte-capped (`KDUST_MCP_TOOL_OUTPUT_MAX_BYTES`) to stay
under the model context window.

## Read-before-write freshness guard (ADR-0024)

`read_file` records each file's `(mtime, size)`. `edit_file`,
`create_file` (overwrite) and `apply_patch` (update/delete/move) refuse to
write a file that **changed on disk since that recorded read** — the
typical cause being a formatter/codegen run via `run_command` between the
agent's read and its edit, which would make the agent's `old_string` /
patch context stale. The error asks the agent to re-read the file. Only
the *modified-since-read* case is blocked (files never read are still
writable, preserving blind `apply_patch` flows). Disable process-wide with
`KDUST_FS_FRESHNESS_GUARD=0`.

| Tool | Kind | Purpose |
|---|---|---|
| `read_file` | read | Read text, or extract PDF text (`pages`); binary → descriptor. |
| `edit_file` | write | Replace one exact snippet (`old_string`→`new_string`). |
| `create_file` | write | Create a NEW file (parent dirs auto-created). |
| `apply_patch` | write | Apply a multi-file, multi-hunk patch atomically. |
| `search_files` | read | Glob over the project tree. |
| `search_content` | read | ripgrep inside files (regex, context, output modes). |
| `run_command` | exec | Spawn a shell command in the project root. |
| `export_fil_to_workdir` | write | Materialise a Dust `fil_*` onto disk. |

## `read_file` (text + PDF)

Returns text for text files. For **PDFs** (by `.pdf` extension or `%PDF-`
magic) it extracts text via `pdftotext` (poppler-utils, shipped in the
image), with an optional `pages` range (`"3"` or `"1-5"`). A scanned /
image-only PDF yields a clear "no extractable text" note. **Binary** files
(images, archives) return a short `[image …]` / `[binary …]` descriptor
instead of raw bytes — image *vision* blocks are not supported by fs-cli
(the result wire shape is text-only); attach the image to the conversation
to view it. `offset`/`limit` apply to text reads only.

```json
{ "path": "docs/spec.pdf", "pages": "1-5" }
```

## `create_file`

Creates a file under the project root. Refuses to clobber an existing
file unless `overwrite=true`. Use this for brand-new files; use
`edit_file` / `apply_patch` to modify an existing one.

```json
{ "path": "src/lib/new-mod.ts", "content": "export const x = 1;\n", "overwrite": false }
```

## `apply_patch`

Applies a Claude-Code / Codex-style `*** Begin Patch` envelope. The whole
patch is parsed and applied **in memory first**; the disk is only touched
when every operation succeeds. A mid-batch write failure rolls back every
file already written, so the tree never lands half-applied.

### Envelope grammar

```
*** Begin Patch
*** Add File: <path>
+<every line of the new file, each prefixed with '+'>
*** Update File: <path>
*** Move to: <path>          (optional, right after Update File)
@@ <optional context hint>
 <unchanged context line, leading space>
-<removed line>
+<added line>
*** Delete File: <path>
*** End Patch
```

### Hunk matching

Matching is **strict and deterministic**: each hunk's `(context + removed)`
lines must appear as a *contiguous* block, searched forward from the end of
the previous hunk. There is no fuzzy/offset matching — if the agent's
context is stale the patch is rejected wholesale (`stale context?`) rather
than applied at the wrong location. Prefer `apply_patch` over a series of
`edit_file` calls when a change spans several spots or files and must land
atomically.

### Example

```
*** Begin Patch
*** Update File: src/app/api/task/route.ts
@@
-  const schema = z.object({ name: z.string() });
+  const schema = z.object({ name: z.string(), color: z.string().optional() });
*** Add File: docs/task-color.md
+# Task color
+Optional UI color field.
*** End Patch
```

### Parser

The envelope parser + in-memory applier live in a pure, FS-free module
(`src/lib/mcp/apply-patch.ts`) and are unit-tested under Vitest
(`src/lib/mcp/__tests__/apply-patch.spec.ts`).

## `search_content`

ripgrep-backed (`/usr/bin/rg`, v13) content search. **Backward
compatible**: with no optional args it behaves like the old
`grep -rni -F` — a case-insensitive, fixed-string substring search
returning `file:line:match` lines.

| Arg | Default | Effect |
|---|---|---|
| `pattern` | — | Text or regex to search for. |
| `path` | project root | Directory or file to search in. |
| `regex` | `false` | `true` → pattern is a regular expression (drops `-F`). |
| `case_insensitive` | `true` | `false` → case-sensitive (drops `-i`). |
| `output_mode` | `content` | `content` (lines) / `files_with_matches` / `count`. |
| `context` | — | Lines before AND after each match (`rg -C`). |
| `before_context` / `after_context` | — | `rg -B` / `-A`. |
| `glob` | — | `rg --glob` include/exclude, e.g. `*.ts` or `!*.test.ts`. |
| `file_pattern` | — | Deprecated alias for `glob`. |
| `type` | — | `rg --type` for standard file types, e.g. `ts`, `py`, `go`. |
| `multiline` | `false` | `rg -U --multiline-dotall`; `.` matches newlines (implies regex). |
| `head_limit` | 500 | Cap the number of returned lines (matches/files/counts). |
| `offset` | 0 | Skip the first N output lines before `head_limit` (paging). |

`node_modules`, `.git`, `dist`, `build`, `.next` and `coverage` are
always excluded; an explicit `glob` is applied after the excludes so an
include can win. Output is line-capped (500, or `head_limit`) and then
byte-capped by `KDUST_MCP_TOOL_OUTPUT_MAX_BYTES`. rg exit code 1
(no match) yields a friendly "No matches" message; code 2 surfaces the
ripgrep error.

```json
{ "pattern": "TODO|FIXME", "regex": true, "glob": "*.ts", "context": 2 }
```
