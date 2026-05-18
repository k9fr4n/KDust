// src/lib/mcp/catalog-yaml.ts
//
// Minimal parser for `mcp-gateway/catalogs/kdust-custom.yaml` —
// extracts the per-server tool inventory declared under
// `registry.<slug>.tools[].name`.
//
// Used by /settings/mcp to scope the FilterEditorModal's tool
// picker to the server the operator is editing (Franck 2026-05-18).
// Before this, the modal showed the *union* of every gateway tool
// across all enabled servers, which was both confusing and the
// reason ews-mcp tools "disappeared" behind playwright's 23.
//
// We deliberately do NOT depend on `js-yaml`: adding a top-level
// dep for one read of one file we control would be overkill, and
// the structure we care about is a fixed two-level shape
// (registry > slug > tools > -name). A short line-scan parser
// does the job and survives comment lines / blank lines / extra
// keys.
//
// Returns {} when the file is missing — the UI falls back to the
// full gateway tool list in that case (degrades gracefully).

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_CATALOG_PATH =
  process.env.KDUST_CATALOG_YAML_PATH?.trim() ||
  '/app/mcp-gateway/catalogs/kdust-custom.yaml';

export type CatalogToolsBySlug = Record<string, string[]>;

/**
 * Parse `kdust-custom.yaml` and return `{ slug: [toolName, ...] }`.
 *
 * Resilient by design:
 *   - File missing      -> returns {} (UI falls back to all tools).
 *   - Parse error       -> returns {} and logs at warn.
 *   - Unknown sub-keys  -> ignored (we only look at `tools:` and
 *                         `- name:` inside the `registry:` block).
 */
export async function loadCatalogToolsBySlug(
  filePath: string = DEFAULT_CATALOG_PATH,
): Promise<CatalogToolsBySlug> {
  let text: string;
  try {
    text = await fs.readFile(path.resolve(filePath), 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/.test(msg)) return {};
    console.warn(`[mcp/catalog-yaml] read failed: ${msg}`);
    return {};
  }
  return parseCatalogToolsBySlug(text);
}

/**
 * Pure parser, exported for unit-level tests / debugging.
 *
 * State machine:
 *   - `inRegistry`  toggles when we see `^registry:\s* at col 0
 *                   and turns off when a new top-level key appears.
 *   - `currentSlug` set when we see a 2-space-indented identifier:
 *                   `  <slug>:\s*.
 *   - `inTools`     true between `    tools:\s* and the next
 *                   4-space-indented sibling key (`    secrets:`,
 *                   `    image:`, etc.).
 *   - Lines `      - name: <toolName>` push the tool name onto
 *     the current slug's array.
 */
export function parseCatalogToolsBySlug(yamlText: string): CatalogToolsBySlug {
  const out: CatalogToolsBySlug = {};
  let inRegistry = false;
  let currentSlug: string | null = null;
  let inTools = false;

  const slugRe = /^ {2}([a-z0-9][a-z0-9-]*):\s*$/;
  const subKeyRe = /^ {4}([a-z][a-z0-9_-]*):\s*(.*)$/;
  const toolRe = /^ {6}- name:\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(?:#.*)?$/;
  const topKeyRe = /^([a-z][a-z0-9_-]*):\s*/;

  for (const rawLine of yamlText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;

    // Top-level keys (col 0). Toggle inRegistry; reset substate.
    if (!line.startsWith(' ')) {
      const topMatch = topKeyRe.exec(line);
      if (topMatch) {
        inRegistry = topMatch[1] === 'registry';
        currentSlug = null;
        inTools = false;
      }
      continue;
    }

    if (!inRegistry) continue;

    // Slug header at 2-space indent.
    const slugMatch = slugRe.exec(line);
    if (slugMatch) {
      currentSlug = slugMatch[1];
      inTools = false;
      if (!out[currentSlug]) out[currentSlug] = [];
      continue;
    }

    if (!currentSlug) continue;

    // Sub-key at 4-space indent: enter/leave the tools block.
    const subMatch = subKeyRe.exec(line);
    if (subMatch) {
      inTools = subMatch[1] === 'tools';
      continue;
    }

    if (!inTools) continue;

    // Tool entry: `      - name: <tool>`
    const toolMatch = toolRe.exec(line);
    if (toolMatch) {
      const name = toolMatch[1];
      const arr = out[currentSlug] ?? (out[currentSlug] = []);
      if (!arr.includes(name)) arr.push(name);
    }
  }

  return out;
}
