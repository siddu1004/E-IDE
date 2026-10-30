// LTspice simulation runner and log parser.
// Pure Node module (fs, path, os, child_process), zero vscode imports.
// Testable with node --test.

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRaw, RawPlot } from './rawParser';

export interface LtspiceLogResult {
  errors: string[];
  warnings: string[];
  measurements: Record<string, number>;
  elapsedSeconds?: number;
  rawLog: string;
}

export interface SimulationRunResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  log: LtspiceLogResult;
  raw?: RawPlot;
  error?: string;
  activeDirective?: string;
}

export interface RunOptions {
  executablePath: string;
  ascPath?: string;
  ascContent?: string;
  cirPath?: string;
  cirContent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Known standard installation paths for LTspice on Windows and other OSes
export function getCandidateLtspicePaths(env: Record<string, string | undefined> = process.env): string[] {
  const candidates: string[] = [];
  const localAppData = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'ADI', 'LTspice', 'LTspice.exe'));
  }
  candidates.push(path.join(programFiles, 'ADI', 'LTspice', 'LTspice.exe'));
  candidates.push(path.join(programFiles, 'LTC', 'LTspiceXVII', 'XVIIx64.exe'));
  candidates.push(path.join(programFilesX86, 'LTC', 'LTspiceIV', 'scad3.exe'));

  // Common fallbacks
  candidates.push('C:\\Program Files\\ADI\\LTspice\\LTspice.exe');
  candidates.push('C:\\Program Files\\LTC\\LTspiceXVII\\XVIIx64.exe');
  candidates.push('C:\\Program Files (x86)\\LTC\\LTspiceIV\\scad3.exe');

  // macOS
  candidates.push('/Applications/LTspice.app/Contents/MacOS/LTspice');

  return candidates;
}

export function findLtspice(customPath?: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (customPath && customPath.trim()) {
    const trimmed = customPath.trim();
    if (fs.existsSync(trimmed)) return path.resolve(trimmed);
  }

  const candidates = getCandidateLtspicePaths(env);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return path.resolve(c);
    }
  }

  // Check PATH if possible
  const pathEnv = env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  const exeNames = process.platform === 'win32' ? ['LTspice.exe', 'XVIIx64.exe', 'scad3.exe'] : ['LTspice', 'ltspice'];
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

// LTspice 24+ writes UTF-8 logs; LTspice XVII writes UTF-16LE, with or without a BOM.
export function decodeLog(buf: Buffer): string {
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 1 && buf[1] === 0 && buf[0] !== 0);
  return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
}

// Parses LTspice log text for errors, warnings, measurements, and elapsed time
export function parseLtspiceLog(logContent: string): LtspiceLogResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const measurements: Record<string, number> = {};
  let elapsedSeconds: number | undefined;

  const lines = logContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check for errors
    if (/^fatal error:/i.test(line) || /^error:/i.test(line) || /expected device instantiation/i.test(line) || /singular matrix/i.test(line)) {
      errors.push(line);
    }

    // Check for warnings
    if (/^warning:/i.test(line)) {
      warnings.push(line);
    }

    // Check for elapsed time: "Total elapsed time: 0.016 seconds."
    const timeMatch = line.match(/total elapsed time:\s*([0-9.]+)\s*seconds/i);
    if (timeMatch) {
      elapsedSeconds = parseFloat(timeMatch[1]);
    }

    // Check for measurements:
    // Format 1: "v_max: MAX(V(out))=0.862189471722 FROM 0 TO 0.005"
    // Format 2: "v_p2p: PP(V(out))=1.70890343189 FROM 0 TO 0.005"
    // Format 3: "meas_name = 1.2345"
    const measMatch1 = line.match(/^([a-zA-Z0-9_]+):\s+.*?=\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/i);
    if (measMatch1) {
      measurements[measMatch1[1]] = parseFloat(measMatch1[2]);
      continue;
    }

    const measMatch2 = line.match(/^([a-zA-Z0-9_]+)\s*=\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/i);
    if (measMatch2 && !line.toLowerCase().startsWith('solver') && !line.toLowerCase().startsWith('temp') && !line.toLowerCase().startsWith('tnom')) {
      measurements[measMatch2[1]] = parseFloat(measMatch2[2]);
    }
  }

  return {
    errors,
    warnings,
    measurements,
    elapsedSeconds,
    rawLog: logContent,
  };
}

// Prepares an ASC file for non-interactive batch simulation.
// In LTspice, having multiple active simulation directives (.tran, .ac, .dc, .op) causes
// a GUI modal popup to select which analysis to run, which hangs batch mode indefinitely.
// This function keeps the first active simulation directive and comments out subsequent ones.
export function prepareSimulationAsc(ascSource: string): { content: string; activeDirective?: string } {
  const lines = ascSource.split(/\r?\n/);
  const simCmdRegex = /^TEXT\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\d+)\s+!(\.(tran|ac|dc|op|noise|tf))\b/i;

  let activeFound = false;
  let activeDirective: string | undefined;

  const modifiedLines = lines.map((line) => {
    const match = line.match(simCmdRegex);
    if (match) {
      if (!activeFound) {
        activeFound = true;
        activeDirective = match[5];
        return line;
      } else {
        // Comment out extra active simulation commands: replace '!' with ';'
        return line.replace(/^TEXT\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(\d+)\s+!/, 'TEXT $1 $2 $3 $4 ;');
      }
    }
    return line;
  });

  return {
    content: modifiedLines.join(ascSource.includes('\r\n') ? '\r\n' : '\n'),
    activeDirective,
  };
}

