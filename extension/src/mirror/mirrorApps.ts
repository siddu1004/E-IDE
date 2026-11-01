// Desktop EEE apps that E-IDE can show inside a tab, and how to find, launch and recognise each one.
// Pure Node module, zero vscode imports, testable with node --test.

import * as fs from 'fs';
import * as path from 'path';

export interface MirrorApp {
  id: string;
  label: string;
  /** Process names (without .exe) whose windows belong to the app, compared case-insensitively. */
  processes: string[];
  /** File extensions this app opens. */
  extensions: string[];
  installUrl: string;
  candidates(env: Record<string, string | undefined>): string[];
}

export interface AppWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
}

// Program Files subfolders are versioned (KiCad\9.0, MATLAB\R2026a); newest first.
function versionedDirs(root: string | undefined, ...rest: string[]): string[] {
  if (!root) return [];
  const base = path.join(root, ...rest);
  try {
    return fs
      .readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(base, v));
  } catch {
    return [];
  }
}

export const MIRROR_APPS: MirrorApp[] = [
  {
    id: 'matlab',
    label: 'MATLAB / Simulink',
    processes: ['MATLAB'],
    extensions: ['.slx', '.mdl', '.m', '.mlx', '.mat'],
    installUrl: 'https://www.mathworks.com/downloads/',
    candidates: (env) => versionedDirs(env.ProgramFiles, 'MATLAB').map((d) => path.join(d, 'bin', 'matlab.exe')),
  },
  {
    id: 'kicad',
    label: 'KiCad',
    processes: ['kicad', 'eeschema', 'pcbnew', 'gerbview', 'pl_editor', 'bitmap2component', 'pcb_calculator'],
    extensions: ['.kicad_pro', '.kicad_sch', '.kicad_pcb'],
    installUrl: 'https://www.kicad.org/download/windows/',
    candidates: (env) => versionedDirs(env.ProgramFiles, 'KiCad').map((d) => path.join(d, 'bin', 'kicad.exe')),
  },
  {
    id: 'ltspice',
    label: 'LTspice',
    processes: ['LTspice', 'XVIIx64', 'XVIIx86'],
    extensions: ['.asc', '.cir', '.net', '.raw'],
    installUrl: 'https://www.analog.com/en/resources/design-tools-and-calculators/ltspice-simulator.html',
    candidates: (env) => [
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'ADI', 'LTspice', 'LTspice.exe') : '',
      env.ProgramFiles ? path.join(env.ProgramFiles, 'ADI', 'LTspice', 'LTspice.exe') : '',
      env.ProgramFiles ? path.join(env.ProgramFiles, 'LTC', 'LTspiceXVII', 'XVIIx64.exe') : '',
    ].filter(Boolean),
  },
  {
    id: 'arduino',
    label: 'Arduino IDE',
    processes: ['Arduino IDE'],
    extensions: ['.ino'],
    installUrl: 'https://www.arduino.cc/en/software',
    candidates: (env) => [
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Arduino IDE', 'Arduino IDE.exe') : '',
      env.ProgramFiles ? path.join(env.ProgramFiles, 'Arduino IDE', 'Arduino IDE.exe') : '',
    ].filter(Boolean),
  },
];

export function getMirrorApp(id: string): MirrorApp | undefined {
  return MIRROR_APPS.find((a) => a.id === id);
}

export function appForFile(filePath: string): MirrorApp | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return MIRROR_APPS.find((a) => a.extensions.includes(ext));
}

export function findAppExecutable(
  app: MirrorApp,
  customPath?: string,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = fs.existsSync
): string | undefined {
  if (customPath && exists(customPath)) return customPath;
  return app.candidates(env).find((p) => exists(p));
}

/** The processes whose windows make up the app (MATLAB runs Simulink and scopes in more than one). */
export function appPids(app: MirrorApp, windows: AppWindow[]): number[] {
  const names = app.processes.map((p) => p.toLowerCase());
  return [...new Set(windows.filter((w) => names.includes(w.process.toLowerCase())).map((w) => w.pid))];
}

/** Command-line arguments that open a file in the app. */
export function launchArgs(app: MirrorApp, filePath?: string): string[] {
  if (!filePath) return app.id === 'matlab' ? ['-desktop'] : [];
  if (app.id === 'matlab') return ['-desktop', '-r', `open('${filePath.replace(/'/g, "''")}')`];
  return [filePath];
}
