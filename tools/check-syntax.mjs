import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['vendor', 'node_modules', '.git', '_作業用'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.mjs')) files.push({ full, module: true });
    else if (full === path.join(root, 'gas', 'Code.gs') || (full.startsWith(path.join(root, 'docs') + path.sep) && entry.name.endsWith('.js'))) files.push({ full, module: false });
  }
}
walk(root);
let failed = false;
for (const file of files.sort((a, b) => a.full.localeCompare(b.full))) {
  try {
    if (file.module) {
      const result = spawnSync(process.execPath, ['--check', file.full], { encoding: 'utf8', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || '構文を確認できませんでした。');
    } else new vm.Script(fs.readFileSync(file.full, 'utf8'), { filename: path.relative(root, file.full) });
  } catch (error) {
    failed = true; console.error('構文エラー：' + path.relative(root, file.full) + '\n' + error.message);
  }
}
if (failed) process.exitCode = 1;
else console.log('構文OK ' + files.length + '件');
