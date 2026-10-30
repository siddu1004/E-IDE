// Webview panel for displaying MATLAB exported figures with before/after comparison.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class MatlabFiguresPanel {
  public static currentPanel: MatlabFiguresPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private currentFigures: string[] = [];
  private previousFigures: string[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.ViewColumn.Beside;

    if (MatlabFiguresPanel.currentPanel) {
      MatlabFiguresPanel.currentPanel.panel.reveal(column);
      return MatlabFiguresPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'eide.matlabFigures',
      'MATLAB Figures',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.file(process.env.TEMP || 'C:\\Windows\\Temp'),
        ],
      }
    );

    MatlabFiguresPanel.currentPanel = new MatlabFiguresPanel(panel, extensionUri);
    return MatlabFiguresPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.onDidDispose(() => {
      MatlabFiguresPanel.currentPanel = undefined;
    });

    this.panel.webview.html = this.getHtml();
  }

  public updateFigures(newFigures: string[]) {
    // Keep previous set one step back for comparison
    this.previousFigures = [...this.currentFigures];
    this.currentFigures = [...newFigures];

    // Convert file paths to webview URIs or base64 data URIs
    const currentData = this.currentFigures.map(f => this.fileToDataUri(f));
    const previousData = this.previousFigures.map(f => this.fileToDataUri(f));

    this.panel.webview.postMessage({
      type: 'updateFigures',
      current: currentData,
      previous: previousData,
    });
  }

  private fileToDataUri(filePath: string): { path: string; dataUri: string } {
    try {
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === '.svg' ? 'image/svg+xml' : 'image/png';
        const base64 = fs.readFileSync(filePath).toString('base64');
        return {
          path: filePath,
          dataUri: `data:${mime};base64,${base64}`,
        };
      }
    } catch (err) {
      console.error('Error reading figure file:', err);
    }
    return { path: filePath, dataUri: '' };
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'matlabFigures.css'));
    const sharedStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'shared.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'matlabFigures.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MATLAB Figures</title>
  <link rel="stylesheet" href="${sharedStyleUri}">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="header">
    <div class="title">MATLAB Figures</div>
    <div class="controls">
      <label class="compare-toggle">
        <input type="checkbox" id="compare-checkbox">
        <span>Compare with previous run</span>
      </label>
    </div>
  </div>
  <div id="figures-container" class="figures-container">
    <div class="empty-state">No figures generated yet. Run a script with plot() or figure() to display figures.</div>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
