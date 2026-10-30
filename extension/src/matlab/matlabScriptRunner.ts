// MATLAB script execution, CodeLens provider, and output/figure integration.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MatlabBridge } from './matlabBridge';
import { parseMatlabErrors } from './matlabDiagnostics';
import { MatlabFiguresPanel } from './matlabFiguresPanel';

export class MatlabScriptRunner implements vscode.CodeLensProvider {
  private outputChannel: vscode.OutputChannel;
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: MatlabBridge
  ) {
    this.outputChannel = vscode.window.createOutputChannel('E-IDE MATLAB');
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('matlab-errors');
    context.subscriptions.push(this.outputChannel, this.diagnosticCollection);
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    if (document.languageId !== 'matlab' && !document.fileName.endsWith('.m')) {
      return [];
    }

    const topRange = new vscode.Range(0, 0, 0, 0);
    const runCommand: vscode.Command = {
      title: '$(play) Run in MATLAB',
      command: 'eide.runMatlabScript',
      arguments: [document.uri],
      tooltip: 'Execute this script in the persistent MATLAB bridge and export figures',
    };

    return [new vscode.CodeLens(topRange, runCommand)];
  }

  public async runScript(uri?: vscode.Uri): Promise<void> {
    const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || !targetUri.fsPath.endsWith('.m')) {
      vscode.window.showWarningMessage('No MATLAB script (.m) selected to run.');
      return;
    }

    // Save document if dirty
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === targetUri.toString());
    if (doc && doc.isDirty) {
      await doc.save();
    }

    const scriptPath = targetUri.fsPath;
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`\n=== Running ${path.basename(scriptPath)} in MATLAB ===`);

    // Clear diagnostics for this script
    this.diagnosticCollection.delete(targetUri);

    try {
      // Ensure bridge is active
      if (this.bridge.getStatus() === 'off') {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Starting MATLAB session...',
            cancellable: false,
          },
          async () => {
            await this.bridge.start();
          }
        );
      }

      const exportDir = path.join(os.tmpdir(), 'eide_figures');
      if (!require('fs').existsSync(exportDir)) {
        require('fs').mkdirSync(exportDir, { recursive: true });
      }
      const res = await this.bridge.runScript(scriptPath, exportDir);

      if (res.output) {
        this.outputChannel.append(res.output);
      }
      this.outputChannel.appendLine('\n=== Execution completed successfully ===');

      // If figures are present, display them in side panel
      if (res.figures && res.figures.length > 0) {
        const figuresPanel = MatlabFiguresPanel.createOrShow(this.context.extensionUri);
        figuresPanel.updateFigures(res.figures);
      }
    } catch (err: any) {
      const errMsg = err.message || String(err);
      this.outputChannel.appendLine(`\nMATLAB Error: ${errMsg}`);

      // Parse diagnostics and publish to Problems panel
      const parsedErrors = parseMatlabErrors(errMsg, scriptPath);
      const vsDiags: vscode.Diagnostic[] = [];

      for (const diag of parsedErrors) {
        const line = Math.max(0, diag.line - 1);
        const col = Math.max(0, diag.column - 1);
        const range = new vscode.Range(line, col, line, col + 10);
        const vsDiag = new vscode.Diagnostic(
          range,
          diag.message,
          vscode.DiagnosticSeverity.Error
        );
        vsDiag.source = 'MATLAB';
        vsDiags.push(vsDiag);
      }

      if (vsDiags.length > 0) {
        this.diagnosticCollection.set(targetUri, vsDiags);
      }

      vscode.window.showErrorMessage(`MATLAB execution failed: ${errMsg}`);
    }
  }
}
