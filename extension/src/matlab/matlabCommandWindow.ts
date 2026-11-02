// In-IDE Interactive MATLAB Command Window Webview Panel.
// Executes MATLAB code, commands, and scripts live through the headless bridge without opening external desktop windows.

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MatlabBridge, BridgeStatus } from './matlabBridge';
import { formatWelcomeBanner } from './matlabConsolePure';
import { MatlabFiguresPanel } from './matlabFiguresPanel';

export class MatlabCommandWindowPanel implements vscode.Disposable {
  public static currentPanel: MatlabCommandWindowPanel | undefined;
  public static readonly viewType = 'eide.matlabCommandWindow';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly bridge: MatlabBridge;
  private disposables: vscode.Disposable[] = [];
  private isDisposed = false;

  public static createOrShow(extensionUri: vscode.Uri, bridge: MatlabBridge): MatlabCommandWindowPanel {
    const column = vscode.ViewColumn.Beside;

    if (MatlabCommandWindowPanel.currentPanel) {
      MatlabCommandWindowPanel.currentPanel.panel.reveal(column);
      return MatlabCommandWindowPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      MatlabCommandWindowPanel.viewType,
      'MATLAB Command Window',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    panel.iconPath = new vscode.ThemeIcon('terminal');
    MatlabCommandWindowPanel.currentPanel = new MatlabCommandWindowPanel(panel, extensionUri, bridge);
    return MatlabCommandWindowPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, bridge: MatlabBridge) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.bridge = bridge;

    this.panel.webview.html = this.getHtml();

    const statusUnbind = this.bridge.onStatusChange((status: BridgeStatus) => {
      this.postMessage({ type: 'status', status });
    });
    this.disposables.push(new vscode.Disposable(statusUnbind));

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.type) {
          case 'ready':
            this.postMessage({
              type: 'output',
              text: formatWelcomeBanner(),
              kind: 'system',
            });
            this.postMessage({
              type: 'status',
              status: this.bridge.getStatus(),
            });
            break;

          case 'eval':
            await this.handleEval(msg.command);
            break;

          case 'quickAction':
            await this.handleQuickAction(msg.action);
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private postMessage(msg: any): void {
    if (this.isDisposed) return;
    try {
      this.panel.webview.postMessage(msg);
    } catch {}
  }

  private async ensureBridgeReady(): Promise<boolean> {
    if (this.bridge.getStatus() === 'ready' || this.bridge.getStatus() === 'busy') {
      return true;
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Connecting in-IDE MATLAB session (headless)...',
          cancellable: false,
        },
        async () => {
          await this.bridge.start();
        }
      );
      return true;
    } catch (err: any) {
      this.postMessage({
        type: 'output',
        text: `Error starting MATLAB bridge: ${err.message}`,
        kind: 'error',
      });
      return false;
    }
  }

  public async handleEval(command: string): Promise<void> {
    if (!command.trim()) return;
    const ready = await this.ensureBridgeReady();
    if (!ready) return;

    const exportDir = path.join(os.tmpdir(), 'eide_figures');
    try {
      const res = await this.bridge.evalCommand(command, exportDir);
      if (res.output && res.output.trim()) {
        this.postMessage({ type: 'output', text: res.output.trim() });
      }
      if (res.figures && res.figures.length > 0) {
        this.postMessage({
          type: 'output',
          text: `[Figures exported: ${res.figures.length} figure(s) captured]`,
          kind: 'system',
        });
        const figPanel = MatlabFiguresPanel.createOrShow(this.extensionUri);
        figPanel.updateFigures(res.figures);
      }
    } catch (err: any) {
      this.postMessage({
        type: 'output',
        text: `Error: ${err.message || String(err)}`,
        kind: 'error',
      });
    }
  }

  private async handleQuickAction(action: string): Promise<void> {
    switch (action) {
      case 'who':
      case 'whos':
      case 'clear':
        this.postMessage({ type: 'output', text: '>> ' + action, kind: 'echo' });
        await this.handleEval(action);
        break;
      case 'figures': {
        const figPanel = MatlabFiguresPanel.createOrShow(this.extensionUri);
        figPanel.reveal();
        break;
      }
      case 'restart':
        this.bridge.stop();
        await this.ensureBridgeReady();
        break;
    }
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'matlabCommand.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'matlabCommand.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>MATLAB Command Window</title>
</head>
<body>
  <header>
    <div class="brand">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M1.5 13.5V2.5M1.5 13.5H14.5"/>
        <path d="M3 11L6.5 5.5L9.5 9.5L13.5 3.5"/>
      </svg>
      <span>MATLAB Console (In-IDE)</span>
    </div>
    <div class="status-badge">
      <span id="status-dot" class="status-dot off"></span>
      <span id="status-text">Off</span>
    </div>
    <div class="toolbar-actions">
      <button type="button" class="action-chip" data-action="clc" title="Clear Console (clc)">⌫ Clear</button>
      <button type="button" class="action-chip" data-action="who" title="List workspace variables (who)">👥 Who</button>
      <button type="button" class="action-chip" data-action="whos" title="List variable sizes and types (whos)">📋 Whos</button>
      <button type="button" class="action-chip" data-action="clear" title="Clear all workspace variables (clear)">⚡ Clear Vars</button>
      <button type="button" class="action-chip primary" data-action="figures" title="Show MATLAB Figures Panel">📊 Figures</button>
    </div>
  </header>
  <main id="console"></main>
  <footer>
    <span class="prompt-prefix">&gt;&gt;</span>
    <input type="text" id="command-input" placeholder="Type MATLAB command or expression and press Enter (e.g. a = magic(3); plot(a))" autocomplete="off" spellcheck="false">
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    MatlabCommandWindowPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }
}
