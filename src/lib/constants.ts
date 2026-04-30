/**
 * Cross-cutting magic constants for KDust.
 *
 * Cleanup item #16. Before this module existed, the same numeric
 * literals (15000ms registration timeout, 1500ms "Copied!" flash,
 * 8 / 12 picker takes, …) were duplicated across 5+ files. Any
 * tweak risked drift; reading the call site gave no semantic clue
 * about what the number represented.
 *
 * Scope policy:
 *
 *   IN  — values used by 2+ files OR carrying non-obvious semantics
 *         (rate-limit budgets, SDK contracts, Telegram quotas).
 *   OUT — single-component UI tunings (scroll thresholds, sidebar
 *         widths, etc.) which stay private to their .tsx file.
 *
 * Domain-specific catalogues live next to their owner instead
 * (e.g. src/lib/cron/runner/constants.ts for the runner, src/lib/
 * mcp/task-runner/constants.ts for MCP depth/limits). This file
 * intentionally does NOT re-export them — importing from the
 * domain keeps the dependency direction obvious.
 */

// ---------------------------------------------------------------
// UI feedback (toast-style flashes)
// ---------------------------------------------------------------

/**
 * Duration of the transient "✓ Copied!" / "✓ Done" feedback shown
 * after a clipboard or one-shot action. Used by ChatImage,
 * ChatMessageBubble, MessageMarkdown, /logs and the chat composer.
 */
export const UI_FLASH_MS = 1500;

/**
 * Duration for save-state pills ("Saved…" → idle) on settings forms.
 * Slightly longer than UI_FLASH_MS so the user has time to register
 * a successful PATCH on a busy form.
 */
export const UI_SAVE_RESET_MS = 2000;

/**
 * Settle delay after a destructive action (rerun, cancel, delete)
 * before the runs list re-fetches. Lets the optimistic UI "calm
 * down" before reconciling, which avoids the visual flicker of
 * a row briefly disappearing then reappearing.
 */
export const RUNS_AUTO_REFRESH_SETTLE_MS = 400;

// ---------------------------------------------------------------
// Polling intervals
// ---------------------------------------------------------------

/**
 * Poll period for the CommandsLive panel on /run/[id]. Has to stay
 * ≥ 1s to avoid hammering SQLite on long agent runs.
 */
export const COMMANDS_LIVE_POLL_MS = 2000;

// ---------------------------------------------------------------
// MCP server registration
// ---------------------------------------------------------------

/**
 * Hard timeout for the Dust client → KDust MCP server handshake
 * (registerMCPServer call). Identical across fs-cli, task-runner,
 * and command-runner because all three follow the same protocol
 * and the bottleneck is Dust's frontend, not the local code.
 *
 * 15s is comfortable: a healthy registration takes <1s; anything
 * past 5s is already a Dust-side hiccup and we want to fail fast
 * rather than block the chat /api/mcp/ensure path forever.
 */
export const MCP_REGISTRATION_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------
// List sizes
// ---------------------------------------------------------------

/**
 * Max items shown in the dashboard "recent runs" / "recent
 * conversations" cards. 8 fits one screen on a 13" laptop without
 * scrolling and matches the visual density of the rest of the page.
 */
export const DASHBOARD_RECENT_LIMIT = 8;

/**
 * Max items shown in a Telegram inline-keyboard picker (/chats,
 * /runs). Bounded above by Telegram's 100-button keyboard cap;
 * 12 keeps the message under one screen on a phone in portrait.
 */
export const TELEGRAM_PICKER_LIMIT = 12;