// Runs an LTspice simulation in batch mode on a temporary copy with a timeout and cancellation
export async function runLtspiceSimulation(options: RunOptions): Promise<SimulationRunResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 60000;

  if (!fs.existsSync(options.executablePath)) {
    return {
      success: false,
      exitCode: null,
      durationMs: 0,
      log: { errors: [`Executable not found: ${options.executablePath}`], warnings: [], measurements: {}, rawLog: '' },
      error: `Executable not found: ${options.executablePath}`,
    };
  }

  // Determine mode: netlist (.cir) vs schematic (.asc)
  const isCir = options.cirContent !== undefined || (options.cirPath !== undefined && options.ascPath === undefined && options.ascContent === undefined);

  let runFileName = 'circuit.asc';
  let preparedContent = '';
  let activeDirective: string | undefined;

  if (isCir) {
    runFileName = 'circuit.cir';
    let rawCir = options.cirContent;
    if (rawCir === undefined && options.cirPath) {
      rawCir = fs.readFileSync(options.cirPath, 'utf8');
    }
    if (rawCir === undefined) {
      throw new Error('Either cirContent or cirPath must be provided');
    }

    // De-duplicate active simulation commands in netlist (.tran, .ac, etc.)
    const cirLines = rawCir.split(/\r?\n/);
    let simFound = false;
    const modifiedLines = cirLines.map((line) => {
      const match = line.trim().match(/^\.((tran|ac|dc|op|noise|tf))\b/i);
      if (match) {
        if (!simFound) {
          simFound = true;
          activeDirective = '.' + match[1];
          return line;
        } else {
          return ';' + line;
        }
      }
      return line;
    });
    preparedContent = modifiedLines.join(rawCir.includes('\r\n') ? '\r\n' : '\n');
  } else {
    let sourceContent = options.ascContent;
    if (sourceContent === undefined && options.ascPath) {
      sourceContent = fs.readFileSync(options.ascPath, 'utf8');
    }
    if (sourceContent === undefined) {
      throw new Error('Either ascContent, ascPath, cirContent, or cirPath must be provided');
    }
    const prep = prepareSimulationAsc(sourceContent);
    preparedContent = prep.content;
    activeDirective = prep.activeDirective;
  }

  if (options.signal?.aborted) {
    return {
      success: false,
      exitCode: null,
      durationMs: 0,
      log: { errors: ['Simulation cancelled by user'], warnings: [], measurements: {}, rawLog: '' },
      error: 'Simulation cancelled',
      activeDirective,
    };
  }

  // Create isolated temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eide-sim-'));
  const tempInput = path.join(tempDir, runFileName);
  const tempLog = path.join(tempDir, 'circuit.log');
  const tempRaw = path.join(tempDir, 'circuit.raw');

  fs.writeFileSync(tempInput, preparedContent, 'utf8');

  let processHandle: child_process.ChildProcess | undefined;
  let timedOut = false;
  let aborted = false;

  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  };

  const killProcess = (pid?: number) => {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        child_process.execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch {
        // Already dead
      }
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }
  };

  try {
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = child_process.spawn(options.executablePath, ['-b', tempInput], {
        cwd: tempDir,
        stdio: 'ignore',
        windowsHide: true,
      });
      processHandle = child;

      const timer = setTimeout(() => {
        timedOut = true;
        killProcess(child.pid);
        resolve(null);
      }, timeoutMs);

      const abortHandler = () => {
        aborted = true;
        killProcess(child.pid);
        resolve(null);
      };

      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        resolve(code);
      });

      child.on('error', () => {
        clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        resolve(null);
      });
    });

    const durationMs = Date.now() - startTime;

    if (timedOut) {
      cleanup();
      return {
        success: false,
        exitCode: null,
        durationMs,
        log: { errors: [`Simulation timed out after ${timeoutMs / 1000}s`], warnings: [], measurements: {}, rawLog: '' },
        error: `Simulation timed out after ${timeoutMs / 1000}s`,
        activeDirective,
      };
    }

    if (aborted) {
      cleanup();
      return {
        success: false,
        exitCode: null,
        durationMs,
        log: { errors: ['Simulation cancelled by user'], warnings: [], measurements: {}, rawLog: '' },
        error: 'Simulation cancelled',
        activeDirective,
      };
    }

    // Read log file if present
    let logResult: LtspiceLogResult = { errors: [], warnings: [], measurements: {}, rawLog: '' };
    if (fs.existsSync(tempLog)) {
      logResult = parseLtspiceLog(decodeLog(fs.readFileSync(tempLog)));
    }

    // Read raw file if present
    let rawPlot: RawPlot | undefined;
    if (fs.existsSync(tempRaw)) {
      const rawBuf = fs.readFileSync(tempRaw);
      try {
        rawPlot = parseRaw(rawBuf);
      } catch (err: any) {
        logResult.errors.push(`Failed to parse waveform file: ${err.message}`);
      }
    }

    const hasErrors = logResult.errors.length > 0;
    const success = exitCode === 0 && !hasErrors && (rawPlot !== undefined || Object.keys(logResult.measurements).length > 0);

    cleanup();

    return {
      success,
      exitCode,
      durationMs,
      log: logResult,
      raw: rawPlot,
      error: hasErrors ? logResult.errors.join('; ') : undefined,
      activeDirective,
    };
  } catch (err: any) {
    cleanup();
    return {
      success: false,
      exitCode: null,
      durationMs: Date.now() - startTime,
      log: { errors: [err.message], warnings: [], measurements: {}, rawLog: '' },
      error: err.message,
      activeDirective,
    };
  }
}
