'use client';
import type { SectionProps } from './state';
import { field, sectionCls, legendCls } from './styles';

/**
 * ADR-0002 routing metadata (description / tags / inputsSchema /
 * sideEffects). Surfaced by the task-runner MCP server in
 * list_tasks/describe_task so an orchestrator can pick the right
 * task without parsing the prompt.
 */
export function RoutingSection({ form, setForm }: SectionProps) {
  return (
      <fieldset className={sectionCls}>
        <legend className={legendCls}>Routing metadata <span className="text-xs font-normal text-slate-500">(MCP discovery)</span></legend>
        <label className="block">
          <span className="text-sm">Description</span>
          <textarea
            className={`${field} min-h-16 text-sm`}
            value={form.description ?? ''}
            onChange={(e) => setForm({ ...form, description: e.target.value || null })}
            placeholder="1-3 sentences: what is this task for? (read by the routing layer, not the executing agent)"
          />
          <span className="text-xs text-slate-500">
            Returned by <code className="font-mono">list_tasks</code>. Distinct from the prompt — write it for the orchestrator that has to pick this task, not for the agent that runs it.
          </span>
        </label>
        <label className="block">
          <span className="text-sm">Tags <span className="text-slate-400 text-xs">(comma-separated)</span></span>
          <input
            className={`${field} font-mono`}
            value={form.tagsInput}
            onChange={(e) => setForm({ ...form, tagsInput: e.target.value })}
            placeholder="lint, ci, audit, refacto"
          />
          <span className="text-xs text-slate-500">
            Cheap keyword matching. Stored as a JSON array on the wire.
          </span>
        </label>
        <label className="block">
          <span className="text-sm">Inputs schema <span className="text-slate-400 text-xs">(JSON Schema)</span></span>
          <textarea
            className={`${field} min-h-24 font-mono text-xs`}
            value={form.inputsSchema ?? ''}
            onChange={(e) => setForm({ ...form, inputsSchema: e.target.value || null })}
            placeholder={'{\n  "type": "object",\n  "properties": { "ticket": { "type": "string" } },\n  "required": ["ticket"]\n}'}
          />
          <span className="text-xs text-slate-500">
            Shape expected for the <code className="font-mono">input</code> override on dispatch. Server rejects malformed JSON.
          </span>
        </label>
        <fieldset className="space-y-1">
          <legend className="text-sm">Side effects</legend>
          {(['readonly', 'writes', 'pushes'] as const).map((v) => (
            <label key={v} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="sideEffects"
                className="mt-0.5"
                checked={form.sideEffects === v}
                onChange={() => setForm({ ...form, sideEffects: v })}
              />
              <span>
                <span className="font-mono">{v}</span>
                <span className="block text-xs text-slate-500">
                  {v === 'readonly' && 'Pure analysis / report. Orchestrator may dispatch without confirmation.'}
                  {v === 'writes' && 'Mutates the working tree. Default — confirmation expected.'}
                  {v === 'pushes' && 'Triggers the git push pipeline. Highest gate.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      </fieldset>
  );
}
