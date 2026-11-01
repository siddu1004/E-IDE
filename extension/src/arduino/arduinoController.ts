// Arduino Controller for VS Code: manages editor title actions, commands,
// status bars, diagnostics, and the Serial Monitor & Plotter webview panel.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ARDUINO_CLI_INSTALL_URL, findArduinoCli } from './arduinoFinder';
import { ArduinoDiagnostic } from './arduinoDiagnostics';
import {
  BoardInfo,
  ConnectedBoardPort,
  compileSketch,
  listBoards,
  uploadSketch,
} from './arduinoRunner';
import {
  parseSerialDataLine,
  SerialMonitorSession,
  SerialPortCoordinator,
} from './serialMonitor';
import { TestHook } from '../testHook';

export class ArduinoController implements vscode.Disposable {
  private static instance?: ArduinoController;

  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private diagnosticCollection: vscode.DiagnosticCollection;

  // State
  private currentBoard?: BoardInfo;
  private currentPort?: string;
  private currentBaud: number = 115200;

  // Active operations controller
  private activeAbortController?: AbortController;

  // Status bar items
  private boardStatusBar: vscode.StatusBarItem;
  private portStatusBar: vscode.StatusBarItem;
  private verifyStatusBar: vscode.StatusBarItem;
  private uploadStatusBar: vscode.StatusBarItem;
  private serialStatusBar: vscode.StatusBarItem;

  // Serial Monitor webview panel & session
  private serialPanel?: vscode.WebviewPanel;
  private serialSession?: SerialMonitorSession;
  private serialTestHookHandle?: { recordPostMessage: (msg: any) => void; dispose: () => void };

