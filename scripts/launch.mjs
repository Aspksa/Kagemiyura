import { open, readFile, readdir, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, '.runtime');
const metadataFile = join(runtime, 'server.json');
const lockFile = join(runtime, 'launch.lock');
const lockId = randomUUID();
let ownsLock = false;
let server;
const noBrowser = process.env.KAGEMIYURA_NO_BROWSER === '1';
await mkdir(runtime, { recursive: true });
await mkdir(join(root, 'data/logs'), { recursive: true });
async function log(message) {
  console.log(message);
  await appendFile(join(root, 'data/logs/application.log'), `${new Date().toISOString()} ${message}\n`).catch(() => {});
}
function openBrowser(url) {
  if (noBrowser) return;
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => { console.log(`Откройте адрес вручную: ${url}`); });
  child.unref();
}
async function existing() {
  try {
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
    if (!Number.isInteger(metadata.port) || metadata.port < 1024 || metadata.port > 65535 || typeof metadata.instanceId !== 'string') return false;
    const url = `http://127.0.0.1:${metadata.port}`;
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const health = await response.json();
    if (response.ok && health.app === 'Kagemiyura' && health.instanceId === metadata.instanceId) {
      await log(`Кагэмиюра уже работает: ${url}`);
      openBrowser(url);
      return true;
    }
  } catch { /* stale metadata is normal after a forced shutdown */ }
  return false;
}
async function acquire() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const file = await open(lockFile, 'wx');
      ownsLock = true;
      await file.writeFile(JSON.stringify({ pid: process.pid, id: lockId }));
      await file.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await existing()) return false;
      try {
        const lock = JSON.parse(await readFile(lockFile, 'utf8'));
        try { process.kill(lock.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') { await rm(lockFile, { force: true }); continue; }
        }
      } catch { /* another launch may still be writing its lock */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('Другой запуск ещё не завершён. Если процесс уже закрыт, удалите .runtime/launch.lock и повторите.');
}
async function fingerprint() {
  const hash = createHash('sha256').update(process.versions.node);
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(entry.name);
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else hash.update(await readFile(join(path, entry.name)));
    }
  }
  for (const directory of ['src', 'public']) await walk(join(root, directory));
  for (const file of ['tsconfig.json', 'package-lock.json', 'scripts/build.mjs']) hash.update(await readFile(join(root, file)));
  return hash.digest('hex');
}
async function cleanup() {
  if (!ownsLock) return;
  try {
    if (JSON.parse(await readFile(lockFile, 'utf8')).id === lockId) await rm(lockFile, { force: true });
    if (JSON.parse(await readFile(metadataFile, 'utf8')).instanceId === lockId) await rm(metadataFile, { force: true });
  } catch { /* metadata may not exist if startup failed */ }
}
try {
  if (!(await existing()) && await acquire()) {
    // Recheck after owning the lock in case a server appeared between both checks.
    if (!(await existing())) {
      const digest = await fingerprint();
      const previous = await readFile(join(runtime, 'build.sha256'), 'utf8').catch(() => '');
      const compiled = await readFile(join(root, 'dist/server/app.js')).then(() => true, () => false);
      const frontend = await readFile(join(root, 'dist/public/assets/app.js')).then(() => true, () => false);
      if (previous !== digest || !compiled || !frontend) {
        await log('Сборка TypeScript…');
        execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
        await writeFile(join(runtime, 'build.sha256'), digest);
      }
      const { createApp } = await import(new URL('../dist/server/app.js', import.meta.url));
      server = createApp({ dataDir: join(root, 'data'), publicDir: join(root, 'dist/public'), instanceId: lockId });
      const preferred = Number(process.env.KAGEMIYURA_PORT ?? '8765');
      if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65504) throw new Error('KAGEMIYURA_PORT: допустим порт от 1024 до 65504.');
      let port;
      for (let candidate = preferred; candidate < preferred + 32; candidate++) {
        try {
          await new Promise((resolve, reject) => {
            const onError = error => { server.off('listening', onListening); reject(error); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(candidate, '127.0.0.1');
          });
          port = candidate;
          break;
        } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
      }
      if (!port) throw new Error('Нет свободного порта. Освободите один из 32 портов начиная с выбранного.');
      await writeFile(metadataFile, JSON.stringify({ port, pid: process.pid, instanceId: lockId }));
      const url = `http://127.0.0.1:${port}`;
      await log(`Кагэмиюра готова: ${url}\nДля остановки нажмите Ctrl+C в этом окне.`);
      openBrowser(url);
      let stopping = false;
      async function stop() {
        if (stopping) return;
        stopping = true;
        server.close();
        server.closeAllConnections();
        await cleanup();
      }
      process.on('SIGINT', () => { void stop(); });
      process.on('SIGTERM', () => { void stop(); });
    } else await cleanup();
  }
} catch (error) {
  if (server?.listening) { server.close(); server.closeAllConnections(); }
  await cleanup();
  await log(`Ошибка запуска: ${error.message}`);
  process.exitCode = 1;
}
