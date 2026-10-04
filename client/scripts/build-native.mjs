import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform !== 'win32') throw new Error('应用声音模块需要在 Windows 上构建');
const source = fileURLToPath(new URL('../native/', import.meta.url));
const build = path.join(source, 'build');
for (const args of [['-S', source, '-B', build, '-A', 'x64'], ['--build', build, '--config', 'Release']]) {
  const result = spawnSync('cmake', args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status) throw result.error || new Error(`原生模块构建失败 ${result.status}`);
}
