// 跨平台執行 .venv 內的 Python（Windows: .venv/Scripts/python.exe；其他: .venv/bin/python）。
// 用法：node scripts/py.mjs install          建立 .venv 並安裝 server/requirements.txt
//       node scripts/py.mjs <python 參數...>  以 .venv 的 Python 執行（例如 -m pytest）
//       開頭的 KEY=VALUE 參數會設為環境變數（跨平台，例如 NODE_ENV=production -m server.app）
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const venvPython = join('.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

const env = { ...process.env };
const args = process.argv.slice(2);
while (args.length && /^[A-Z_][A-Z0-9_]*=/.test(args[0])) {
  const [key, ...rest] = args.shift().split('=');
  env[key] = rest.join('=');
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (args[0] === 'install') {
  if (!existsSync(venvPython)) run(isWin ? 'python' : 'python3', ['-m', 'venv', '.venv']);
  run(venvPython, ['-m', 'pip', 'install', '-q', '-r', 'server/requirements.txt']);
} else {
  if (!existsSync(venvPython)) {
    console.error('找不到 .venv，請先執行 npm run py:install');
    process.exit(1);
  }
  run(venvPython, args);
}
