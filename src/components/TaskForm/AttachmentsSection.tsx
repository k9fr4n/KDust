'use client';
import { TaskAttachments, type PendingTaskFile } from '@/components/TaskAttachments';

/**
 * Section hosting the task's file attachments. Two-mode wiring:
 *  - edit  : <TaskAttachments> talks directly to the API.
 *  - new   : deferred mode — selected files are buffered in the
 *            parent form state (via setPendingFiles) and uploaded
 *            after the task row is created.
 *
 * No business logic here; the heavy lifting lives in
 * TaskAttachments.tsx. Kept as its own section component to match
 * the rest of the form's layout (one section = one fieldset).
 */
export function AttachmentsSection({
  taskId,
  isEdit,
  pendingFiles,
  setPendingFiles,
}: {
  taskId: string | undefined;
  isEdit: boolean;
  pendingFiles: PendingTaskFile[];
  setPendingFiles: React.Dispatch<React.SetStateAction<PendingTaskFile[]>>;
}) {
  return (
    <fieldset className="border border-slate-300/60 dark:border-slate-700/60 rounded-md p-4 space-y-2">
      <legend className="px-2 text-sm font-semibold">Attachments</legend>
      {isEdit ? (
        <TaskAttachments taskId={taskId} />
      ) : (
        <TaskAttachments
          deferred
          onPendingChange={(files) => setPendingFiles(files)}
        />
      )}
      {!isEdit && pendingFiles.length > 0 && (
        <p className="text-[11px] text-slate-500">
          {pendingFiles.length} file{pendingFiles.length === 1 ? '' : 's'} will be
          uploaded after the task is created.
        </p>
      )}
    </fieldset>
  );
}
