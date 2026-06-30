import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '..');
const backendDir = resolve(repoDir, 'backend/cpp');
const backendBuildDir = resolve(backendDir, 'build');
const backendBinary = resolve(backendBuildDir, 'steel_inspection_backend');
const backendPort = process.env.INSPECTION_BACKEND_PORT ?? '4873';

const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: appDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      INSPECTION_BACKEND_PORT: backendPort,
      VITE_INSPECTION_BACKEND_ORIGIN: `http://127.0.0.1:${backendPort}`,
    },
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function runChecked(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = run(command, args, options);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${code}`));
      }
    });
  });
}

function stopAll(signal = 'SIGTERM') {
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

process.on('SIGINT', () => {
  stopAll('SIGINT');
  process.exit(130);
});

process.on('SIGTERM', () => {
  stopAll('SIGTERM');
  process.exit(143);
});

await mkdir(backendBuildDir, { recursive: true });
await runChecked('cmake', ['-S', backendDir, '-B', backendBuildDir]);
await runChecked('cmake', ['--build', backendBuildDir, '--config', 'Debug']);

if (!existsSync(backendBinary)) {
  throw new Error(`Backend binary missing: ${backendBinary}`);
}

const backend = run(backendBinary, [], { cwd: appDir });
const vite = run('vite', ['--host', '0.0.0.0'], { cwd: appDir });

await new Promise((resolvePromise) => {
  let resolved = false;
  const finish = (code) => {
    if (!resolved) {
      resolved = true;
      stopAll();
      resolvePromise(code ?? 0);
    }
  };
  backend.once('exit', finish);
  vite.once('exit', finish);
});
