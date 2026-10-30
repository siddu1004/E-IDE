import * as path from 'path';
import * as vscode from 'vscode';
import { AscSchematic, diffSchematics, parseAsc, symbolAttrEdit } from './ascParser';
import { findLtspice, runLtspiceSimulation, SimulationRunResult } from './ltspiceRunner';

// Visual editor for .asc files. The text document stays the source of truth,
// so edits from the user, the agent, or LTspice itself all flow through it.
export class AscEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'eide.ltspiceSchematic';
  private static activeEditor: { runSimulation: (isManual?: boolean) => Promise<void> } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  static runSimulationOnActive(): void {
    if (AscEditorProvider.activeEditor) {
      AscEditorProvider.activeEditor.runSimulation(true);
    } else {
      vscode.window.showInformationMessage('No active LTspice schematic editor found.');
    }
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.html(webview);

    let last: AscSchematic | undefined;
    let autoRunTimer: NodeJS.Timeout | undefined;
    let abortController: AbortController | undefined;
    let previousResult: SimulationRunResult | undefined;

    const editorController = {
      runSimulation: (isManual = false) => triggerSimulation(undefined, isManual),
    };

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        AscEditorProvider.activeEditor = editorController;
      } else if (AscEditorProvider.activeEditor === editorController) {
        AscEditorProvider.activeEditor = undefined;
      }
    });

    if (panel.active) {
      AscEditorProvider.activeEditor = editorController;
    }

    const push = (changesToReport?: any) => {
      const next = parseAsc(document.getText());
      const changes = changesToReport || diffSchematics(last, next);
      last = next;
      webview.postMessage({ type: 'update', schematic: next, changes, fileName: path.basename(document.fileName) });
      return changes;
    };

    const triggerSimulation = async (changesSummary?: string, isManual = false) => {
      const config = vscode.workspace.getConfiguration('eide.ltspice');
      const customPath = config.get<string>('path');
      const timeoutSec = config.get<number>('timeout', 60);

      const exe = findLtspice(customPath);
      if (!exe) {
        webview.postMessage({
          type: 'simError',
          error: 'LTspice executable not found. Please configure eide.ltspice.path in settings.',
        });
        if (isManual) {
          const choice = await vscode.window.showErrorMessage(
            'LTspice executable not found. Please set eide.ltspice.path in settings.',
            'Set Path',
          );
          if (choice === 'Set Path') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'eide.ltspice.path');
          }
        }
        return;
      }

      // Cancel any ongoing run
      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();

      webview.postMessage({ type: 'simStart' });

      try {
        const result = await runLtspiceSimulation({
          executablePath: exe,
          ascPath: document.uri.fsPath,
          ascContent: document.getText(),
          timeoutMs: timeoutSec * 1000,
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) return;

        let bannerText = '';
        if (result.success) {
          const durationStr = (result.durationMs / 1000).toFixed(1);
          if (changesSummary) {
            bannerText = `Update: ${changesSummary} · re-simulated in ${durationStr} s`;
          } else {
            bannerText = `Simulation finished in ${durationStr} s`;
          }
        }

        // Send results (converting TypedArrays to plain numbers or sending structured clone)
        webview.postMessage({
          type: 'simulationResult',
          success: result.success,
          durationMs: result.durationMs,
          current: result.raw
            ? {
                plotName: result.raw.plotName,
                variables: result.raw.variables,
                x: Array.from(result.raw.x),
                series: Object.fromEntries(
                  Object.entries(result.raw.series).map(([k, v]) => [
                    k,
                    v instanceof Float64Array
                      ? Array.from(v)
                      : { re: Array.from(v.re), im: Array.from(v.im) },
                  ]),
                ),
              }
            : undefined,
          previous: previousResult?.raw
            ? {
                plotName: previousResult.raw.plotName,
                variables: previousResult.raw.variables,
                x: Array.from(previousResult.raw.x),
                series: Object.fromEntries(
                  Object.entries(previousResult.raw.series).map(([k, v]) => [
                    k,
                    v instanceof Float64Array
                      ? Array.from(v)
                      : { re: Array.from(v.re), im: Array.from(v.im) },
                  ]),
                ),
              }
            : undefined,
          measurements: result.log.measurements,
          errors: result.log.errors,
          bannerText,
          error: result.error,
        });

        if (result.success) {
          previousResult = result;
        }
      } catch (err: any) {
        webview.postMessage({ type: 'simError', error: err.message });
      }
    };

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        const changes = push();

        const config = vscode.workspace.getConfiguration('eide.ltspice');
        const autoRun = config.get<boolean>('autoRun', true);

        if (autoRun) {
          clearTimeout(autoRunTimer);
          const parts: string[] = [];
          if (changes.symbols?.length) parts.push(`changed ${changes.symbols.join(', ')}`);
          if (changes.removedSymbols?.length) parts.push(`removed ${changes.removedSymbols.join(', ')}`);
          if (changes.wires?.length) parts.push(`${changes.wires.length} wire(s) added`);
          if (changes.texts?.length) parts.push(`${changes.texts.length} directive(s) changed`);
          const summary = parts.join(' · ');

          autoRunTimer = setTimeout(() => {
            triggerSimulation(summary, false);
          }, 800);
        }
      }
    });

    panel.onDidDispose(() => {
      sub.dispose();
      clearTimeout(autoRunTimer);
      if (abortController) abortController.abort();
      if (AscEditorProvider.activeEditor === editorController) {
        AscEditorProvider.activeEditor = undefined;
      }
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready': {
          push();
          const config = vscode.workspace.getConfiguration('eide.ltspice');
          if (config.get<boolean>('autoRun', true)) {
            triggerSimulation(undefined, false);
          }
          break;
        }
        case 'setAttr':
          await this.setAttr(document, String(msg.id), String(msg.key), String(msg.value));
          break;
        case 'runSimulation':
          await triggerSimulation(undefined, true);
          break;
        case 'cancelSimulation':
          if (abortController) abortController.abort();
          break;
        case 'openAsText':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
      }
    });
  }

  private async setAttr(document: vscode.TextDocument, id: string, key: string, value: string) {
    const edit = symbolAttrEdit(parseAsc(document.getText()), id, key, value);
    if (!edit) return;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const we = new vscode.WorkspaceEdit();
    if (!edit.insert) {
      we.replace(document.uri, document.lineAt(edit.line).range, edit.text);
    } else if (edit.line < document.lineCount) {
      we.insert(document.uri, new vscode.Position(edit.line, 0), edit.text + eol);
    } else {
      we.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, eol + edit.text);
    }
    await vscode.workspace.applyEdit(we);
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('schematic.css')}" rel="stylesheet">
  <title>LTspice Schematic</title>
</head>
<body>
  <header>
    <span id="file-name"></span>
    <span id="banner"></span>
    <div class="header-actions">
      <span id="sim-spinner" class="spinner hidden"></span>
      <button id="run-sim" class="primary">Run Simulation</button>
      <button id="as-text">Open as text</button>
    </div>
  </header>
  <main>
    <div id="schematic-container">
      <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
      <aside>
        <h2>Components</h2>
        <table id="components"><thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead><tbody></tbody></table>
        <h2>Directives</h2>
        <ul id="directives"></ul>
      </aside>
    </div>
    <div id="waveform-container">
      <div class="waveform-header">
        <div class="waveform-title-group">
          <span id="plot-title">Waveforms</span>
          <div id="traces-legend" class="traces-legend"></div>
        </div>
        <div id="measurements-bar" class="measurements-bar"></div>
      </div>
      <div class="waveform-canvas-box">
        <canvas id="waveform-canvas"></canvas>
        <div id="cursor-tooltip"></div>
        <div id="waveform-empty-msg">Click "Run Simulation" or a component to view waveforms</div>
      </div>
    </div>
  </main>
  <script nonce="${nonce}" src="${media('schematic.js')}"></script>
</body>
</html>`;
  }
}
