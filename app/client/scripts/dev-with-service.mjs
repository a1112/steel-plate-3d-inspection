import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(clientDir, '..', '..');
const serviceDir = resolve(clientDir, '..', 'service');
const cargoTargetDir = resolve(repoDir, 'target', 'cargo');
const serviceBinary = resolve(cargoTargetDir, 'debug', process.platform === 'win32' ? 'steel-inspection-service.exe' : 'steel-inspection-service');
const servicePort = process.env.INSPECTION_SERVICE_PORT ?? '4873';

const children = new Set();

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: clientDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CARGO_TARGET_DIR: cargoTargetDir,
      INSPECTION_SERVICE_PORT: servicePort,
      VITE_INSPECTION_SERVICE_ORIGIN: `http://127.0.0.1:${servicePort}`,
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

await runChecked('cargo', ['build', '--manifest-path', resolve(serviceDir, 'Cargo.toml')]);

if (!existsSync(serviceBinary)) {
  throw new Error(`Service binary missing: ${serviceBinary}`);
}

const service = run(serviceBinary, [], { cwd: clientDir });
const vite = run('vite', ['--host', '0.0.0.0'], { cwd: clientDir });

await new Promise((resolvePromise) => {
  let resolved = false;
  const finish = (code) => {
    if (!resolved) {
      resolved = true;
      stopAll();
      resolvePromise(code ?? 0);
    }
  };
  service.once('exit', finish);
  vite.once('exit', finish);
});
