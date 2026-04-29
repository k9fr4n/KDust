/**
 * In-memory ring buffer that captures all writes to process.stdout / process.stderr
 * and to console.log / console.info / console.warn / console.error once installed.
 *
 * Works in a single Next.js node process: the buffer is attached to globalThis so it
 * survives module re-evaluation in dev mode.
 *
 * REDACTION (#12, ADR-0005 follow-up, 2026-04-29). Two layers of secret scrubbing
 * are applied to every line both before it lands in the in-app buffer AND before
 * it reaches the underlying stdout/stderr (so `docker logs` is clean too):
 *
 *   1. STATIC ENV LAYER — process env values whose key matches a sensitive
 *      pattern (PASSWORD / TOKEN / SECRET / KEY / WEBHOOK / API_KEY). Computed
 *      once at installLogCapture() time. Always on.
 *   2. DYNAMIC RUN LAYER — per-run TaskSecret values registered by the runner
 *      via registerRedactSecrets(scopeId, refs) and dropped via
 *      unregisterRedactSecrets(scopeId). Used for command-runner outputs and any
 *      ad-hoc secret a task pulls in.
 *
 * The redactor is conservative (8+ chars, literal split/join replace, no regex)
 * so normal prose isn't accidentally blacked out.
 */

import { buildRedactor, type RedactRef } from '../secrets/redact';

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
  // #12 redaction state (kept on globalThis so dev-mode HMR doesn't lose
  // secret registrations when buffer.ts re-evaluates).
  staticSecrets: RedactRef[];
  staticValues: string[];
  runSecrets: Map<string, { values: string[]; refs: RedactRef[] }>;
  cachedRedactor: ((s: string) => string) | null;
}

const g = globalThis as unknown as { __kdustLogs?: State };
if (!g.__kdustLogs) {
  g.__kdustLogs = {
    entries: [],
    nextId: 1,
    max: 2000,
    installed: false,
    listeners: new Set(),
    staticSecrets: [],
    staticValues: [],
    runSecrets: new Map(),
    cachedRedactor: null,
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
  // Dust-side idle-close of MCP SSE streams (~5 min of silence).
  // Fully expected, the SDK polyfill auto-reconnects within seconds;
  // keeping them in the log only scares users (Franck 2026-04-20 22:21).
  //
  // (a) Raw SDK console.error — CRITICAL: that payload also dumps
  //     the full Bearer JWT via `headers.Authorization`. Dropping
  //     it is mandatory per the "no secrets in logs" policy, not
  //     just cosmetic.
  /Error in MCP EventSource connection:/i,
  // (b) Our own warn line immediately following the SDK error.
  /\[mcp\/fs-server\] SSE idle-close for project=/i,
  // (c) The "Attempting to reconnect to SSE..." + "MCP SSE
  //     connection established" pair that the polyfill emits 5 s
  //     later — also benign churn, paired 1-for-1 with (a).
  /Attempting to reconnect to SSE\.\.\./i,
  /^MCP SSE connection established$/i,
];

export function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// #12 redaction layer.
// ---------------------------------------------------------------------------

/**
 * Env keys whose value should always be redacted from logs. Matched
 * case-insensitively as a regex over the key name. The known KDust secrets
 * (APP_PASSWORD, APP_ENCRYPTION_KEY, KDUST_TELEGRAM_BOT_TOKEN, Dust /
 * WorkOS / Teams credentials) all match at least one of these.
 */
const SENSITIVE_ENV_KEY_RE =
  /(PASSWORD|TOKEN|SECRET|API_?KEY|WEBHOOK|ENCRYPTION_?KEY|BEARER|AUTHORIZATION)/i;

/**
 * Snapshot of process.env taken at installLogCapture() time. We don't
 * re-read env on every push() because (a) that's a lot of work for the
 * hot path and (b) env changes after boot are rare in our deploy model
 * (docker compose up). Operators that rotate a secret should restart the
 * process anyway.
 */
function snapshotStaticSecrets(): { refs: RedactRef[]; values: string[] } {
  const refs: RedactRef[] = [];
  const values: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || v.length < 8) continue;
    if (!SENSITIVE_ENV_KEY_RE.test(k)) continue;
    refs.push({ envName: k, secretName: `env:${k}` });
    values.push(v);
  }
  return { refs, values };
}

function rebuildRedactor() {
  const allValues: string[] = [...state.staticValues];
  const allRefs: RedactRef[] = [...state.staticSecrets];
  for (const { values, refs } of state.runSecrets.values()) {
    allValues.push(...values);
    allRefs.push(...refs);
  }
  state.cachedRedactor =
    allValues.length > 0 ? buildRedactor(allValues, allRefs) : null;
}

function redactText(s: string): string {
  return state.cachedRedactor ? state.cachedRedactor(s) : s;
}

/**
 * Register secret values to be redacted from every subsequent log line
 * (both the in-app buffer and the stdout/stderr piped to docker logs).
 * `scopeId` is typically a TaskRun id; pass the same id to
 * unregisterRedactSecrets() at the end of the run to release the
 * registration.
 *
 * Idempotent on scopeId: a second register for the same id replaces the
 * previous list.
 */
export function registerRedactSecrets(
  scopeId: string,
  entries: { value: string; ref: RedactRef }[],
): void {
  const values = entries.map((e) => e.value);
  const refs = entries.map((e) => e.ref);
  state.runSecrets.set(scopeId, { values, refs });
  rebuildRedactor();
}

export function unregisterRedactSecrets(scopeId: string): void {
  if (state.runSecrets.delete(scopeId)) {
    rebuildRedactor();
  }
}

function push(level: LogEntry['level'], text: string) {
  const trimmed = text.replace(/\n$/, '');
  if (!trimmed) return;
  if (isNoise(trimmed)) return;
  // Apply redaction here as a defensive layer: most callers now route
  // through the patched stdout/stderr where redaction already ran, but
  // direct push() calls (e.g. installLogCapture's bootstrap line) still
  // hit this path.
  const redacted = redactText(trimmed);
  const entry: LogEntry = { id: state.nextId++, ts: Date.now(), level, text: redacted };
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

  // Snapshot env-based secrets once, at install time. See
  // snapshotStaticSecrets() for the rationale.
  const { refs, values } = snapshotStaticSecrets();
  state.staticSecrets = refs;
  state.staticValues = values;
  rebuildRedactor();

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
      const redacted = redactText(s);
      push('log', redacted);
      // Replace the chunk we forward to docker logs with the redacted
      // version so Bearer tokens / passwords / webhooks never escape
      // the process boundary in plaintext.
      return (origStdout as any)(redacted, ...rest);
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
      const redacted = redactText(s);
      push('error', redacted);
      return (origStderr as any)(redacted, ...rest);
    } catch { /* ignore */ }
    return (origStderr as any)(chunk, ...rest);
  } as typeof process.stderr.write;

  push(
    'info',
    `[logs] capture installed (redaction: ${state.staticSecrets.length} static env secret(s))`,
  );
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
