# fs-cli MCP tools

The `fs-cli` MCP server (`src/lib/mcp/fs-server.ts`, tools in
`src/lib/mcp/fs-tools.ts`) gives a Dust agent project-scoped file-system
access. Every tool is **chrooted** to `/projects/<project>` via `chroot()`
and its output is byte-capped (`KDUST_MCP_TOOL_OUTPUT_MAX_BYTES`) to stay
under the model context window.

| Tool | Kind | Purpose |
|---|---|---|
| `read_file` | read | Read text, or extract PDF text (`pages`); binary → descriptor. |
| `edit_file` | write | Replace one exact snippet (`old_string`→`new_string`). |
| `create_file` | write | Create a NEW file (parent dirs auto-created). |
| `apply_patch` | write | Apply a multi-file, multi-hunk patch atomically. |
| `search_files` | read | Glob over the project tree. |
| `search_content` | read | grep (fixed-string) inside files. |
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
