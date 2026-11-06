import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function launch(port, launchRoot) {
  const child = spawn(process.execPath, ['scripts/launch.mjs'], { cwd: launchRoot, env: { ...process.env, KAGEMIYURA_NO_BROWSER: '1', KAGEMIYURA_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}
test('binds the next port and reuses a running instance without starting a second server', { timeout: 60000 }, async t => {
  // The launcher performs a clean build: isolate it from API tests serving dist.
  const launchRoot = await mkdtemp(join(tmpdir(), 'Кагэмиюра ! % ^ & (тест) [1]-'));
  const children = [];
  let occupied;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    }
    if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
    await rm(launchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const path of ['src', 'public', 'scripts', 'node_modules', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    await cp(join(root, path), join(launchRoot, path), { recursive: true });
  }
  occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  if (port > 65504) return;
  const first = launch(port, launchRoot);
  children.push(first.child);
  const deadline = Date.now() + 45000;
  let metadata;
  while (Date.now() < deadline) {
    if (first.child.exitCode !== null) throw new Error(first.output());
    try {
      metadata = JSON.parse(await readFile(join(launchRoot, '.runtime/server.json'), 'utf8'));
      if (metadata.pid === first.child.pid) break;
    } catch { /* startup still running */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(metadata?.pid, first.child.pid, first.output());
  assert.notEqual(metadata.port, port);
  const response = await fetch(`http://127.0.0.1:${metadata.port}/api/health`);
  assert.equal(response.status, 200);
  const second = launch(port, launchRoot);
  children.push(second.child);
  const [code] = await once(second.child, 'exit');
  assert.equal(code, 0, second.output());
  assert.match(second.output(), /уже работает/);
  const after = JSON.parse(await readFile(join(launchRoot, '.runtime/server.json'), 'utf8'));
  assert.equal(after.pid, first.child.pid);
});
