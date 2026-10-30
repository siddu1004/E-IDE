import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findLtspice } from '../ltspice/ltspiceRunner';
import { TestHook } from '../testHook';
import { findKicadCli, runErc } from './kicadCli';
import { simulateKicadSchematic } from './kicadSimulation';
import { diffSchematics, KicadSchematic, parseKicadSch, propertyEdit } from './schParser';
import { registerEditorWebview, undoAgentChange } from '../agent/tools';

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

    let isDisposed = false;
    let last: KicadSchematic | undefined;
    let autoSimTimer: NodeJS.Timeout | undefined;
    let abortController: AbortController | undefined;
    let previousRaw: any | undefined;
    let lastKnownMtime = 0;

    const testHookHandle = TestHook.register(
      KicadEditorProvider.viewType,
      document.uri,
      webview,
      async (msg) => {
        await handleMessage(msg);
      }
    );

    const webviewReg = registerEditorWebview(document.uri.fsPath, webview);

    const safePostMessage = (msg: any) => {
      if (isDisposed) return;
      testHookHandle?.recordPostMessage(msg);
      try {
        return webview.postMessage(msg);
      } catch {}
    };

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
      if (isDisposed) return;
      try {
        const text = document.getText();
        if (text.includes('\0')) {
          throw new Error('File contains binary data');
        }
        if (text.trim().length === 0) {
          throw new Error('File is empty (0 bytes)');
        }
        const next = parseKicadSch(text);
        const changes = changesToReport || diffSchematics(last, next);
        last = next;

        // Serialize libSymbols for webview
        const libSymbolsObj: Record<string, any> = {};
        for (const [k, v] of next.libSymbols.entries()) {
          libSymbolsObj[k] = v;
        }

        safePostMessage({
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
        safePostMessage({
          type: 'error',
          error: `Unable to open KiCad schematic: ${err.message}`,
          fileName: path.basename(document.fileName),
        });
      }
    };

    const triggerSimulation = async (changesSummary?: string) => {
      if (isDisposed) return;
      const config = vscode.workspace.getConfiguration('eide');
      const ltspicePath = findLtspice(config.get<string>('ltspice.path'));
      const kicadCliPath = findKicadCli(config.get<string>('kicad.cliPath'));

      if (!ltspicePath) {
        safePostMessage({
          type: 'simError',
          error: 'LTspice executable not found. Please set eide.ltspice.path.',
        });
        return;
      }
      if (!kicadCliPath) {
        safePostMessage({
          type: 'simError',
          error: 'kicad-cli not found. Please set eide.kicad.cliPath.',
        });
        return;
      }

      if (abortController) abortController.abort();
      // Keep this run's own controller: abortController may point at a newer run by the time we resume.
      const controller = new AbortController();
      abortController = controller;

      safePostMessage({ type: 'simStart' });

      try {
        const simRes = await simulateKicadSchematic({
          kicadCliPath,
          ltspicePath,
          schPath: document.uri.fsPath,
          schContent: document.getText(),
          signal: controller.signal,
        });

        if (isDisposed || controller.signal.aborted) return;

        let bannerText = '';
        if (simRes.success && simRes.runResult) {
          const dur = (simRes.runResult.durationMs / 1000).toFixed(1);
          bannerText = changesSummary ? `Update: ${changesSummary} · re-simulated in ${dur} s` : `Simulation finished in ${dur} s`;
        }

        safePostMessage({
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
        if (!isDisposed && !controller.signal.aborted) {
          safePostMessage({ type: 'simError', error: err.message });
        }
      }
    };

    const triggerErc = async () => {
      if (isDisposed) return;
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

      if (isDisposed) return;

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

        // Every schematic object carries its uuid in the file text, so locate the violation by it.
        const text = document.getText();
        let range = new vscode.Range(0, 0, 0, 0);
        for (const it of v.items) {
          let offset = it.uuid ? text.indexOf(it.uuid) : -1;
          // KiCad assigns fresh uuids to files with invalid ones; fall back to "Symbol U1 Pin 3".
          const ref = /^Symbol (\S+)/.exec(it.description)?.[1];
          if (offset < 0 && ref) offset = text.indexOf(`(property "Reference" "${ref}"`);
          if (offset >= 0) {
            range = document.lineAt(document.positionAt(offset).line).range;
            break;
          }
        }

        const diag = new vscode.Diagnostic(range, `[ERC ${v.type}] ${v.description}`, severity);
        diag.source = 'KiCad ERC';
        diagnostics.push(diag);
      }

      this.ercDiagnostics.set(document.uri, diagnostics);
      safePostMessage({ type: 'ercResult', report: res.report });
    };

    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (isDisposed) return;
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
      isDisposed = true;
      webviewReg.dispose();
      sub.dispose();
      clearTimeout(autoSimTimer);
      if (abortController) abortController.abort();
      this.ercDiagnostics.delete(document.uri);
      if (KicadEditorProvider.activeEditor === editorController) {
        KicadEditorProvider.activeEditor = undefined;
      }
      testHookHandle?.dispose();
    });

    const handleMessage = async (msg: any) => {
      if (isDisposed) return;
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
        case 'undoAgent':
          await undoAgentChange(document.uri.fsPath);
          break;
        case 'snapshotResult':
          if (process.env.EIDE_TEST === '1' && msg.dataUrl) {
            const outDir = path.join(os.tmpdir(), 'eide_screenshots');
            fs.mkdirSync(outDir, { recursive: true });
            const base64Data = msg.dataUrl.replace(/^data:image\/png;base64,/, '');
            fs.writeFileSync(path.join(outDir, `${msg.name}.png`), Buffer.from(base64Data, 'base64'));
            safePostMessage({ type: 'snapshotSaved', name: msg.name });
          }
          break;
      }
    };

    webview.onDidReceiveMessage(handleMessage);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:;">
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
