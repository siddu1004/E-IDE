// MATLAB persistent bridge client and protocol handler.
// Pure Node module (net, child_process, crypto, path), zero vscode imports.
// Testable with node --test using mock TCP servers.

import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';

export type BridgeStatus = 'off' | 'starting' | 'ready' | 'busy';

export interface BridgeErrorPayload {
  identifier: string;
  message: string;
}

export interface BridgeResponse<T = unknown> {
  status: 'ok' | 'error';
  result?: T;
  error?: BridgeErrorPayload;
}

export interface ScriptRunResult {
  output: string;
  figures: string[];
}

export interface SimulinkBlockInfo {
  name: string;
  type: string;
  position: [number, number, number, number];
  ports: number[];
}

export interface SimulinkLineInfo {
  srcBlock: string;
  srcPort: number;
  dstBlock: string;
  dstPort: number;
}

export interface SimulinkModelGraph {
  model: string;
  blocks: SimulinkBlockInfo[];
  lines: SimulinkLineInfo[];
}

export interface SimulatedSignal {
  name: string;
  time: number[];
  values: number[];
}

export interface SimulateResult {
  model: string;
  signals: SimulatedSignal[];
}

export interface MatlabBridgeOptions {
  matlabPath?: string;
  bridgeScriptDir?: string;
  port?: number;
  token?: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export class MatlabBridge {
  private status: BridgeStatus = 'off';
  private matlabProcess?: child_process.ChildProcess;
  private socket?: net.Socket;
  private port = 0;
  private token = '';
  private matlabPath?: string;
  private bridgeScriptDir: string;
  private connectTimeoutMs: number;
  private commandTimeoutMs: number;
  private statusListeners: Array<(status: BridgeStatus) => void> = [];

  private receiveBuffer = '';
  private pendingQueue: Array<{
    cmd: string;
    args: Record<string, unknown>;
    resolve: (res: any) => void;
    reject: (err: Error) => void;
  }> = [];
  private activeRequest?: {
    cmd: string;
    args: Record<string, unknown>;
    resolve: (res: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };

  constructor(options?: MatlabBridgeOptions) {
    this.matlabPath = options?.matlabPath;
    this.bridgeScriptDir = options?.bridgeScriptDir || path.resolve(__dirname, '../../../matlab');
    if (options?.port) this.port = options.port;
    if (options?.token) this.token = options.token;
    this.connectTimeoutMs = options?.connectTimeoutMs || 35000;
    this.commandTimeoutMs = options?.commandTimeoutMs || 120000;
  }

  public getStatus(): BridgeStatus {
    return this.status;
  }

  public onStatusChange(listener: (status: BridgeStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener);
    };
  }

  private setStatus(newStatus: BridgeStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      for (const listener of this.statusListeners) {
        try {
          listener(newStatus);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  /**
   * Connects to an already-listening TCP bridge server (e.g. for testing).
   */
  public async connectDirect(port: number, token: string): Promise<void> {
    this.port = port;
    this.token = token;
    this.setStatus('starting');

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        this.socket = socket;
        this.setStatus('ready');
        this.setupSocketEvents(socket);
        resolve();
      });

      socket.once('error', (err) => {
        this.setStatus('off');
        reject(err);
      });
    });
  }

