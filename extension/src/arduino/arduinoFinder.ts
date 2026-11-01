// Arduino CLI path discovery engine.
// Pure Node module, zero vscode imports.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const ARDUINO_CLI_INSTALL_URL = 'https://arduino.github.io/arduino-cli/latest/installation/';

/**
 * Returns candidate paths for arduino-cli on Windows, macOS, and Linux.
 */
export function getCandidateArduinoCliPaths(env: Record<string, string | undefined> = process.env): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const home = env.HOME || env.USERPROFILE || '';

  if (process.platform === 'win32') {
    // 1. Arduino IDE 2 bundled arduino-cli
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'));
      candidates.push(path.join(localAppData, 'Arduino15', 'bin', 'arduino-cli.exe'));
      candidates.push(path.join(localAppData, 'Arduino15', 'arduino-cli.exe'));
    }
    candidates.push(path.join(programFiles, 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'));
    candidates.push(path.join(programFilesX86, 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'));
    candidates.push(path.join(programFiles, 'Arduino CLI', 'arduino-cli.exe'));
    candidates.push(path.join(programFilesX86, 'Arduino CLI', 'arduino-cli.exe'));
  } else if (process.platform === 'darwin') {
    // macOS
    candidates.push('/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli');
    candidates.push('/usr/local/bin/arduino-cli');
    candidates.push('/opt/homebrew/bin/arduino-cli');
    if (home) {
      candidates.push(path.join(home, 'bin', 'arduino-cli'));
      candidates.push(path.join(home, '.local', 'bin', 'arduino-cli'));
      candidates.push(path.join(home, 'Library', 'Arduino15', 'bin', 'arduino-cli'));
    }
  } else {
    // Linux
    candidates.push('/usr/local/bin/arduino-cli');
    candidates.push('/usr/bin/arduino-cli');
    if (home) {
      candidates.push(path.join(home, 'bin', 'arduino-cli'));
      candidates.push(path.join(home, '.local', 'bin', 'arduino-cli'));
      candidates.push(path.join(home, '.arduino15', 'bin', 'arduino-cli'));
    }
  }

  return candidates;
}

/**
 * Discovers arduino-cli executable path:
 * 1. Checks customPath (eide.arduino.cliPath)
 * 2. Checks PATH environment variable
 * 3. Checks standard local installation paths
 */
export function findArduinoCli(
  customPath?: string,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (fs.existsSync(trimmed)) {
      return path.resolve(trimmed);
    }
  }

  // Check PATH
  const pathEnv = env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  const exeName = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';

  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  // Check known standard locations
  const candidates = getCandidateArduinoCliPaths(env);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return path.resolve(c);
    }
  }

  return undefined;
}
