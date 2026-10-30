// KiCad CLI integration module for ERC and SPICE netlist export.
// Pure Node module (child_process, fs, os, path), zero vscode imports.
// Testable with node --test.

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ErcItem {
  description: string;
  pos?: { x: number; y: number };
  uuid?: string;
}

export interface ErcViolation {
  type: string;
  severity: 'error' | 'warning' | 'exclusion';
  description: string;
  items: ErcItem[];
}

export interface KicadErcReport {
  kicadVersion: string;
  date: string;
  coordinateUnits: string;
  violations: ErcViolation[];
  errorCount: number;
  warningCount: number;
}

export interface ErcRunResult {
  success: boolean;
  exitCode: number | null;
  report: KicadErcReport;
  rawJson?: string;
  error?: string;
}

export interface NetlistExportResult {
  success: boolean;
  exitCode: number | null;
  netlist?: string;
  error?: string;
}

export function getCandidateKicadCliPaths(env: Record<string, string | undefined> = process.env): string[] {
  const candidates: string[] = [];
  const programFiles = env.ProgramFiles !== undefined ? env.ProgramFiles : 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] !== undefined ? env['ProgramFiles(x86)'] : 'C:\\Program Files (x86)';

  // Versions newest to oldest
  const versions = ['10.0', '9.0', '8.0', '7.0'];
  if (programFiles) {
    for (const v of versions) {
      candidates.push(path.join(programFiles, 'KiCad', v, 'bin', 'kicad-cli.exe'));
    }
    candidates.push(path.join(programFiles, 'KiCad', 'bin', 'kicad-cli.exe'));
  }

  if (programFilesX86) {
    for (const v of versions) {
      candidates.push(path.join(programFilesX86, 'KiCad', v, 'bin', 'kicad-cli.exe'));
    }
  }

  // macOS
  candidates.push('/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli');

  return candidates;
}

export function findKicadCli(customPath?: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (fs.existsSync(trimmed)) return path.resolve(trimmed);
  }

  const candidates = getCandidateKicadCliPaths(env);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return path.resolve(c);
    }
  }

  // Check PATH
  const pathEnv = env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  const exeNames = process.platform === 'win32' ? ['kicad-cli.exe', 'kicad-cli'] : ['kicad-cli'];
  for (const dir of pathDirs) {
    for (const exe of exeNames) {
      const full = path.join(dir, exe);
      if (fs.existsSync(full)) {
        return path.resolve(full);
      }
    }
  }

  return undefined;
}

export function parseErcReport(jsonString: string): KicadErcReport {
  try {
    const data = JSON.parse(jsonString);
    const violations: ErcViolation[] = [];
    let errorCount = 0;
    let warningCount = 0;

    const sheets = Array.isArray(data.sheets) ? data.sheets : [data];
    for (const sheet of sheets) {
      const vList = Array.isArray(sheet.violations) ? sheet.violations : [];
      for (const v of vList) {
        const severity = v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warning' : 'exclusion';
        if (severity === 'error') errorCount++;
        else if (severity === 'warning') warningCount++;

        const items: ErcItem[] = Array.isArray(v.items)
          ? v.items.map((it: any) => ({
              description: it.description || '',
              pos: it.pos ? { x: it.pos.x, y: it.pos.y } : undefined,
              uuid: it.uuid,
            }))
          : [];

        violations.push({
          type: v.type || '',
          severity,
          description: v.description || '',
          items,
        });
      }
    }

    return {
      kicadVersion: data.kicad_version || '',
      date: data.date || '',
      coordinateUnits: data.coordinate_units || 'mm',
      violations,
      errorCount,
      warningCount,
    };
  } catch (err: any) {
    return {
      kicadVersion: '',
      date: '',
      coordinateUnits: 'mm',
      violations: [],
      errorCount: 0,
      warningCount: 0,
    };
  }
}

export async function runErc(options: {
  cliPath: string;
  schPath: string;
  timeoutMs?: number;
}): Promise<ErcRunResult> {
  if (!fs.existsSync(options.cliPath)) {
    return {
      success: false,
      exitCode: null,
      report: { kicadVersion: '', date: '', coordinateUnits: 'mm', violations: [], errorCount: 0, warningCount: 0 },
      error: `kicad-cli not found: ${options.cliPath}`,
    };
  }

  const tempOut = path.join(os.tmpdir(), `kicad-erc-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const timeout = options.timeoutMs ?? 30000;

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = child_process.spawn(
        options.cliPath,
        ['sch', 'erc', '--format', 'json', '-o', tempOut, options.schPath],
        { stdio: 'ignore', windowsHide: true },
      );

      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve(null);
      }, timeout);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (!fs.existsSync(tempOut)) {
      return {
        success: false,
        exitCode,
        report: { kicadVersion: '', date: '', coordinateUnits: 'mm', violations: [], errorCount: 0, warningCount: 0 },
        error: 'kicad-cli sch erc did not generate report output',
      };
    }

    const rawJson = fs.readFileSync(tempOut, 'utf8');
    try { fs.unlinkSync(tempOut); } catch {}

    const report = parseErcReport(rawJson);
    return {
      success: true,
      exitCode,
      report,
      rawJson,
    };
  } catch (err: any) {
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
    return {
      success: false,
      exitCode: null,
      report: { kicadVersion: '', date: '', coordinateUnits: 'mm', violations: [], errorCount: 0, warningCount: 0 },
      error: err.message,
    };
  }
}

export async function exportSpiceNetlist(options: {
  cliPath: string;
  schPath: string;
  timeoutMs?: number;
}): Promise<NetlistExportResult> {
  if (!fs.existsSync(options.cliPath)) {
    return {
      success: false,
      exitCode: null,
      error: `kicad-cli not found: ${options.cliPath}`,
    };
  }

  const tempOut = path.join(os.tmpdir(), `kicad-net-${Date.now()}-${Math.random().toString(36).slice(2)}.cir`);
  const timeout = options.timeoutMs ?? 30000;

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = child_process.spawn(
        options.cliPath,
        ['sch', 'export', 'netlist', '--format', 'spice', '-o', tempOut, options.schPath],
        { stdio: 'ignore', windowsHide: true },
      );

      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve(null);
      }, timeout);

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (!fs.existsSync(tempOut)) {
      return {
        success: false,
        exitCode,
        error: 'kicad-cli sch export netlist did not produce output file',
      };
    }

    const netlist = fs.readFileSync(tempOut, 'utf8');
    try { fs.unlinkSync(tempOut); } catch {}

    return {
      success: exitCode === 0,
      exitCode,
      netlist,
    };
  } catch (err: any) {
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
    return {
      success: false,
      exitCode: null,
      error: err.message,
    };
  }
}
