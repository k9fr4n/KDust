'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/Button';
import { MessageSquare, Plus, Send, Square, Trash2, Wrench } from 'lucide-react';

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
  // Suspense boundary required by Next.js 15 because ChatPageInner calls useSearchParams().
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading chat…</div>}>
      <ChatPageInner />
    </Suspense>
  );
}

function ChatPageInner() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [agentSId, setAgentSId] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [cotText, setCotText] = useState('');
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [mcpServerId, setMcpServerId] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle');
  // `serverStreaming` reflects server-side knowledge of an in-flight agent
  // reply. It stays true even if the user navigated away and came back,
  // as long as the Dust call is still producing tokens in the background.
  const [serverStreaming, setServerStreaming] = useState(false);
  const [serverStreamingSince, setServerStreamingSince] = useState<string | null>(null);
  // AbortController for the current SSE fetch so the Stop button can
  // tear the client read loop down immediately, in addition to asking
  // Dust (via /cancel) to stop generating server-side.
  const streamAbortRef = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);
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
    const c = j.conversation;
    setMessages(c?.messages ?? []);
    setAgentSId(c?.agentSId ?? '');
    // Reflect server-side stream status so users who navigated away
    // mid-answer can still see that the reply is being produced.
    setServerStreaming(!!j.streaming);
    setServerStreamingSince(j.streamingSince ?? null);

    // Sync the current-project cookie + ProjectSwitcher with the conversation's project
    const convProject: string | null = c?.projectName ?? null;
    if (convProject !== currentProject) {
      try {
        await fetch('/api/current-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: convProject }),
        });
      } catch {
        /* ignore */
      }
      setCurrentProject(convProject);
      window.dispatchEvent(
        new CustomEvent('kdust:project-changed', { detail: { name: convProject } }),
      );
      // Re-ensure MCP fs server for the new project
      if (convProject) {
        setMcpStatus('starting');
        try {
          const rr = await fetch('/api/mcp/ensure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectName: convProject }),
          });
          const jj = await rr.json();
          if (rr.ok && jj.serverId) {
            setMcpServerId(jj.serverId);
            setMcpStatus('ready');
          } else {
            setMcpStatus('error');
          }
        } catch {
          setMcpStatus('error');
        }
      } else {
        setMcpServerId(null);
        setMcpStatus('idle');
      }
    }
  };

  useEffect(() => {
    void fetch('/api/agents')
      .then((r) => r.json())
      .then((j) => {
        const list = j.agents ?? [];
        setAgents(list);
        // Use the functional setter form: only fall back to the first agent
        // if loadConv hasn't already set one. The closure captures the initial
        // empty agentSId from mount, so a plain `!agentSId` check would race
        // with loadConv and silently overwrite the conv's actual agent.
        if (list.length) setAgentSId((prev) => prev || list[0].sId);
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

  // When the server reports a stream in progress for the current conv
  // but THIS tab is not the one consuming it (e.g. user reopened the
  // conv after navigating away), poll the conv every 3s. When the
  // server clears the flag, fetch messages once more to pick up the
  // freshly-persisted agent reply.
  useEffect(() => {
    if (!currentId || !serverStreaming || streaming) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/conversations/${currentId}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!j.streaming) {
          // stream has finished elsewhere — reload messages (includes the
          // newly-persisted agent reply) and clear the banner.
          setMessages(j.conversation?.messages ?? []);
          setServerStreaming(false);
          setServerStreamingSince(null);
        }
      } catch {
        /* transient */
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [currentId, serverStreaming, streaming]);

  const newChat = () => {
    setCurrentId(null);
    setMessages([]);
    setStreamedText('');
    setCotText('');
    setError(null);
  };

  const consumeStream = async (convId: string, userMessageSId: string) => {
    setStreaming(true);
    // This tab is actively consuming the stream → mirror the server
    // flag so the banner/dot stays visible if the user briefly scrolls
    // up past the live bubble.
    setServerStreaming(true);
    setServerStreamingSince(new Date().toISOString());
    setStreamedText('');
    setCotText('');
    setToolCalls([]);
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
          else if (ev === 'agent_message_id') {
            // Server tracks the sId itself for the /cancel endpoint.
            // We receive it purely for forward-compat / debugging.
          }
          else if (ev === 'tool_call') {
            try {
              const p = JSON.parse(data);
              const summary = `${p.tool}(${
                p.params ? JSON.stringify(p.params).slice(0, 140) : ''
              })`;
              setToolCalls((arr) => [...arr, summary]);
            } catch {
              setToolCalls((arr) => [...arr, data]);
            }
          } else if (ev === 'error') setError(data);
          else if (ev === 'done') {
            setStreamedText('');
            setCotText('');
            setToolCalls([]);
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
      // loadConv() above will refresh serverStreaming from the API; if the
      // stream wrapped up before we finished consuming, we still want the
      // banner gone immediately.
      setServerStreaming(false);
      setServerStreamingSince(null);
    }
  };

  // Stop the in-flight agent reply. Two concurrent actions:
  //   1) POST /cancel so Dust stops generating tokens server-side
  //      (also clears the active-streams tracker so isStreaming() flips false)
  //   2) Abort the local SSE fetch so the UI unfreezes immediately,
  //      regardless of Dust's response latency.
  const stopStream = async () => {
    if (!currentId || stopping) return;
    setStopping(true);
    try {
      void fetch(`/api/conversations/${currentId}/cancel`, { method: 'POST' }).catch(
        () => {/* best-effort */},
      );
    } finally {
      streamAbortRef.current?.abort();
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
    // Height math:
    //   - sticky <Nav/> is h-14 (3.5rem) at the top of <body>
    //   - RootLayout wraps children in <main class="py-6"> → 3rem vertical
    // So the chat surface must be calc(100dvh - 6.5rem) to fit exactly on
    // screen without producing a page-level scrollbar. dvh (vs vh) keeps it
    // stable on mobile browsers that resize the viewport with their
    // address bar. min-h-0 lets flex children shrink so only the inner
    // messages pane scrolls, never the page.
    <div className="grid grid-cols-[260px_1fr] gap-4 h-[calc(100dvh-6.5rem)] min-h-0">
      {/* Sidebar conversations */}
      <aside className="flex flex-col min-h-0 border border-slate-200 dark:border-slate-800 rounded-lg">
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
      <section className="flex flex-col min-h-0 border border-slate-200 dark:border-slate-800 rounded-lg">
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

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
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

          {toolCalls.length > 0 && (
            <div className="flex flex-col gap-1">
              {toolCalls.map((t, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-xs text-slate-500 font-mono bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 max-w-fit"
                >
                  <Wrench size={12} className="text-amber-500" />
                  {t}
                </div>
              ))}
            </div>
          )}

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

        {/* Status strip — sits directly above the Reply textarea so users
            immediately see why the form is disabled and can hit Stop
            without hunting for context. Two mutually exclusive states:
              - `streaming`       : this tab is actively consuming the SSE
              - `serverStreaming` : another tab/no tab owns the stream
            Both show a Stop button; the handler is idempotent. */}
        {(streaming || serverStreaming) && (
          <div
            className={`flex items-center gap-2 px-3 py-2 text-xs border-t ${
              streaming
                ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30 text-blue-800 dark:text-blue-300'
                : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
            }`}
            role="status"
            aria-live="polite"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  streaming ? 'bg-blue-400' : 'bg-amber-400'
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  streaming ? 'bg-blue-500' : 'bg-amber-500'
                }`}
              />
            </span>
            <span className="flex-1">
              {streaming ? (
                'Streaming live…'
              ) : (
                <>
                  Agent is still replying in the background
                  {serverStreamingSince && (
                    <>
                      {' '}· started{' '}
                      {new Date(serverStreamingSince).toLocaleTimeString()}
                    </>
                  )}
                  . The reply will appear automatically when it’s ready.
                </>
              )}
            </span>
            {currentId && (
              <button
                type="button"
                onClick={stopStream}
                disabled={stopping}
                title="Stop the agent's reply"
                className="inline-flex items-center gap-1 rounded border border-red-400 px-2 py-0.5 text-red-700 hover:bg-red-100 dark:border-red-600 dark:text-red-300 dark:hover:bg-red-900/40 disabled:opacity-50"
              >
                <Square size={12} />
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        )}

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
