import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const installedCmake = 'C:\\Program Files\\CMake\\bin\\cmake.exe';
const bundledCmake = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2017\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe';
const cmake = existsSync(installedCmake) ? installedCmake : existsSync(bundledCmake) ? bundledCmake : 'cmake';
const mode = process.argv[2] ?? 'configure';

const args =
  mode === 'build'
    ? ['--build', '../../target/capture', '--config', 'Release']
    : ['-S', '../capture', '-B', '../../target/capture', '-A', 'x64'];

const result = spawnSync(cmake, args, { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
