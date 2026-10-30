// MATLAB executable discovery.
// Pure Node module, zero vscode imports, testable with node --test and fake env / fs mocks.

import * as fs from 'fs';
import * as path from 'path';

export interface MatlabFinderOptions {
  customPath?: string;
  env?: Record<string, string | undefined>;
  existsSync?: (p: string) => boolean;
  readdirSync?: (p: string) => string[];
}

/**
 * Sorts MATLAB release folder names in descending order (e.g. R2026a > R2025b > R2025a).
 */
export function sortMatlabReleaseFolders(folders: string[]): string[] {
  return [...folders].sort((a, b) => {
    // Match patterns like R2026a, R2025b, etc.
    const matchA = a.match(/^R(\d{4})([a-z])$/i);
    const matchB = b.match(/^R(\d{4})([a-z])$/i);
    if (matchA && matchB) {
      const yearA = parseInt(matchA[1], 10);
      const yearB = parseInt(matchB[1], 10);
      if (yearA !== yearB) {
        return yearB - yearA; // newer year first
      }
      return matchB[2].toLowerCase().localeCompare(matchA[2].toLowerCase()); // 'b' before 'a'
    }
    if (matchA) return -1;
    if (matchB) return 1;
    return b.localeCompare(a);
  });
}

/**
 * Discovers the MATLAB executable path.
 * Search order:
 *  1. customPath (eide.matlab.path setting)
 *  2. C:\Program Files\MATLAB\R20*\bin\matlab.exe (newest release first)
 *  3. macOS / Linux default installation locations
 *  4. PATH environment variable
 */
export function findMatlab(options?: MatlabFinderOptions): string | undefined {
  const customPath = options?.customPath;
  const env = options?.env || process.env;
  const existsSync = options?.existsSync || fs.existsSync;
  const readdirSync = options?.readdirSync || ((p: string) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  });

  // 1. Custom path
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (existsSync(trimmed)) {
      return path.resolve(trimmed);
    }
  }

  // 2. Windows Program Files
  const programFiles = env.ProgramFiles !== undefined ? env.ProgramFiles : 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] !== undefined ? env['ProgramFiles(x86)'] : 'C:\\Program Files (x86)';

  for (const root of [programFiles, programFilesX86]) {
    if (!root) continue;
    const matlabRoot = path.join(root, 'MATLAB');
    if (existsSync(matlabRoot)) {
      const entries = readdirSync(matlabRoot);
      const releaseDirs = sortMatlabReleaseFolders(entries.filter(e => /^R20/i.test(e)));
      for (const rel of releaseDirs) {
        const exe = path.join(matlabRoot, rel, 'bin', 'matlab.exe');
        if (existsSync(exe)) {
          return path.resolve(exe);
        }
      }
    }
  }

  // 3. macOS applications (/Applications/MATLAB_R20*.app/bin/matlab)
  const macApps = '/Applications';
  if (existsSync(macApps)) {
    const entries = readdirSync(macApps);
    const releaseApps = sortMatlabReleaseFolders(
      entries.filter(e => /^MATLAB_R20.*\.app$/i.test(e)).map(e => e.replace(/^MATLAB_|\.app$/gi, ''))
    );
    for (const rel of releaseApps) {
      const macBin = path.join(macApps, `MATLAB_${rel}.app`, 'bin', 'matlab');
      if (existsSync(macBin)) {
        return path.resolve(macBin);
      }
    }
  }

  // 4. Linux (/usr/local/MATLAB/R20*/bin/matlab)
  const linuxMatlab = '/usr/local/MATLAB';
  if (existsSync(linuxMatlab)) {
    const entries = readdirSync(linuxMatlab);
    const releaseDirs = sortMatlabReleaseFolders(entries.filter(e => /^R20/i.test(e)));
    for (const rel of releaseDirs) {
      const linBin = path.join(linuxMatlab, rel, 'bin', 'matlab');
      if (existsSync(linBin)) {
        return path.resolve(linBin);
      }
    }
  }

  // 5. PATH
  const pathEnv = env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  const exeNames = (process.platform === 'win32' || env.OS === 'Windows_NT')
    ? ['matlab.exe', 'matlab']
    : ['matlab'];

  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const full = path.join(dir, exe);
      if (existsSync(full)) {
        return path.resolve(full);
      }
    }
  }

  return undefined;
}
