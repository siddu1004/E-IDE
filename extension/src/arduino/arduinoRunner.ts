// Process runner for arduino-cli operations (board listing, compilation, upload).
// Pure Node module with zero vscode imports.
// All asynchronous runs follow the controller pattern (AbortSignal).

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ArduinoDiagnostic, parseArduinoDiagnostics } from './arduinoDiagnostics';

export interface ConnectedBoardPort {
  address: string;
  label: string;
  protocol: string;
  boards?: Array<{ name: string; fqbn: string }>;
}

export interface BoardInfo {
  name: string;
  fqbn: string;
}

export interface CompileResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  binarySize?: number;
  maxBinarySize?: number;
  dataSize?: number;
  maxDataSize?: number;
  diagnostics: ArduinoDiagnostic[];
  rawOutput: string;
  error?: string;
}

export interface UploadResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  rawOutput: string;
  error?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  timeoutMs?: number;
}

/**
 * Spawns arduino-cli process, tracks AbortSignal, and buffers stdout/stderr.
 */
function spawnCli(
  cliPath: string,
  args: string[],
  options?: RunOptions
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    if (options?.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }

    const child = child_process.spawn(cliPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let timer: NodeJS.Timeout | undefined;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === 'win32') {
            child_process.execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
          } else {
            child.kill('SIGKILL');
          }
        } catch {}
      }, options.timeoutMs);
    }

    const abortHandler = () => {
      aborted = true;
      try {
        if (process.platform === 'win32') {
          child_process.execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
    };

    if (options?.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (options?.onStdout) options.onStdout(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (options?.onStderr) options.onStderr(text);
    });

    child.on('close', (exitCode) => {
      if (timer) clearTimeout(timer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      resolve({ exitCode, stdout, stderr, timedOut, aborted });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      stderr += `Process error: ${err.message}`;
      resolve({ exitCode: null, stdout, stderr, timedOut, aborted });
    });
  });
}

/**
 * Lists connected boards/ports and all installed board types.
 */
export async function listBoards(
  cliPath: string,
  options?: RunOptions
): Promise<{ detected: ConnectedBoardPort[]; allBoards: BoardInfo[] }> {
  // 1. Detected boards on physical ports
  const detectRun = await spawnCli(cliPath, ['board', 'list', '--format', 'json'], options);
  if (options?.signal?.aborted) throw new Error('Operation cancelled');

  const detected: ConnectedBoardPort[] = [];
  if (detectRun.stdout) {
    try {
      const parsed = JSON.parse(detectRun.stdout);
      const portList = parsed.detected_ports || parsed.ports || [];
      for (const p of portList) {
        const portObj = p.port || p;
        const matchingBoards = (p.matching_boards || []).map((b: any) => ({
          name: b.name,
          fqbn: b.fqbn,
        }));
        detected.push({
          address: portObj.address || portObj.label || '',
          label: portObj.label || portObj.address || '',
          protocol: portObj.protocol || 'serial',
          boards: matchingBoards.length > 0 ? matchingBoards : undefined,
        });
      }
    } catch {}
  }

  // 2. All installed boards
  const listallRun = await spawnCli(cliPath, ['board', 'listall', '--format', 'json'], options);
  if (options?.signal?.aborted) throw new Error('Operation cancelled');

  const allBoards: BoardInfo[] = [];
  if (listallRun.stdout) {
    try {
      const parsed = JSON.parse(listallRun.stdout);
      const boards = parsed.boards || [];
      for (const b of boards) {
        if (b.name && b.fqbn) {
          allBoards.push({ name: b.name, fqbn: b.fqbn });
        }
      }
    } catch {}
  }

  return { detected, allBoards };
}

/**
 * Compiles an Arduino sketch using arduino-cli compile.
 */
