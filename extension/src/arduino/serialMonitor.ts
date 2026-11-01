// Serial monitor and live plotter communication engine.
// Pure Node module with zero vscode imports.
// Manages bidirectional serial streaming via arduino-cli monitor and port locking.

import * as child_process from 'child_process';
import { EventEmitter } from 'events';

export interface SerialLineData {
  line: string;
  timestamp: number;
  numbers?: number[];
}

export interface SerialColumnSummary {
  index: number;
  count: number;
  min: number;
  max: number;
  mean: number;
  recent: number[];
}

export interface CompactSerialSummary {
  port: string;
  baud: number;
  durationSeconds: number;
  totalLines: number;
  sampleLines: string[];
  columns: SerialColumnSummary[];
}

/**
 * Checks whether a text line contains numeric column data for plotting (e.g. "1.23, -4.56, 7.89").
 */
export function parseSerialDataLine(line: string): number[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Split by comma, tab, or spaces
  const tokens = trimmed.split(/[,\t\s]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const numbers: number[] = [];
  for (const t of tokens) {
    const num = Number(t);
    if (!isNaN(num) && isFinite(num)) {
      numbers.push(num);
    } else {
      return null; // non-numeric token found, not a pure numeric series
    }
  }

  return numbers.length > 0 ? numbers : null;
}

/**
 * An active serial monitor session connected to a serial port via arduino-cli.
 */
export class SerialMonitorSession extends EventEmitter {
  private child?: child_process.ChildProcess;
  private port: string;
  private baud: number;
  private cliPath: string;
  private active = false;

  constructor(cliPath: string, port: string, baud: number = 115200) {
    super();
    this.cliPath = cliPath;
    this.port = port;
    this.baud = baud;
  }

  public getPort(): string {
    return this.port;
  }

  public getBaud(): number {
    return this.baud;
  }

  public isRunning(): boolean {
    return this.active;
  }

  public async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    const args = ['monitor', '-p', this.port, '--config', `baudrate=${this.baud}`, '-q'];
    const child = child_process.spawn(this.cliPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    let buffer = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || ''; // Keep partial line in buffer

      for (const line of lines) {
        const numbers = parseSerialDataLine(line) || undefined;
        const data: SerialLineData = {
          line,
          timestamp: Date.now(),
          numbers,
        };
        this.emit('data', data);
      }
    });

    child.stderr.on('data', (chunk) => {
      const errText = chunk.toString('utf8');
      this.emit('error', new Error(errText));
    });

    child.on('close', (code) => {
      this.active = false;
      this.emit('close', code);
    });

    child.on('error', (err) => {
      this.active = false;
      this.emit('error', err);
    });
  }

  public write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin || !this.active) {
        reject(new Error(`Serial monitor not connected to ${this.port}`));
        return;
      }
      this.child.stdin.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child || !this.active) {
        this.active = false;
        resolve();
        return;
      }
      this.active = false;
      const pid = this.child.pid;

      try {
        if (process.platform === 'win32' && pid) {
          child_process.execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } else {
          this.child.kill('SIGKILL');
        }
      } catch {}

      resolve();
    });
  }
}

/**
 * Global coordinator that tracks active serial sessions and automatically
 * releases the port before an upload and reconnects afterwards.
 */
export class SerialPortCoordinator {
  private static instance = new SerialPortCoordinator();
  private activeSessions = new Map<string, SerialMonitorSession>();

  public static getInstance(): SerialPortCoordinator {
    return this.instance;
  }

  public register(session: SerialMonitorSession): void {
    const key = session.getPort().toUpperCase();
    this.activeSessions.set(key, session);
  }

  public unregister(port: string): void {
    const key = port.toUpperCase();
    this.activeSessions.delete(key);
  }

  public get(port: string): SerialMonitorSession | undefined {
    return this.activeSessions.get(port.toUpperCase());
  }

  /**
   * Executes a task (e.g. firmware upload) that requires exclusive access to the serial port.
   * If a serial monitor is open on this port, it temporarily pauses/closes it,
   * awaits the action, and then automatically restarts the monitor session!
   */
  public async withPortReleased<T>(
    port: string,
    action: () => Promise<T>
  ): Promise<T> {
    const key = port.toUpperCase();
    const session = this.activeSessions.get(key);
    const wasRunning = session && session.isRunning();

    if (session && wasRunning) {
      await session.stop();
      // Brief pause for OS to release USB serial handle
      await new Promise((r) => setTimeout(r, 400));
    }

    try {
      return await action();
    } finally {
      if (session && wasRunning) {
        // Allow board to reset and enumerate after upload before reconnecting
        await new Promise((r) => setTimeout(r, 600));
        try {
          await session.start();
        } catch {}
      }
    }
  }
}

/**
 * Collects serial data for a specified duration (in seconds) and returns a compact summary.
 */
export async function readSerialSummary(
  cliPath: string,
  port: string,
  baud: number = 115200,
  seconds: number = 2,
  options?: { signal?: AbortSignal }
): Promise<CompactSerialSummary> {
  const session = new SerialMonitorSession(cliPath, port, baud);
  const lines: string[] = [];
  const colSeries: number[][] = [];

  const onData = (d: SerialLineData) => {
    lines.push(d.line);
    if (d.numbers && d.numbers.length > 0) {
      for (let i = 0; i < d.numbers.length; i++) {
        if (!colSeries[i]) colSeries[i] = [];
        colSeries[i].push(d.numbers[i]);
      }
    }
  };

  session.on('data', onData);
  await session.start();

  const durationMs = Math.max(100, seconds * 1000);
  const startTime = Date.now();

  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, durationMs);
      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true }
        );
      }
    });
  } finally {
    await session.stop();
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  const columns: SerialColumnSummary[] = colSeries.map((series, idx) => {
    const min = series.length > 0 ? Math.min(...series) : 0;
    const max = series.length > 0 ? Math.max(...series) : 0;
    const sum = series.reduce((a, b) => a + b, 0);
    const mean = series.length > 0 ? Number((sum / series.length).toFixed(3)) : 0;
    const recent = series.slice(-10);

    return {
      index: idx,
      count: series.length,
      min: Number(min.toFixed(3)),
      max: Number(max.toFixed(3)),
      mean,
      recent,
    };
  });

  return {
    port,
    baud,
    durationSeconds: Number(elapsedSec.toFixed(2)),
    totalLines: lines.length,
    sampleLines: lines.slice(0, 5),
    columns,
  };
}