  /**
   * Spawns MATLAB with eide_bridge.m and connects to it.
   */
  public async start(): Promise<void> {
    if (this.status === 'ready' || this.status === 'busy') {
      return;
    }

    if (!this.matlabPath) {
      throw new Error('MATLAB executable path not specified');
    }

    this.setStatus('starting');

    // 1. Pick a random free port on 127.0.0.1
    this.port = await this.findFreePort();
    this.token = crypto.randomBytes(16).toString('hex');

    // 2. Prepare launch command
    // Normalize path with forward slashes for MATLAB string
    const normalizedScriptDir = this.bridgeScriptDir.replace(/\\/g, '/');
    const batchCmd = `addpath('${normalizedScriptDir}'); eide_bridge(${this.port}, '${this.token}');`;

    const proc = child_process.spawn(
      this.matlabPath,
      ['-batch', batchCmd],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    this.matlabProcess = proc;

    proc.on('exit', (code, signal) => {
      this.cleanup();
      this.setStatus('off');
    });

    proc.on('error', (err) => {
      this.cleanup();
      this.setStatus('off');
    });

    // 3. Poll connect until bridge responds or timeout
    const startTime = Date.now();
    let connected = false;

    while (Date.now() - startTime < this.connectTimeoutMs) {
      try {
        await this.tryConnect(this.port);
        connected = true;
        break;
      } catch {
        // Sleep 500ms before retry
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!connected) {
      this.stop();
      throw new Error(`Timed out waiting for MATLAB bridge on port ${this.port}`);
    }

    // Ping to verify authentication
    try {
      await this.ping();
      this.setStatus('ready');
    } catch (err: any) {
      this.stop();
      throw new Error(`Failed to verify MATLAB bridge authentication: ${err.message}`);
    }
  }

  private tryConnect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        this.socket = socket;
        this.setupSocketEvents(socket);
        resolve();
      });

      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  private setupSocketEvents(socket: net.Socket) {
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      this.receiveBuffer += chunk;
      const lines = this.receiveBuffer.split('\n');
      this.receiveBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleResponseLine(trimmed);
      }
    });

    socket.on('close', () => {
      this.cleanup();
      this.setStatus('off');
    });

    socket.on('error', () => {
      this.cleanup();
      this.setStatus('off');
    });
  }

  private handleResponseLine(line: string) {
    if (!this.activeRequest) return;

    const req = this.activeRequest;
    this.activeRequest = undefined;
    clearTimeout(req.timer);

    try {
      const resp = JSON.parse(line) as BridgeResponse;
      if (resp.status === 'ok') {
        req.resolve(resp.result);
      } else {
        const errId = resp.error?.identifier || 'MATLAB:Error';
        const errMsg = resp.error?.message || 'MATLAB bridge command failed';
        const err = new Error(`[${errId}] ${errMsg}`);
        (err as any).identifier = errId;
        req.reject(err);
      }
    } catch (parseErr: any) {
      req.reject(new Error(`Failed to parse bridge JSON response: ${parseErr.message} (raw: ${line})`));
    } finally {
      this.processQueue();
    }
  }

  public async sendCommand<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.status === 'off') {
      throw new Error('MATLAB bridge is offline');
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingQueue.push({ cmd, args, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue() {
    if (this.activeRequest || this.pendingQueue.length === 0) {
      if (!this.activeRequest && this.status === 'busy') {
        this.setStatus('ready');
      }
      return;
    }

    if (!this.socket || this.socket.destroyed) {
      const next = this.pendingQueue.shift();
      next?.reject(new Error('MATLAB bridge socket disconnected'));
      return;
    }

    const next = this.pendingQueue.shift()!;
    this.setStatus('busy');

    const timer = setTimeout(() => {
      if (this.activeRequest === reqObj) {
        this.activeRequest = undefined;
        reqObj.reject(new Error(`Command '${next.cmd}' timed out after ${this.commandTimeoutMs}ms`));
        this.processQueue();
      }
    }, this.commandTimeoutMs);

    const reqObj = {
      ...next,
      timer,
    };
    this.activeRequest = reqObj;

    const payload = JSON.stringify({
      token: this.token,
      cmd: next.cmd,
      args: next.args,
    }) + '\n';

    this.socket.write(payload);
  }

  // --- Strongly typed bridge commands ---

  public async ping(): Promise<string> {
    return this.sendCommand<string>('ping');
  }

  public async runScript(scriptPath: string, exportDir?: string): Promise<ScriptRunResult> {
    return this.sendCommand<ScriptRunResult>('runScript', {
      path: scriptPath,
      exportDir,
    });
  }

  public async evalFigureExport(exportDir?: string): Promise<string[]> {
    const res = await this.sendCommand<{ figures: string[] }>('evalFigureExport', { exportDir });
    return res.figures || [];
  }

  public async loadModel(modelPath: string): Promise<{ model: string; loaded: boolean }> {
    return this.sendCommand('loadModel', { path: modelPath });
  }

  public async getModelGraph(modelPath: string): Promise<SimulinkModelGraph> {
    return this.sendCommand<SimulinkModelGraph>('getModelGraph', { path: modelPath });
  }

  public async setParam(
    modelPath: string,
    block: string,
    param: string,
    value: string | number
  ): Promise<{ saved: boolean }> {
    return this.sendCommand('setParam', { path: modelPath, block, param, value });
  }

  public async addLine(modelPath: string, src: string, dst: string): Promise<{ lineHandle: number }> {
    return this.sendCommand('addLine', { path: modelPath, src, dst });
  }

  public async deleteLine(modelPath: string, src: string, dst: string): Promise<{ deleted: boolean }> {
    return this.sendCommand('deleteLine', { path: modelPath, src, dst });
  }

  public async simulate(modelPath: string, stopTime?: number | string): Promise<SimulateResult> {
    return this.sendCommand<SimulateResult>('simulate', { path: modelPath, stopTime });
  }

  public async closeModel(modelPath: string): Promise<{ closed: boolean }> {
    return this.sendCommand('closeModel', { path: modelPath });
  }

  /**
   * Fallback execution using single `matlab -batch` run if bridge is offline.
   */
  public async runBatchFallback(scriptOrCommand: string): Promise<string> {
    if (!this.matlabPath) {
      throw new Error('MATLAB executable not found');
    }
    return new Promise((resolve, reject) => {
      child_process.execFile(
        this.matlabPath!,
        ['-batch', scriptOrCommand],
        { timeout: 60000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`MATLAB batch run failed: ${error.message}\n${stderr}`));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  public async stop(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.sendCommand('exit').catch(() => {});
      } catch {
        // ignore
      }
      this.socket.destroy();
      this.socket = undefined;
    }

    if (this.matlabProcess) {
      try {
        this.matlabProcess.kill();
      } catch {
        // ignore
      }
      this.matlabProcess = undefined;
    }

    this.cleanup();
    this.setStatus('off');
  }

  private cleanup() {
    if (this.activeRequest) {
      clearTimeout(this.activeRequest.timer);
      this.activeRequest.reject(new Error('MATLAB bridge stopped'));
      this.activeRequest = undefined;
    }

    while (this.pendingQueue.length > 0) {
      const item = this.pendingQueue.shift();
      item?.reject(new Error('MATLAB bridge stopped'));
    }

    this.receiveBuffer = '';
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() => reject(new Error('Failed to obtain free port')));
        }
      });
      srv.on('error', reject);
    });
  }
}