export async function compileSketch(
  cliPath: string,
  sketchPath: string,
  fqbn: string,
  options?: RunOptions
): Promise<CompileResult> {
  const startTime = Date.now();
  const run = await spawnCli(
    cliPath,
    ['compile', '--fqbn', fqbn, sketchPath, '--format', 'json'],
    { ...options, timeoutMs: options?.timeoutMs || 120000 }
  );

  const durationMs = Date.now() - startTime;
  if (run.aborted) {
    return {
      success: false,
      exitCode: null,
      durationMs,
      diagnostics: [],
      rawOutput: '',
      error: 'Compilation cancelled',
    };
  }

  if (run.timedOut) {
    return {
      success: false,
      exitCode: null,
      durationMs,
      diagnostics: [],
      rawOutput: run.stdout + run.stderr,
      error: 'Compilation timed out after 120 seconds',
    };
  }

  let binarySize: number | undefined;
  let maxBinarySize: number | undefined;
  let dataSize: number | undefined;
  let maxDataSize: number | undefined;
  let diagnostics: ArduinoDiagnostic[] = [];
  let isSuccess = run.exitCode === 0;

  try {
    const parsed = JSON.parse(run.stdout);
    if (parsed.success !== undefined) isSuccess = parsed.success;

    const sections = parsed.builder_result?.executable_sections_size || [];
    for (const s of sections) {
      if (s.name === 'text') {
        binarySize = s.size;
        maxBinarySize = s.max_size;
      } else if (s.name === 'data') {
        dataSize = s.size;
        maxDataSize = s.max_size;
      }
    }

    const rawDiags = parsed.builder_result?.diagnostics;
    const textOutput = (parsed.compiler_err || '') + '\n' + (parsed.compiler_out || '') + '\n' + run.stderr;
    diagnostics = parseArduinoDiagnostics(textOutput, rawDiags);
  } catch {
    // If stdout is not JSON, parse plain text output
    const combined = run.stdout + '\n' + run.stderr;
    diagnostics = parseArduinoDiagnostics(combined);

    // Extract sizes via regex if present:
    // "Sketch uses 4406 bytes (13%) of program storage space. Maximum is 32256 bytes."
    const progMatch = combined.match(/Sketch uses (\d+) bytes.*Maximum is (\d+) bytes/i);
    if (progMatch) {
      binarySize = parseInt(progMatch[1], 10);
      maxBinarySize = parseInt(progMatch[2], 10);
    }
    // "Global variables use 206 bytes (10%) of dynamic memory, leaving 1842 bytes... Maximum is 2048 bytes."
    const dataMatch = combined.match(/Global variables use (\d+) bytes.*Maximum is (\d+) bytes/i);
    if (dataMatch) {
      dataSize = parseInt(dataMatch[1], 10);
      maxDataSize = parseInt(dataMatch[2], 10);
    }
  }

  return {
    success: isSuccess,
    exitCode: run.exitCode,
    durationMs,
    binarySize,
    maxBinarySize,
    dataSize,
    maxDataSize,
    diagnostics,
    rawOutput: run.stdout + (run.stderr ? '\n' + run.stderr : ''),
    error: isSuccess ? undefined : (run.stderr || 'Compilation failed'),
  };
}

/**
 * Uploads a compiled sketch to an Arduino board.
 */
export async function uploadSketch(
  cliPath: string,
  sketchPath: string,
  fqbn: string,
  port: string,
  options?: RunOptions
): Promise<UploadResult> {
  const startTime = Date.now();
  const run = await spawnCli(
    cliPath,
    ['upload', '-p', port, '--fqbn', fqbn, sketchPath],
    { ...options, timeoutMs: options?.timeoutMs || 120000 }
  );

  const durationMs = Date.now() - startTime;
  if (run.aborted) {
    return {
      success: false,
      exitCode: null,
      durationMs,
      rawOutput: '',
      error: 'Upload cancelled',
    };
  }

  if (run.timedOut) {
    return {
      success: false,
      exitCode: null,
      durationMs,
      rawOutput: run.stdout + run.stderr,
      error: 'Upload timed out after 120 seconds',
    };
  }

  const success = run.exitCode === 0;
  return {
    success,
    exitCode: run.exitCode,
    durationMs,
    rawOutput: run.stdout + (run.stderr ? '\n' + run.stderr : ''),
    error: success ? undefined : (run.stderr || 'Upload failed'),
  };
}
