'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { MessageSquare, Plus, Send, Trash2, Wrench } from 'lucide-react';

type Agent = { sId: string; name: string };
type ConvSummary = {
  id: string;
  title: string;
  agentName: string | null;
  agentSId: string;
  updatedAt: string;
  projectName: string | null;
};
type Msg = { id: string; role: 'user' | 'agent' | 'system'; content: string; createdAt?: string };

export default function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [agentSId, setAgentSId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [cotText, setCotText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [mcpServerId, setMcpServerId] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle');
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();

  const refreshConvs = async () => {
    const r = await fetch('/api/conversations');
    const j = await r.json();
    setConvs(j.conversations ?? []);
  };

  const loadConv = async (id: string) => {
    setCurrentId(id);
    setStreamedText('');
    setCotText('');
    setError(null);
    const r = await fetch(`/api/conversations/${id}`);
    const j = await r.json();
    setMessages(j.conversation?.messages ?? []);
    setAgentSId(j.conversation?.agentSId ?? '');
  };

  useEffect(() => {
    void fetch('/api/agents')
      .then((r) => r.json())
      .then((j) => {
        const list = j.agents ?? [];
        setAgents(list);
        if (list.length && !agentSId) setAgentSId(list[0].sId);
      })
      .catch(() => setError('Cannot list agents — are you connected to Dust?'));
    void refreshConvs();
    // If ?id=... is present, open that conversation on mount
    const requested = searchParams.get('id');
    if (requested) void loadConv(requested);
    // Detect current project from cookie and start MCP fs server for it
    void fetch('/api/projects/current')
      .then((r) => (r.ok ? r.json() : { name: null }))
      .then(async (j) => {
        const name = j?.name ?? null;
        setCurrentProject(name);
        if (name) {
          setMcpStatus('starting');
          try {
            const r = await fetch('/api/mcp/ensure', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectName: name }),
            });
            const jj = await r.json();
            if (r.ok && jj.serverId) {
              setMcpServerId(jj.serverId);
              setMcpStatus('ready');
            } else {
              setMcpStatus('error');
              setError(jj.error ?? 'Failed to start MCP fs server');
            }
          } catch (e: any) {
            setMcpStatus('error');
            setError(e?.message ?? String(e));
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamedText]);

  const newChat = () => {
    setCurrentId(null);
    setMessages([]);
    setStreamedText('');
    setCotText('');
    setError(null);
  };

  const consumeStream = async (convId: string, userMessageSId: string) => {
    setStreaming(true);
    setStreamedText('');
    setCotText('');
    try {
      const r = await fetch(
        `/api/conversations/${convId}/stream?userMessageSId=${encodeURIComponent(userMessageSId)}`,
      );
      if (!r.body) throw new Error('no stream');
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const ev = /^event:\s*(\w+)/.exec(frame)?.[1];
          const dataLine = /\ndata:\s*(.*)$/s.exec(frame)?.[1] ?? '';
          const data = dataLine.replace(/\\n/g, '\n');
          if (ev === 'token') setStreamedText((t) => t + data);
          else if (ev === 'cot') setCotText((t) => t + data);
          else if (ev === 'error') setError(data);
          else if (ev === 'done') {
            setStreamedText('');
            setCotText('');
            // reload conv from server (agent message now persisted)
            await loadConv(convId);
            await refreshConvs();
          }
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setStreaming(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || streaming) return;
    const content = draft;
    setDraft('');
    setError(null);

    // Optimistic local append
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: 'user', content },
    ]);

    try {
      const mcpServerIds = mcpServerId ? [mcpServerId] : undefined;
      if (!currentId) {
        const agentName = agents.find((a) => a.sId === agentSId)?.name;
        const r = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentSId, agentName, content, mcpServerIds }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        setCurrentId(j.id);
        await consumeStream(j.id, j.userMessageSId);
      } else {
        const r = await fetch(`/api/conversations/${currentId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, mcpServerIds }),
        });
        if (!r.ok) throw new Error((await r.json()).error?.toString() ?? 'error');
        const j = await r.json();
        await consumeStream(currentId, j.userMessageSId);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  const removeConv = async (id: string) => {
    if (!confirm('Delete this conversation?')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentId === id) newChat();
    await refreshConvs();
  };

  const field =
    'w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100 px-3 py-2';

  return (
    <div className="grid grid-cols-[260px_1fr] gap-4 h-[calc(100vh-8rem)]">
      {/* Sidebar conversations */}
      <aside className="flex flex-col border border-slate-200 dark:border-slate-800 rounded-lg">
        <div className="p-3 border-b border-slate-200 dark:border-slate-800">
          <Button onClick={newChat} className="w-full justify-center">
            <Plus size={14} /> New chat
          </Button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {convs.length === 0 && (
            <li className="p-3 text-xs text-slate-500">No conversations yet.</li>
          )}
          {convs.map((c) => (
            <li
              key={c.id}
              className={`group flex items-center gap-1 px-2 ${
                currentId === c.id ? 'bg-slate-100 dark:bg-slate-800' : ''
              }`}
            >
              <button
                onClick={() => loadConv(c.id)}
                className="flex-1 text-left px-2 py-2 min-w-0"
              >
                <div className="text-sm font-medium truncate">{c.title}</div>
                <div className="text-xs text-slate-500 truncate">
                  {c.agentName ?? c.agentSId}
                  {c.projectName && <span className="ml-1">· {c.projectName}</span>}
                </div>
              </button>
              <button
                onClick={() => removeConv(c.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Main chat pane */}
      <section className="flex flex-col border border-slate-200 dark:border-slate-800 rounded-lg">
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
          <MessageSquare size={18} className="text-slate-400" />
          <select
            className={field + ' max-w-xs'}
            value={agentSId}
            onChange={(e) => setAgentSId(e.target.value)}
            disabled={!!currentId}
          >
            {agents.map((a) => (
              <option
                key={a.sId}
                value={a.sId}
                className="bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100"
              >
                {a.name}
              </option>
            ))}
          </select>
          {currentId && (
            <span className="text-xs text-slate-500">
              Agent locked for this conversation
            </span>
          )}

          {currentProject && (
            <span
              className={`ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded border ${
                mcpStatus === 'ready'
                  ? 'border-green-600 text-green-700 dark:text-green-400'
                  : mcpStatus === 'starting'
                    ? 'border-amber-500 text-amber-600 dark:text-amber-400'
                    : mcpStatus === 'error'
                      ? 'border-red-500 text-red-600 dark:text-red-400'
                      : 'border-slate-300 text-slate-500'
              }`}
              title={
                mcpServerId
                  ? `MCP fs tools active (serverId=${mcpServerId})`
                  : 'MCP fs tools inactive'
              }
            >
              <Wrench size={12} />
              {mcpStatus === 'ready'
                ? `fs tools · ${currentProject}`
                : mcpStatus === 'starting'
                  ? `starting fs tools…`
                  : mcpStatus === 'error'
                    ? 'fs tools error'
                    : `fs tools idle · ${currentProject}`}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-[80%] px-3 py-2 rounded-2xl rounded-br-sm text-sm whitespace-pre-wrap bg-blue-600 text-white shadow-sm'
                    : 'max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm text-sm whitespace-pre-wrap bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700'
                }
              >
                {m.content}
              </div>
            </div>
          ))}

          {cotText && (
            <div className="flex justify-start">
              <details className="max-w-[85%] text-xs text-slate-500 italic">
                <summary className="cursor-pointer select-none">thinking…</summary>
                <pre className="whitespace-pre-wrap mt-1 pl-3 border-l-2 border-slate-300 dark:border-slate-700">
                  {cotText}
                </pre>
              </details>
            </div>
          )}

          {streamedText && (
            <div className="flex justify-start">
              <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-bl-sm text-sm whitespace-pre-wrap bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700">
                {streamedText}
                <span className="inline-block w-2 h-4 -mb-0.5 ml-0.5 bg-slate-500 animate-pulse" />
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-start">
              <p className="text-red-500 text-sm">{error}</p>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <form onSubmit={send} className="p-3 border-t border-slate-200 dark:border-slate-800 flex gap-2">
          <textarea
            className={field + ' resize-none'}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).form?.requestSubmit();
              }
            }}
            placeholder={currentId ? 'Reply…' : 'Ask anything to start a new conversation…'}
            disabled={streaming || !agentSId}
          />
          <Button type="submit" disabled={streaming || !draft.trim() || !agentSId}>
            <Send size={14} /> {streaming ? 'Streaming…' : 'Send'}
          </Button>
        </form>
      </section>
    </div>
  );
}
