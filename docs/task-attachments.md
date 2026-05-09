# Task attachments

_Franck 2026-05-09_

Files attached to a Task definition. Re-uploaded to Dust as content
fragments on **every** run — cron tick, `/run` button, MCP
dispatch, Telegram bridge: every code path that ends up in
`src/lib/cron/runner/phases/run-agent.ts` picks them up.

## Why store the bytes locally

Dust file ids (`fil_xxx`) are short-lived and conversation-bound.
A task may run weeks or months after creation, so caching the
`fileId` returned at upload time would silently break.

KDust therefore keeps the bytes on disk and re-uploads them at
run-time. Yes, that re-runs the upload network round-trip on every
tick — it's the price for keeping attachments alive across the
lifetime of a task.

## Storage layout

Root dir: `process.env.KDUST_ATTACHMENTS_DIR` (default
`/projects/.kdust-attachments`).

```
<root>/
  <taskId>/
    <attachmentId>__<sanitized-filename>
```

The `storagePath` column in `TaskAttachment` is **relative** to the
root, so moving the env value doesn't invalidate existing rows.

Filenames are sanitised: any path traversal (`..`, `/`, `\`,
leading dots) or non-`[A-Za-z0-9._-]` byte is collapsed to `_`. The
original filename stays in the DB row for display and is the one
passed to Dust as the content fragment title.

## Caps

| Scope         | Limit  |
| ------------- | ------ |
| Per file      | 50 MB  |
| Per task (sum)| 200 MB |

Validated client-side (UX), at the API (`POST /api/task/:id/attachment`)
and once more in the storage helper (defence in depth). All three
share constants from `src/lib/task-attachments.ts`.

## API

| Method   | Path                                        | Purpose                  |
| -------- | ------------------------------------------- | ------------------------ |
| `GET`    | `/api/task/:id/attachment`                  | List rows for a task     |
| `POST`   | `/api/task/:id/attachment`                  | Multipart upload (`files`)|
| `GET`    | `/api/task/:id/attachment/:attId`           | Download bytes           |
| `DELETE` | `/api/task/:id/attachment/:attId`           | Remove row + on-disk blob|

`contentType` is **already** normalised at upload time using
`src/lib/dust/content-type.ts` (same table the chat composer uses
for `.ps1`, `.toml`, `Dockerfile`, etc.) so the runner can re-upload
without re-applying the fallback.

## Runner wiring

In `run-agent.ts`, BEFORE `createDustConversation`:

1. `db.taskAttachment.findMany({ where: { taskId: job.id } })`
2. For each row, `readAttachmentBytes()` → `new File([buf], name, { type })`
   → `dust.client.uploadFile({ useCase: 'conversation', … })`.
3. Pass the resulting `fileIds` + `fileMetas` arrays as the last
   two args of `createDustConversation` (already supported — same
   wire shape as the chat composer).

A Dust upload failure is FATAL: the run errors out instead of
running without the file the user attached. Bytes-on-disk are
immutable mid-run; if the operator deletes the on-disk blob while
the runner is reading it, the read fails fast and the run errors.

## UI

- `/task/new` and `/task/:id/edit` render the `<TaskAttachments>`
  inline editor (`src/components/TaskAttachments.tsx`).
  - On `/task/new`, it runs in **deferred** mode — selected files
    are buffered client-side and uploaded by `TaskForm` after the
    task row is created.
  - On `/edit`, it talks to the API directly (upload / delete).
- `/task/:id` shows a read-only chip list with a download link per
  file.

## Cleanup

- DB cascade: deleting a `Task` cascades to `TaskAttachment` rows.
- Filesystem: `DELETE /api/task/:id` calls `deleteTaskAttachmentDir`
  to `rm -rf` the per-task folder. Failures are swallowed (best-
  effort), so a stale folder from a previously-failed delete is
  harmless.

## Out of scope

- No per-run override (orchestrators cannot inject extra files
  through `enqueue_followup`).
- No versioning (replacement = delete + re-upload).
- No at-rest encryption. Don't store credentials here — use the
  Secret Manager (`/settings/secrets`).
