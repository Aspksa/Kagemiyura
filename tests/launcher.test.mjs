import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function launch(port) {
  const child = spawn(process.execPath, ['scripts/launch.mjs'], { cwd: root, env: { ...process.env, KAGEMIYURA_NO_BROWSER: '1', KAGEMIYURA_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}
test('binds the next port and reuses a running instance without starting a second server', { timeout: 60000 }, async t => {
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  t.after(() => occupied.close());
  if (port > 65504) return;
  const first = launch(port);
  t.after(async () => { if (first.child.exitCode === null) { first.child.kill(); await once(first.child, 'exit'); } });
  const deadline = Date.now() + 45000;
  let metadata;
  while (Date.now() < deadline) {
    if (first.child.exitCode !== null) throw new Error(first.output());
    try {
      metadata = JSON.parse(await readFile(new URL('../.runtime/server.json', import.meta.url), 'utf8'));
      if (metadata.pid === first.child.pid) break;
    } catch { /* startup still running */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(metadata?.pid, first.child.pid, first.output());
  assert.notEqual(metadata.port, port);
  const response = await fetch(`http://127.0.0.1:${metadata.port}/api/health`);
  assert.equal(response.status, 200);
  const second = launch(port);
  const [code] = await once(second.child, 'exit');
  assert.equal(code, 0, second.output());
  assert.match(second.output(), /уже работает/);
  const after = JSON.parse(await readFile(new URL('../.runtime/server.json', import.meta.url), 'utf8'));
  assert.equal(after.pid, first.child.pid);
});
