import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findLtspice } from '../ltspice/ltspiceRunner';
import { findKicadCli, runErc } from './kicadCli';
import { simulateKicadSchematic } from './kicadSimulation';
import { diffSchematics, KicadSchematic, parseKicadSch, propertyEdit } from './schParser';

export class KicadEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'eide.kicadSchematic';
  private static activeEditor:
    | {
        runSimulation: () => Promise<void>;
        runErc: () => Promise<void>;
      }
    | undefined;

  private readonly ercDiagnostics: vscode.DiagnosticCollection;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.ercDiagnostics = vscode.languages.createDiagnosticCollection('kicad-erc');
    context.subscriptions.push(this.ercDiagnostics);
  }

  static runSimulationOnActive(): void {
    if (KicadEditorProvider.activeEditor) {
      KicadEditorProvider.activeEditor.runSimulation();
    } else {
      vscode.window.showInformationMessage('No active KiCad schematic editor found.');
    }
  }

  static runErcOnActive(): void {
    if (KicadEditorProvider.activeEditor) {
      KicadEditorProvider.activeEditor.runErc();
    } else {
      vscode.window.showInformationMessage('No active KiCad schematic editor found.');
    }
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.html(webview);

    let last: KicadSchematic | undefined;
    let autoSimTimer: NodeJS.Timeout | undefined;
    let abortController: AbortController | undefined;
    let previousRaw: any | undefined;
    let lastKnownMtime = 0;

    try {
      if (fs.existsSync(document.uri.fsPath)) {
        lastKnownMtime = fs.statSync(document.uri.fsPath).mtimeMs;
      }
    } catch {}

    const editorController = {
      runSimulation: () => triggerSimulation(),
      runErc: () => triggerErc(),
    };

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        KicadEditorProvider.activeEditor = editorController;
      } else if (KicadEditorProvider.activeEditor === editorController) {
        KicadEditorProvider.activeEditor = undefined;
      }
    });

    if (panel.active) {
      KicadEditorProvider.activeEditor = editorController;
    }

    const push = (changesToReport?: any) => {
      try {
        const text = document.getText();
        const next = parseKicadSch(text);
        const changes = changesToReport || diffSchematics(last, next);
        last = next;

        // Serialize libSymbols for webview
        const libSymbolsObj: Record<string, any> = {};
        for (const [k, v] of next.libSymbols.entries()) {
          libSymbolsObj[k] = v;
        }

        webview.postMessage({
          type: 'update',
          schematic: {
            ...next,
            libSymbols: libSymbolsObj,
            ast: undefined, // Avoid circular/large AST in postMessage
          },
          changes,
          fileName: path.basename(document.fileName),
        });
        return changes;
      } catch (err: any) {
        console.error('Error parsing KiCad schematic:', err);
      }
    };

    const triggerSimulation = async (changesSummary?: string) => {
      const config = vscode.workspace.getConfiguration('eide');
      const ltspicePath = findLtspice(config.get<string>('ltspice.path'));
      const kicadCliPath = findKicadCli(config.get<string>('kicad.cliPath'));

      if (!ltspicePath) {
        webview.postMessage({
          type: 'simError',
          error: 'LTspice executable not found. Please set eide.ltspice.path.',
        });
        return;
      }
      if (!kicadCliPath) {
        webview.postMessage({
          type: 'simError',
          error: 'kicad-cli not found. Please set eide.kicad.cliPath.',
        });
        return;
      }

      if (abortController) abortController.abort();
      abortController = new AbortController();

      webview.postMessage({ type: 'simStart' });

      try {
        const simRes = await simulateKicadSchematic({
          kicadCliPath,
          ltspicePath,
          schPath: document.uri.fsPath,
          schContent: document.getText(),
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) return;

        let bannerText = '';
        if (simRes.success && simRes.runResult) {
          const dur = (simRes.runResult.durationMs / 1000).toFixed(1);
          bannerText = changesSummary ? `Update: ${changesSummary} · re-simulated in ${dur} s` : `Simulation finished in ${dur} s`;
        }

        webview.postMessage({
          type: 'simulationResult',
          success: simRes.success,
          missingModels: simRes.missingModels,
          current: simRes.runResult?.raw
            ? {
                plotName: simRes.runResult.raw.plotName,
                variables: simRes.runResult.raw.variables,
                x: Array.from(simRes.runResult.raw.x),
                series: Object.fromEntries(
                  Object.entries(simRes.runResult.raw.series).map(([k, v]) => [
                    k,
                    v instanceof Float64Array
                      ? Array.from(v)
                      : { re: Array.from(v.re), im: Array.from(v.im) },
                  ]),
                ),
              }
            : undefined,
          previous: previousRaw,
          bannerText,
          error: simRes.error,
        });

        if (simRes.success && simRes.runResult?.raw) {
          previousRaw = {
            plotName: simRes.runResult.raw.plotName,
            variables: simRes.runResult.raw.variables,
            x: Array.from(simRes.runResult.raw.x),
            series: Object.fromEntries(
              Object.entries(simRes.runResult.raw.series).map(([k, v]) => [
                k,
                v instanceof Float64Array
                  ? Array.from(v)
                  : { re: Array.from(v.re), im: Array.from(v.im) },
              ]),
            ),
          };
        }
      } catch (err: any) {
        webview.postMessage({ type: 'simError', error: err.message });
      }
    };

    const triggerErc = async () => {
      const config = vscode.workspace.getConfiguration('eide');
      const kicadCliPath = findKicadCli(config.get<string>('kicad.cliPath'));
      if (!kicadCliPath) {
        vscode.window.showErrorMessage('kicad-cli not found. Please set eide.kicad.cliPath in settings.');
        return;
      }

      // Save document if dirty
      if (document.isDirty) {
        await document.save();
      }

      const res = await runErc({
        cliPath: kicadCliPath,
        schPath: document.uri.fsPath,
      });

      if (!res.success) {
        vscode.window.showErrorMessage(`ERC failed: ${res.error}`);
        return;
      }

      // Populate VS Code Problems panel with ERC violations
      const diagnostics: vscode.Diagnostic[] = [];
      for (const v of res.report.violations) {
        const severity =
          v.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : v.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Information;

        let targetLine = 0;
        // Attempt to find line corresponding to item in document text
        for (const it of v.items) {
          if (it.description) {
            const firstWord = it.description.split(/\s+/)[1]; // e.g. "R1" or "#PWR1"
            if (firstWord && last) {
              const sym = last.symbols.find((s) => s.ref === firstWord);
              if (sym && sym.properties.Reference) {
                targetLine = Math.max(0, sym.properties.Reference.y); // Line approximation
              }
            }
          }
        }

        const range = new vscode.Range(targetLine, 0, targetLine, 80);
        const diag = new vscode.Diagnostic(range, `[ERC ${v.type}] ${v.description}`, severity);
        diag.source = 'KiCad ERC';
        diagnostics.push(diag);
      }

      this.ercDiagnostics.set(document.uri, diagnostics);
      webview.postMessage({ type: 'ercResult', report: res.report });
    };

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        const changes = push();
        try {
          if (fs.existsSync(document.uri.fsPath)) {
            lastKnownMtime = fs.statSync(document.uri.fsPath).mtimeMs;
          }
        } catch {}

        const config = vscode.workspace.getConfiguration('eide.kicad');
        const autoSim = config.get<boolean>('autoSimulate', false);

        if (autoSim && changes) {
          clearTimeout(autoSimTimer);
          const parts: string[] = [];
          if (changes.symbols?.length) parts.push(`changed ${changes.symbols.join(', ')}`);
          if (changes.wires?.length) parts.push(`${changes.wires.length} wire(s) added`);
          const summary = parts.join(' · ');

          autoSimTimer = setTimeout(() => {
            triggerSimulation(summary);
          }, 800);
        }
      }
    });

    panel.onDidDispose(() => {
      sub.dispose();
      clearTimeout(autoSimTimer);
      if (abortController) abortController.abort();
      this.ercDiagnostics.delete(document.uri);
      if (KicadEditorProvider.activeEditor === editorController) {
        KicadEditorProvider.activeEditor = undefined;
      }
    });

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          push();
          break;
        case 'setProperty':
          await this.setProperty(document, String(msg.ref), String(msg.key), String(msg.value), lastKnownMtime);
          break;
        case 'runSimulation':
          await triggerSimulation();
          break;
        case 'runErc':
          await triggerErc();
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

  private async setProperty(
    document: vscode.TextDocument,
    ref: string,
    key: string,
    value: string,
    lastKnownMtime: number,
  ) {
    // Safety check: verify file on disk hasn't been modified externally (e.g. by KiCad GUI)
    try {
      if (fs.existsSync(document.uri.fsPath)) {
        const currentMtime = fs.statSync(document.uri.fsPath).mtimeMs;
        if (lastKnownMtime > 0 && currentMtime > lastKnownMtime + 500) {
          vscode.window.showWarningMessage(
            `'${path.basename(document.fileName)}' was modified externally by KiCad. Please reload the document before making edits.`,
          );
          return;
        }
      }
    } catch {}

    const sch = parseKicadSch(document.getText());
    const edit = propertyEdit(sch, ref, key, value, document.getText());
    if (!edit) return;

    const startPos = document.positionAt(edit.start);
    const endPos = document.positionAt(edit.end);

    const we = new vscode.WorkspaceEdit();
    we.replace(document.uri, new vscode.Range(startPos, endPos), edit.text);
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
  <link href="${media('kicad.css')}" rel="stylesheet">
  <title>KiCad Schematic</title>
</head>
<body>
  <header>
    <span id="file-name"></span>
    <span id="banner"></span>
    <div class="header-actions">
      <span id="sim-spinner" class="spinner hidden"></span>
      <button id="run-erc">Run ERC</button>
      <button id="run-sim" class="primary">Simulate in LTspice</button>
      <button id="as-text">Open as text</button>
    </div>
  </header>
  <main>
    <div id="schematic-container">
      <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
      <aside>
        <h2>Components</h2>
        <table id="components"><thead><tr><th>Ref</th><th>Value</th><th>Footprint</th></tr></thead><tbody></tbody></table>
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
        <div id="waveform-empty-msg">Click "Simulate in LTspice" to view waveforms</div>
      </div>
    </div>
  </main>
  <script nonce="${nonce}" src="${media('waveform.js')}"></script>
  <script nonce="${nonce}" src="${media('kicad.js')}"></script>
</body>
</html>`;
  }
}
