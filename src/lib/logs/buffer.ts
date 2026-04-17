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
 * Patterns we silently drop from the buffer. Mostly benign noise from
 * 3rd-party libraries that would otherwise pollute the in-app log viewer.
 * Add entries here when a noisy and harmless message is identified.
 */
const NOISE_PATTERNS: RegExp[] = [
  // event-source-polyfill heartbeat timeout (Dust MCP transport reconnects on its own)
  /No activity within \d+ milliseconds\..*Reconnecting\./i,
  // 401 retry storm on expired Dust token. We detect it in fs-server.onerror
  // and trigger a one-shot recovery warn, so the raw repeated lines are noise.
  /EventSource'?s response has a status 401 Unauthorized/i,
];

function isNoise(text: string): boolean {
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
      push('log', s);
    } catch { /* ignore */ }
    return (origStdout as any)(chunk, ...rest);
  } as typeof process.stdout.write;

  process.stderr.write = function patchedStderr(chunk: any, ...rest: any[]) {
    try {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
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
