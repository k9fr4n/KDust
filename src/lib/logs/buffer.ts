/**
 * In-memory ring buffer that captures all writes to process.stdout / process.stderr
 * and to console.log / console.info / console.warn / console.error once installed.
 *
 * Works in a single Next.js node process: the buffer is attached to globalThis so it
 * survives module re-evaluation in dev mode.
 */

export interface LogEntry {
  id: number;
  ts: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

interface State {
  entries: LogEntry[];
  nextId: number;
  max: number;
  installed: boolean;
  listeners: Set<(e: LogEntry) => void>;
}

const g = globalThis as unknown as { __kdustLogs?: State };
if (!g.__kdustLogs) {
  g.__kdustLogs = {
    entries: [],
    nextId: 1,
    max: 2000,
    installed: false,
    listeners: new Set(),
  };
}
const state = g.__kdustLogs!;

/**
 * Patterns we silently drop from BOTH the in-app buffer and the underlying
 * stdout/stderr (so `docker logs` is also clean). Pure 3rd-party noise.
 */
const NOISE_PATTERNS: RegExp[] = [
  // event-source-polyfill heartbeat timeout (Dust MCP transport auto-reconnects)
  /No activity within \d+ milliseconds.*Reconnecting/i,
  // Stack frame of the heartbeat above (next.js compiled chunk)
  /at V \(\.next\/server\/chunks\/.*Timeout\._onTimeout/i,
  /at Timeout\._onTimeout \(\.next\/server\/chunks\//i,
  // 401 retry storm on expired Dust token (we detect & recover in fs-server.onerror)
  /EventSource'?s response has a status 401 Unauthorized/i,
  // SSE connection errors surfaced by our own onerror with non-Error payloads;
  // they correspond to heartbeat reconnects and are already absorbed.
  /\[mcp\/fs-server\] transport error project=.*SSE connection error/i,
];

export function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(text));
}

function push(level: LogEntry['level'], text: string) {
  const trimmed = text.replace(/\n$/, '');
  if (!trimmed) return;
  if (isNoise(trimmed)) return;
  const entry: LogEntry = { id: state.nextId++, ts: Date.now(), level, text: trimmed };
  state.entries.push(entry);
  if (state.entries.length > state.max) {
    state.entries.splice(0, state.entries.length - state.max);
  }
  for (const l of state.listeners) {
    try { l(entry); } catch { /* ignore listener error */ }
  }
}

export function installLogCapture() {
  if (state.installed) return;
  state.installed = true;

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = function patchedStdout(chunk: any, ...rest: any[]) {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      if (isNoise(s)) {
        // Drop both from buffer and from the underlying stream (docker logs).
        const cb = rest.find((a) => typeof a === 'function');
        if (cb) (cb as any)();
        return true;
      }
      push('log', s);
    } catch { /* ignore */ }
    return (origStdout as any)(chunk, ...rest);
  } as typeof process.stdout.write;

  process.stderr.write = function patchedStderr(chunk: any, ...rest: any[]) {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      if (isNoise(s)) {
        const cb = rest.find((a) => typeof a === 'function');
        if (cb) (cb as any)();
        return true;
      }
      push('error', s);
    } catch { /* ignore */ }
    return (origStderr as any)(chunk, ...rest);
  } as typeof process.stderr.write;

  push('info', '[logs] capture installed');
}

export function getLogs(since?: number): LogEntry[] {
  if (since === undefined) return [...state.entries];
  return state.entries.filter((e) => e.id > since);
}

export function subscribe(cb: (e: LogEntry) => void): () => void {
  state.listeners.add(cb);
  return () => { state.listeners.delete(cb); };
}

export function clearLogs() {
  state.entries.splice(0, state.entries.length);
}