  private disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext) {
    ArduinoController.instance = this;
    this.context = context;

    this.outputChannel = vscode.window.createOutputChannel('E-IDE Arduino');
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('eide-arduino');

    // Create status bar items (aligned to right, priority sorted)
    this.verifyStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 104);
    this.verifyStatusBar.command = 'eide.arduino.verify';
    this.verifyStatusBar.text = '$(check) Verify';
    this.verifyStatusBar.tooltip = 'Verify / Compile Arduino Sketch';

    this.uploadStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 103);
    this.uploadStatusBar.command = 'eide.arduino.upload';
    this.uploadStatusBar.text = '$(arrow-right) Upload';
    this.uploadStatusBar.tooltip = 'Upload Sketch to Board';

    this.boardStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    this.boardStatusBar.command = 'eide.arduino.selectBoard';
    this.boardStatusBar.tooltip = 'Select Arduino Board';

    this.portStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.portStatusBar.command = 'eide.arduino.selectPort';
    this.portStatusBar.tooltip = 'Select Serial Port';

    this.serialStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.serialStatusBar.command = 'eide.arduino.openSerial';
    this.serialStatusBar.text = '$(terminal) Serial Monitor';
    this.serialStatusBar.tooltip = 'Open Serial Monitor & Live Plotter';

    this.disposables.push(
      this.outputChannel,
      this.diagnosticCollection,
      this.verifyStatusBar,
      this.uploadStatusBar,
      this.boardStatusBar,
      this.portStatusBar,
      this.serialStatusBar
    );

    // Initial configuration load
    this.loadConfiguration();
    this.updateStatusBar();

    // Listen to active editor changes to show/hide status bar for .ino files
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.updateStatusBarVisibility(editor);
      })
    );
    this.updateStatusBarVisibility(vscode.window.activeTextEditor);

    // Register commands
    this.registerCommands();
  }

  public static getInstance(): ArduinoController | undefined {
    return this.instance;
  }

  public getCurrentBoard(): BoardInfo | undefined {
    return this.currentBoard;
  }

  public getCurrentPort(): string | undefined {
    return this.currentPort;
  }

  public setBoard(board: BoardInfo): void {
    this.currentBoard = board;
    const config = vscode.workspace.getConfiguration('eide.arduino');
    config.update('selectedBoard', board.fqbn, vscode.ConfigurationTarget.Workspace);
    this.updateStatusBar();
  }

  public setPort(port: string): void {
    this.currentPort = port;
    const config = vscode.workspace.getConfiguration('eide.arduino');
    config.update('selectedPort', port, vscode.ConfigurationTarget.Workspace);
    this.updateStatusBar();
  }

  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration('eide.arduino');
    const savedFqbn = config.get<string>('selectedBoard');
    if (savedFqbn) {
      this.currentBoard = {
        name: savedFqbn,
        fqbn: savedFqbn,
      };
    } else {
      // Default fallback
      this.currentBoard = {
        name: 'Arduino Uno',
        fqbn: 'arduino:avr:uno',
      };
    }

    const savedPort = config.get<string>('selectedPort');
    if (savedPort) {
      this.currentPort = savedPort;
    }
  }

  private updateStatusBarVisibility(editor?: vscode.TextEditor): void {
    const isArduino = editor && editor.document.fileName.endsWith('.ino');
    if (isArduino) {
      this.verifyStatusBar.show();
      this.uploadStatusBar.show();
      this.boardStatusBar.show();
      this.portStatusBar.show();
      this.serialStatusBar.show();
    } else {
      // Keep serial monitor accessible, but hide verify/upload when not viewing .ino
      this.verifyStatusBar.hide();
      this.uploadStatusBar.hide();
      this.boardStatusBar.hide();
      this.portStatusBar.hide();
      this.serialStatusBar.show();
    }
  }

  private updateStatusBar(): void {
    if (this.currentBoard) {
      this.boardStatusBar.text = `$(circuit-board) ${this.currentBoard.name}`;
    } else {
      this.boardStatusBar.text = '$(circuit-board) Select Board';
    }

    if (this.currentPort) {
      this.portStatusBar.text = `$(plug) ${this.currentPort}`;
    } else {
      this.portStatusBar.text = '$(plug) Select Port';
    }
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('eide.arduino.verify', () => this.verifyCommand()),
      vscode.commands.registerCommand('eide.arduino.upload', () => this.uploadCommand()),
      vscode.commands.registerCommand('eide.arduino.selectBoard', () => this.selectBoardCommand()),
      vscode.commands.registerCommand('eide.arduino.selectPort', () => this.selectPortCommand()),
      vscode.commands.registerCommand('eide.arduino.openSerial', () => this.openSerialCommand()),
      vscode.commands.registerCommand('eide.arduino.installCli', () => {
        vscode.env.openExternal(vscode.Uri.parse(ARDUINO_CLI_INSTALL_URL));
      })
    );
  }

  /**
   * Prompts user if arduino-cli is missing and offers to open the official install docs.
   */
  private async getOrPromptCli(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('eide.arduino');
    const customPath = config.get<string>('cliPath');
    const cliPath = findArduinoCli(customPath);

    if (!cliPath) {
      const choice = await vscode.window.showWarningMessage(
        'arduino-cli was not found. Please install arduino-cli to compile and upload Arduino sketches.',
        'Install arduino-cli',
        'Configure Path'
      );
      if (choice === 'Install arduino-cli') {
        vscode.env.openExternal(vscode.Uri.parse(ARDUINO_CLI_INSTALL_URL));
      } else if (choice === 'Configure Path') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'eide.arduino.cliPath');
      }
      return undefined;
    }
    return cliPath;
  }

  /**
   * Finds the active or target .ino sketch file path.
   */
  private getActiveSketchPath(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.fileName.endsWith('.ino')) {
      return activeEditor.document.fileName;
    }

    // Check open documents
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.fileName.endsWith('.ino')) {
        return doc.fileName;
      }
    }
    return undefined;
  }

  /**
   * Verify / Compile command.
   */
  public async verifyCommand(): Promise<boolean> {
    const cliPath = await this.getOrPromptCli();
    if (!cliPath) return false;

    let sketchPath = this.getActiveSketchPath();
    if (!sketchPath) {
      const files = await vscode.workspace.findFiles('**/*.ino', '**/node_modules/**', 10);
      if (files.length === 0) {
        vscode.window.showErrorMessage('No Arduino sketch (.ino) found in workspace.');
        return false;
      }
      const picked = await vscode.window.showQuickPick(
        files.map((f) => f.fsPath),
        { placeHolder: 'Select sketch (.ino) to compile' }
      );
      if (!picked) return false;
      sketchPath = picked;
    }

    if (!this.currentBoard) {
      await this.selectBoardCommand();
      if (!this.currentBoard) return false;
    }

    const fqbn = this.currentBoard.fqbn;
    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`[E-IDE Arduino] Compiling ${path.basename(sketchPath)} for ${fqbn}...`);

    this.diagnosticCollection.clear();

    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      const result = await compileSketch(cliPath, sketchPath, fqbn, {
        signal: controller.signal,
        onStdout: (data) => this.outputChannel.append(data),
        onStderr: (data) => this.outputChannel.append(data),
      });

      // Update diagnostics in Problems panel
      this.applyDiagnostics(sketchPath, result.diagnostics);

      if (result.success) {
        let sizeInfo = '';
        if (result.binarySize !== undefined) {
          const binKb = (result.binarySize / 1024).toFixed(1);
          const maxKb = result.maxBinarySize ? (result.maxBinarySize / 1024).toFixed(1) : '?';
          sizeInfo = `Flash: ${binKb} KB / ${maxKb} KB`;
        }
        this.outputChannel.appendLine(`[E-IDE Arduino] Compilation successful! ${sizeInfo} (${result.durationMs}ms)`);
        vscode.window.setStatusBarMessage(`$(check) Arduino: Compilation successful (${result.durationMs}ms)`, 4000);
        return true;
      } else {
        this.outputChannel.appendLine(`[E-IDE Arduino] Compilation failed: ${result.error || 'Syntax or build error'}`);
        vscode.window.showErrorMessage(`Arduino compilation failed: ${result.error || 'Check Problems panel.'}`);
        return false;
      }
    } catch (err: any) {
      this.outputChannel.appendLine(`[E-IDE Arduino] Error: ${err.message || String(err)}`);
      return false;
    } finally {
      this.activeAbortController = undefined;
    }
  }

  /**
   * Upload command: verifies sketch, releases serial port, uploads firmware,
   * and automatically reconnects serial monitor.
   */
  public async uploadCommand(): Promise<boolean> {
    const cliPath = await this.getOrPromptCli();
    if (!cliPath) return false;

    let sketchPath = this.getActiveSketchPath();
    if (!sketchPath) {
      vscode.window.showErrorMessage('No active Arduino sketch (.ino) to upload.');
      return false;
    }

    if (!this.currentBoard) {
      await this.selectBoardCommand();
      if (!this.currentBoard) return false;
    }

    if (!this.currentPort) {
      await this.selectPortCommand();
      if (!this.currentPort) return false;
    }

    const fqbn = this.currentBoard.fqbn;
    const port = this.currentPort;

    // Confirm upload to physical hardware
    const confirm = await vscode.window.showWarningMessage(
      `Upload firmware to ${port} (${this.currentBoard.name})?`,
      { modal: true },
      'Upload',
      'Cancel'
    );
    if (confirm !== 'Upload') {
      return false;
    }

    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`[E-IDE Arduino] Starting upload to ${port} (${fqbn})...`);

    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      // Compile first
      this.outputChannel.appendLine(`[E-IDE Arduino] Verifying sketch before upload...`);
      const compResult = await compileSketch(cliPath, sketchPath, fqbn, {
        signal: controller.signal,
        onStdout: (data) => this.outputChannel.append(data),
        onStderr: (data) => this.outputChannel.append(data),
      });

      this.applyDiagnostics(sketchPath, compResult.diagnostics);
      if (!compResult.success) {
        this.outputChannel.appendLine(`[E-IDE Arduino] Upload aborted due to compilation errors.`);
        vscode.window.showErrorMessage('Upload aborted: compilation failed. See Problems panel.');
        return false;
      }

      // Upload with automatic serial port release & reconnection
      const uploadSuccess = await SerialPortCoordinator.getInstance().withPortReleased(port, async () => {
        this.outputChannel.appendLine(`[E-IDE Arduino] Port ${port} released. Uploading...`);
        const result = await uploadSketch(cliPath, sketchPath, fqbn, port, {
          signal: controller.signal,
          onStdout: (data) => this.outputChannel.append(data),
          onStderr: (data) => this.outputChannel.append(data),
        });

        if (result.success) {
          this.outputChannel.appendLine(`[E-IDE Arduino] Upload completed successfully! (${result.durationMs}ms)`);
          vscode.window.showInformationMessage(`Arduino upload successful on ${port}!`);
          return true;
        } else {
          this.outputChannel.appendLine(`[E-IDE Arduino] Upload failed: ${result.error}`);
          vscode.window.showErrorMessage(`Arduino upload failed: ${result.error}`);
          return false;
        }
      });

      return uploadSuccess;
    } catch (err: any) {
      this.outputChannel.appendLine(`[E-IDE Arduino] Error during upload: ${err.message || String(err)}`);
      return false;
    } finally {
      this.activeAbortController = undefined;
    }
  }

  /**
   * Board selector command.
   */
  public async selectBoardCommand(): Promise<BoardInfo | undefined> {
    const cliPath = await this.getOrPromptCli();
    if (!cliPath) return undefined;

    // Fetch detected boards from ports, and all installed boards
    const { detected, allBoards } = await listBoards(cliPath).catch(() => ({ detected: [], allBoards: [] }));

    const items: Array<vscode.QuickPickItem & { board: BoardInfo }> = [];

    // Detected boards first
    for (const portInfo of detected) {
      if (portInfo.boards && portInfo.boards.length > 0) {
        for (const b of portInfo.boards) {
          items.push({
            label: `$(plug) ${b.name}`,
            description: `Detected on ${portInfo.address} (${b.fqbn})`,
            board: b,
          });
        }
      }
    }

    // Installed/known boards
    for (const b of allBoards) {
      // Don't duplicate if already listed under connected
      if (!items.some((i) => i.board.fqbn === b.fqbn)) {
        items.push({
          label: `$(circuit-board) ${b.name}`,
          description: b.fqbn,
          board: b,
        });
      }
    }

    if (items.length === 0) {
      items.push({
        label: '$(circuit-board) Arduino Uno',
        description: 'arduino:avr:uno',
        board: { name: 'Arduino Uno', fqbn: 'arduino:avr:uno' },
      });
      items.push({
        label: '$(circuit-board) Arduino Nano',
        description: 'arduino:avr:nano',
        board: { name: 'Arduino Nano', fqbn: 'arduino:avr:nano' },
      });
      items.push({
        label: '$(circuit-board) ESP32 Dev Module',
        description: 'esp32:esp32:esp32',
        board: { name: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32' },
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select Arduino Board (FQBN)',
      matchOnDescription: true,
    });

    if (picked) {
      this.setBoard(picked.board);
      return picked.board;
    }
    return undefined;
  }

  /**
   * Port selector command.
   */
  public async selectPortCommand(): Promise<string | undefined> {
    const cliPath = await this.getOrPromptCli();
    let ports: ConnectedBoardPort[] = [];
    if (cliPath) {
      const res = await listBoards(cliPath).catch(() => ({ detected: [], allBoards: [] }));
      ports = res.detected;
    }

    const items: Array<vscode.QuickPickItem & { port?: string }> = [];
    for (const p of ports) {
      const boardDesc = p.boards && p.boards.length > 0 ? p.boards.map((b) => b.name).join(', ') : 'Serial Device';
      items.push({
        label: `$(plug) ${p.address}`,
        description: `${boardDesc} (${p.label || p.protocol})`,
        port: p.address,
      });
    }

    items.push({
      label: '$(edit) Enter port manually...',
      description: 'e.g. COM3 or /dev/ttyUSB0',
      port: undefined,
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select Serial Port',
    });

    if (!picked) return undefined;

    let selectedPort = picked.port;
    if (!selectedPort) {
      selectedPort = await vscode.window.showInputBox({
        prompt: 'Enter Serial Port (e.g. COM3, /dev/ttyACM0)',
        value: this.currentPort || 'COM3',
      });
    }

    if (selectedPort) {
      this.setPort(selectedPort);
      // If serial panel is open, inform it of port change
      if (this.serialPanel) {
        this.postToSerialWebview(this.serialPanel, { type: 'setPort', port: selectedPort });
      }
      return selectedPort;
    }
    return undefined;
  }

  /**
   * Opens or focuses the Serial Monitor & Plotter webview.
   */
  public openSerialCommand(): void {
    if (this.serialPanel) {
      this.serialPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'eide.arduinoSerial',
      `Arduino Serial (${this.currentPort || 'No Port'})`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );
    this.serialPanel = panel;

    panel.webview.html = this.getSerialWebviewHtml(panel.webview);

    if (TestHook.isEnabled()) {
      this.serialTestHookHandle = TestHook.register(
        'eide.arduinoSerial',
        vscode.Uri.file('eide-arduino-serial'),
        panel.webview,
        async (msg) => this.handleSerialWebviewMessage(panel, msg)
      );
    }

    panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleSerialWebviewMessage(panel, msg);
    });

    panel.onDidDispose(() => {
      this.stopSerialSession();
      this.serialTestHookHandle?.dispose();
      this.serialTestHookHandle = undefined;
      this.serialPanel = undefined;
    });

    // Auto-connect if port is known
    if (this.currentPort) {
      this.startSerialSession(panel, this.currentPort, this.currentBaud);
    }
  }

  private postToSerialWebview(panel: vscode.WebviewPanel, msg: any): void {
    this.serialTestHookHandle?.recordPostMessage(msg);
    try {
      panel.webview.postMessage(msg);
    } catch {}
  }

  private async handleSerialWebviewMessage(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        this.postToSerialWebview(panel, {
          type: 'status',
          connected: this.serialSession?.isRunning() || false,
          port: this.currentPort || '',
          baud: this.currentBaud,
        });
        break;

      case 'startMonitor': {
        const port = msg.port || this.currentPort;
        const baud = msg.baud || this.currentBaud;
        if (!port) {
          vscode.window.showWarningMessage('Please select a serial port first.');
          return;
        }
        await this.startSerialSession(panel, port, baud);
        break;
      }

      case 'stopMonitor':
        await this.stopSerialSession();
        this.postToSerialWebview(panel, {
          type: 'status',
          connected: false,
          port: this.currentPort,
          baud: this.currentBaud,
        });
        break;

      case 'changeBaud': {
        const newBaud = msg.baud;
        if (newBaud && newBaud !== this.currentBaud) {
          this.currentBaud = newBaud;
          if (this.serialSession && this.serialSession.isRunning() && this.currentPort) {
            await this.startSerialSession(panel, this.currentPort, this.currentBaud);
          }
        }
        break;
      }

      case 'sendSerial':
        if (this.serialSession && this.serialSession.isRunning()) {
          try {
            await this.serialSession.write(msg.text || '');
          } catch (e: any) {
            this.postToSerialWebview(panel, { type: 'error', message: e.message || String(e) });
          }
        }
        break;
    }
  }

  private async startSerialSession(panel: vscode.WebviewPanel, port: string, baud: number): Promise<void> {
    const cliPath = await this.getOrPromptCli();
    if (!cliPath) return;

    await this.stopSerialSession();

    this.currentPort = port;
    this.currentBaud = baud;
    panel.title = `Arduino Serial (${port})`;

    const session = new SerialMonitorSession(cliPath, port, baud);
    this.serialSession = session;
    SerialPortCoordinator.getInstance().register(session);

    session.on('data', (d) => {
      this.postToSerialWebview(panel, {
        type: 'serialData',
        line: d.line,
        timestamp: d.timestamp,
        numbers: d.numbers,
      });
    });

    session.on('error', (err) => {
      this.postToSerialWebview(panel, {
        type: 'error',
        message: err.message,
      });
    });

    session.on('close', () => {
      this.postToSerialWebview(panel, {
        type: 'status',
        connected: false,
        port,
        baud,
      });
    });

    try {
      await session.start();
      this.postToSerialWebview(panel, {
        type: 'status',
        connected: true,
        port,
        baud,
      });
    } catch (e: any) {
      this.postToSerialWebview(panel, {
        type: 'error',
        message: `Failed to open serial monitor: ${e.message}`,
      });
    }
  }

  private async stopSerialSession(): Promise<void> {
    if (this.serialSession) {
      SerialPortCoordinator.getInstance().unregister(this.serialSession.getPort());
      await this.serialSession.stop();
      this.serialSession = undefined;
    }
  }

  /**
   * Applies compiler diagnostics to VS Code Problems panel.
   */
  private applyDiagnostics(sketchPath: string, diagnostics: ArduinoDiagnostic[]): void {
    const diagMap = new Map<string, vscode.Diagnostic[]>();

    for (const diag of diagnostics) {
      const filePath = diag.file && path.isAbsolute(diag.file) ? diag.file : sketchPath;
      const fileUri = vscode.Uri.file(filePath).toString();

      const line = Math.max(0, diag.line - 1);
      const col = Math.max(0, diag.column - 1);
      const range = new vscode.Range(line, col, line, col + 10);

      let severity = vscode.DiagnosticSeverity.Error;
      if (diag.severity === 'warning') severity = vscode.DiagnosticSeverity.Warning;
      else if (diag.severity === 'info') severity = vscode.DiagnosticSeverity.Information;

      const vscodeDiag = new vscode.Diagnostic(range, diag.message, severity);
      vscodeDiag.source = 'arduino';

      const existing = diagMap.get(fileUri) || [];
      existing.push(vscodeDiag);
      diagMap.set(fileUri, existing);
    }

    this.diagnosticCollection.clear();
    for (const [uriStr, diags] of diagMap.entries()) {
      this.diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
    }
  }

  private getSerialWebviewHtml(webview: vscode.Webview): string {
    const sharedCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'shared.css'));
    const arduinoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'arduino.css'));
    const waveformJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'waveform.js'));
    const arduinoJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'arduino.js'));

    const nonce = String(Date.now() + Math.random());

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Arduino Serial Monitor & Plotter</title>
  <link rel="stylesheet" href="${sharedCssUri}">
  <link rel="stylesheet" href="${arduinoCssUri}">
