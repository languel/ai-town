// Bundles + runs a headless script in Node without adding a build dependency:
// vite already ships esbuild, and Node can import ESM by absolute path.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { mkdir } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

// `node scripts/run-smoke.mjs invite-stress` runs scripts/invite-stress.ts;
// SMOKE_ENTRY overrides with an explicit path.
const arg = process.argv[2];
const entry =
  process.env.SMOKE_ENTRY ?? (arg ? (arg.endsWith('.ts') ? arg : `scripts/${arg}.ts`) : 'scripts/smoke.ts');

const searchPaths = [root, resolve(root, 'node_modules/vite'), resolve(root, 'node_modules')];
let esbuild;
try {
  esbuild = await import(pathToFileURL(require.resolve('esbuild', { paths: searchPaths })).href);
} catch {
  console.error('esbuild not found — run `npm install` first');
  process.exit(1);
}

const outDir = resolve(root, 'node_modules/.cache/aifavella-smoke');
const out = resolve(outDir, `${basename(entry).replace(/\.[^.]+$/, '')}.mjs`);
await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, entry)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: out,
  logLevel: 'warning',
  external: ['node:*'],
});

await import(pathToFileURL(out).href);
