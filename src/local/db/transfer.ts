import { localDB, type ExportBundle } from './local';
import { getSettings } from './settings';
import type { SimRuntime } from '../sim/runtime';
import { DEFAULT_PROMPTS, promptStore } from '../ai/prompts';
import type { PromptKey } from '../ai/prompts';

/**
 * Import/export. One JSON file is the whole save: every IndexedDB table plus the
 * localStorage side of the database (settings, prompt overrides).
 */

export async function buildBundle(options: { includeSecrets?: boolean } = {}): Promise<ExportBundle> {
  const bundle = await localDB.exportBundle();
  // Snapshots are written every couple of seconds; make an export exact.
  if (options.includeSecrets === false) {
    const settings = JSON.parse(bundle.local['aifavella.settings'] ?? '{}');
    if (settings?.ai) {
      settings.ai.apiKey = '';
      settings.ai.embeddingApiKey = '';
      bundle.local['aifavella.settings'] = JSON.stringify(settings);
    }
  }
  return bundle;
}

export function serializeBundle(bundle: ExportBundle, pretty = true): string {
  return pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
}

export async function downloadBundle(options: { includeSecrets?: boolean } = {}) {
  const bundle = await buildBundle(options);
  downloadText(serializeBundle(bundle), `ai-town-local-${stamp()}.json`, 'application/json');
  return bundle;
}

export function downloadText(text: string, filename: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readFileAsText(file: File): Promise<string> {
  return await file.text();
}

export type BundleSummary = {
  exportedAt?: string;
  counts: Record<string, number>;
  hasSettings: boolean;
  hasPrompts: boolean;
};

export function summarizeBundle(bundle: ExportBundle): BundleSummary {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(bundle.tables ?? {})) {
    counts[table] = Array.isArray(rows) ? rows.length : 0;
  }
  return {
    exportedAt: bundle.exportedAt,
    counts,
    hasSettings: !!bundle.local?.['aifavella.settings'],
    hasPrompts: !!bundle.local?.['aifavella.prompts'],
  };
}

export async function applyBundle(
  bundle: ExportBundle,
  options: { replace?: boolean; runtime?: SimRuntime | null; reload?: boolean } = {},
) {
  await localDB.importBundle(bundle, { replace: options.replace ?? true });
  if (options.reload !== false) {
    // The simulation reads its state at boot; reloading is the simplest way to
    // make an imported world live without reconciling two engines.
    window.location.reload();
  }
}

export async function importBundleFromFile(
  file: File,
  options: { replace?: boolean; runtime?: SimRuntime | null; reload?: boolean } = {},
): Promise<BundleSummary> {
  const text = await readFileAsText(file);
  const bundle = parseBundle(text);
  await applyBundle(bundle, options);
  return summarizeBundle(bundle);
}

export function parseBundle(text: string): ExportBundle {
  const json = JSON.parse(text);
  if (json?.app === 'ai-town-local' && json.tables) return json as ExportBundle;
  // A bare `{ tables, local }` object without the wrapper is still fine.
  if (json?.tables) return { ...(json as ExportBundle), app: 'ai-town-local', version: 1 };
  throw new Error(
    'Unrecognized file: expected an AI-Town-local export with a `tables` object. ' +
      'Map or cast files are imported from their own editors instead.',
  );
}

export function downloadPrompts() {
  const prompts = { ...DEFAULT_PROMPTS, ...promptStore.get() };
  downloadText(JSON.stringify(prompts, null, 2), `aifavella-prompts-${stamp()}.json`, 'application/json');
}

export async function uploadPrompts(file: File) {
  const json = JSON.parse(await readFileAsText(file));
  const next: Partial<Record<PromptKey, string>> = {};
  for (const key of Object.keys(DEFAULT_PROMPTS) as PromptKey[]) {
    if (typeof json[key] === 'string') next[key] = json[key];
  }
  if (Object.keys(next).length === 0) throw new Error('No prompt keys found in that file.');
  promptStore.set({ ...DEFAULT_PROMPTS, ...next } as any);
  return next;
}

export function downloadSettings() {
  downloadText(
    JSON.stringify(getSettings(), null, 2),
    `aifavella-settings-${stamp()}.json`,
    'application/json',
  );
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