</head>
<body>
  <div class="arduino-toolbar">
    <div class="view-toggle">
      <button id="tab-split" class="active">Split</button>
      <button id="tab-monitor">Monitor</button>
      <button id="tab-plotter">Plotter</button>
    </div>

    <label for="baud-select">Baud:</label>
    <select id="baud-select">
      <option value="9600">9600</option>
      <option value="19200">19200</option>
      <option value="38400">38400</option>
      <option value="57600">57600</option>
      <option value="74880">74880</option>
      <option value="115200" selected>115200</option>
      <option value="230400">230400</option>
      <option value="250000">250000</option>
      <option value="500000">500000</option>
      <option value="1000000">1000000</option>
      <option value="2000000">2000000</option>
    </select>

    <button id="btn-toggle-connect">Disconnect</button>
    <button id="btn-clear" class="secondary">Clear</button>

    <label><input type="checkbox" id="chk-autoscroll" checked> Autoscroll</label>
    <label><input type="checkbox" id="chk-timestamps"> Timestamps</label>

    <div id="status-pill" class="status-pill disconnected">
      <span class="status-dot"></span>
      <span id="status-text">Disconnected</span>
    </div>
  </div>

  <div id="main-view" class="arduino-main-view layout-split">
    <!-- Serial Monitor Section -->
    <div class="monitor-panel">
      <div id="monitor-log" class="monitor-log"></div>
      <div class="serial-input-row">
        <input type="text" id="serial-input" placeholder="Type a message and press Enter or Send...">
        <select id="line-ending-select">
          <option value="\\n" selected>Newline (\\n)</option>
          <option value="\\r">Carriage return (\\r)</option>
          <option value="\\r\\n">Both (\\r\\n)</option>
          <option value="none">No line ending</option>
        </select>
        <button id="btn-send">Send</button>
      </div>
    </div>

    <!-- Live Plotter Section -->
    <div class="plotter-panel" id="plotter-container">
      <div class="waveform-header">
        <div class="waveform-title-group">
          <span id="plot-title" class="plot-title">Live Serial Plotter</span>
          <div id="traces-legend" class="traces-legend"></div>
        </div>
        <div id="measurements-bar" class="measurements-bar"></div>
      </div>
      <div class="waveform-canvas-box">
        <canvas id="waveform-canvas"></canvas>
        <div id="cursor-tooltip"></div>
        <div id="waveform-empty-msg">Waiting for numeric serial data (e.g. "1.23, 4.56")...</div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${waveformJsUri}"></script>
  <script nonce="${nonce}" src="${arduinoJsUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
    this.stopSerialSession();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
