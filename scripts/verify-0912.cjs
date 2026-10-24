const { spawn, spawnSync } = require('node:child_process');
const { openSync, closeSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const checks = {
  tests: ['node_modules/vitest/vitest.mjs', 'run', 'src/lib/providers/openai-compatible-media.test.ts', 'src/lib/__tests__/sqlite-storage.test.ts', 'src/lib/__tests__/storyboard-film.test.ts', 'src/lib/__tests__/storyboard-film-route.test.ts', 'src/lib/__tests__/storyboard-film-media.test.ts', 'src/lib/__tests__/gen-params.test.ts', '--exclude', 'release/**', '--pool', 'threads', '--maxWorkers', '2'],
  lint: ['node_modules/eslint/bin/eslint.js', 'src/components/generation-settings.tsx', 'src/components/model-capability-preflight.tsx', 'src/app/project/[id]/assets/page.tsx', 'src/app/api/project/[id]/compose/route.ts', 'src/app/api/project/[id]/storyboard-film/route.ts', 'src/lib/video-duration.ts', 'src/lib/storyboard-film-media.ts', 'src/lib/providers/openai-compatible-media.ts', 'src/lib/__tests__/storyboard-film-media.test.ts', 'src/lib/__tests__/storyboard-film-route.test.ts', 'src/lib/__tests__/gen-params.test.ts'],
  types: ['node_modules/typescript/bin/tsc', '--noEmit'],
  build: ['node_modules/next/dist/bin/next', 'build'],
  bundle: ['scripts/bundle-standalone.mjs'],
  exe: ['node_modules/electron-builder/cli.js', '--win', '--x64', '--publish', 'never'],
  integration: ['node_modules/electron/cli.js', 'artifacts/fix-0912/integration.cjs'],
  smoke: ['artifacts/fix-0912/smoke.cjs'],
  probe: ['artifacts/fix-0912/probe.cjs'],
};
const [mode, check] = process.argv.slice(2);
if (!checks[check]) throw new Error(`Unknown check: ${check}`);
const dir = path.resolve('artifacts/fix-0912');
mkdirSync(dir, { recursive: true });
if (mode === 'launch') {
  const child = spawn(process.execPath, [__filename, 'run', check], { cwd: process.cwd(), detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`${check}: PID ${child.pid}`);
} else if (mode === 'run') {
  const fd = openSync(path.join(dir, `${check}.log`), 'w');
  const result = spawnSync(process.execPath, checks[check], { cwd: process.cwd(), stdio: ['ignore', fd, fd], env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...(check === 'integration' && { ELECTRON_RUN_AS_NODE: '1' }) } });
  closeSync(fd);
  writeFileSync(path.join(dir, `${check}.result.json`), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }));
  process.exitCode = result.status ?? 1;
} else throw new Error(`Unknown mode: ${mode}`);
