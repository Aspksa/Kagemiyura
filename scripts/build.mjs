import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(join(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
await cp(join(root, 'public'), join(root, 'dist/public'), { recursive: true });
await mkdir(join(root, 'dist/public/assets'), { recursive: true });
await cp(join(root, 'dist/web/app.js'), join(root, 'dist/public/assets/app.js'));
await cp(join(root, 'dist/web/brain.js'), join(root, 'dist/public/assets/brain.js'));
await mkdir(join(root, 'dist/public/shared'), { recursive: true });
await cp(join(root, 'dist/shared/sse.js'), join(root, 'dist/public/shared/sse.js'));
await cp(join(root, 'src/web/style.css'), join(root, 'dist/public/assets/style.css'));
console.log('Кагэмиюра: сборка готова.');
