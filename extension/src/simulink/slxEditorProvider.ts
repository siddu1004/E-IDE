// Custom Readonly Editor Provider for Simulink models (*.slx).
// Handles fast offline model visualization, bridge edits, disk-watch diff highlights,
// and simulation runs with race-free abort controller.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activeSimulationWebviews } from '../agent/tools';
import { MatlabBridge, BridgeStatus } from '../matlab/matlabBridge';
import { diffSlxModels, parseSlx, SlxModel } from './slxParser';

export class SlxDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class SlxEditorProvider implements vscode.CustomReadonlyEditorProvider<SlxDocument> {
  public static readonly viewType = 'eide.simulinkModel';
  public static activeEditor: { simulate: (stopTime?: number) => Promise<void> } | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly bridge: MatlabBridge
  ) {}

  public openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): SlxDocument {
    return new SlxDocument(uri);
  }

  public async resolveCustomEditor(
    document: SlxDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.getHtml(webview);

    let lastModel: SlxModel | undefined;
    let autoSimTimer: NodeJS.Timeout | undefined;
    let abortController: AbortController | undefined;
    let previousPlot: any | undefined;
    let lastKnownMtime = 0;

    const fsPath = document.uri.fsPath;
    try {
      if (fs.existsSync(fsPath)) {
        lastKnownMtime = fs.statSync(fsPath).mtimeMs;
      }
    } catch {}

    // Register active editor controller
    const editorController = {
      simulate: (stopTime?: number) => triggerSimulation(stopTime),
    };

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        SlxEditorProvider.activeEditor = editorController;
      } else if (SlxEditorProvider.activeEditor === editorController) {
        SlxEditorProvider.activeEditor = undefined;
      }
    });

    if (panel.active) {
      SlxEditorProvider.activeEditor = editorController;
    }

    // Register webview for live agent updates
    activeSimulationWebviews.set(fsPath.toLowerCase(), webview);
    panel.onDidDispose(() => {
      activeSimulationWebviews.delete(fsPath.toLowerCase());
      if (SlxEditorProvider.activeEditor === editorController) {
        SlxEditorProvider.activeEditor = undefined;
      }
      if (autoSimTimer) clearTimeout(autoSimTimer);
      if (abortController) abortController.abort();
    });

    // Subscribe to bridge status updates
    const unbindStatus = this.bridge.onStatusChange((status: BridgeStatus) => {
      webview.postMessage({ type: 'bridgeStatus', status });
    });
    panel.onDidDispose(unbindStatus);

    const pushModel = (changesOverride?: any) => {
      try {
        if (!fs.existsSync(fsPath)) return;
        const buf = fs.readFileSync(fsPath);
        const modelName = path.basename(fsPath, '.slx');
        const nextModel = parseSlx(buf, modelName);
        const changes = changesOverride || (lastModel ? diffSlxModels(lastModel, nextModel) : undefined);
        lastModel = nextModel;

        webview.postMessage({
          type: 'update',
          model: nextModel,
          changes,
          fileName: path.basename(fsPath),
        });
      } catch (err) {
        console.error('Error parsing Simulink model:', err);
      }
    };

    const triggerSimulation = async (stopTime?: number) => {
      if (this.bridge.getStatus() === 'off') {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Starting MATLAB session for simulation...',
              cancellable: false,
            },
            async () => {
              await this.bridge.start();
            }
          );
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to start MATLAB: ${err.message}`);
          return;
        }
      }

      if (abortController) abortController.abort();
      // Keep this run's own controller: abortController may point at a newer run by the time we resume.
      const controller = new AbortController();
      abortController = controller;

      try {
        const simRes = await this.bridge.simulate(fsPath, stopTime);
        if (controller.signal.aborted) return;

        if (simRes && simRes.signals.length > 0) {
          const firstSig = simRes.signals[0];
          const time = firstSig.time;
          const seriesObj: Record<string, number[]> = {};
          const variables = ['time'];

          // Signals can have their own time vectors (logsout vs simlog, variable step), so put all on the first one's.
          for (const s of simRes.signals) {
            seriesObj[s.name] = resampleTo(time, s.time, s.values);
            variables.push(s.name);
          }

          const currentPlot = {
            plotName: 'Simulink Simulation',
            variables,
            x: time,
            series: seriesObj,
          };

          webview.postMessage({
            type: 'simulationResult',
            current: currentPlot,
            previous: previousPlot,
            success: true,
          });

          previousPlot = currentPlot;
        } else {
          vscode.window.showWarningMessage('Simulation completed but no signals were logged. Click a signal line to enable logging.');
        }
      } catch (err: any) {
        if (controller.signal.aborted) return;
        vscode.window.showErrorMessage(`Simulink simulation failed: ${err.message}`);
      }
    };

    // Watch file on disk for external saves from Simulink or agent
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(fsPath), path.basename(fsPath))
    );

    const onFileChanged = () => {
      try {
        if (!fs.existsSync(fsPath)) return;
        const currentMtime = fs.statSync(fsPath).mtimeMs;
        if (currentMtime > lastKnownMtime) {
          lastKnownMtime = currentMtime;
          pushModel();

          const config = vscode.workspace.getConfiguration('eide.simulink');
          if (config.get<boolean>('autoSimulate', false)) {
            if (autoSimTimer) clearTimeout(autoSimTimer);
            autoSimTimer = setTimeout(() => {
              triggerSimulation();
            }, 800);
          }
        }
      } catch {}
    };

    watcher.onDidChange(onFileChanged);
    panel.onDidDispose(() => watcher.dispose());

    // Message handler from webview
    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          webview.postMessage({ type: 'bridgeStatus', status: this.bridge.getStatus() });
          pushModel();
          break;

        case 'simulate':
          await triggerSimulation(msg.stopTime);
          break;

        case 'setParam':
          try {
            if (this.bridge.getStatus() === 'off') {
              webview.postMessage({ type: 'error', error: 'Start MATLAB to edit' });
              return;
            }
            await this.bridge.setParam(fsPath, msg.block, msg.param, msg.value);
            // File watcher will detect disk change and refresh model with highlights
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to set parameter: ${err.message}`);
          }
          break;

        case 'enableLogging':
          try {
            if (this.bridge.getStatus() === 'off') {
              vscode.window.showWarningMessage('Start MATLAB to enable signal logging.');
              return;
            }
            await this.bridge.enableLogging(fsPath, String(msg.line.srcBlock), Number(msg.line.srcPort) || 1);
            // Re-simulate to capture newly logged signal
            await triggerSimulation();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to enable logging: ${err.message}`);
          }
          break;

        case 'toggleAutoSimulate':
          await vscode.workspace
            .getConfiguration('eide.simulink')
            .update('autoSimulate', msg.value, vscode.ConfigurationTarget.Global);
          break;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'simulink.css'));
    const sharedStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'shared.css'));
    const waveformScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'waveform.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'simulink.js'));

    const config = vscode.workspace.getConfiguration('eide.simulink');
    const autoSimChecked = config.get<boolean>('autoSimulate', false) ? 'checked' : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Simulink Model</title>
  <link rel="stylesheet" href="${sharedStyleUri}">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <header>
    <div class="title-group">
      <span id="model-name" class="model-name">Simulink Model</span>
      <span id="status-badge" class="status-badge off">MATLAB: off</span>
    </div>
    <div class="actions">
      <label>
        Stop Time:
        <input type="number" id="stop-time-input" value="10" style="width: 50px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); padding:2px;">
      </label>
      <label>
        <input type="checkbox" id="autosim-checkbox" ${autoSimChecked}>
        Live Sim
      </label>
      <button id="simulate-btn">Simulate</button>
    </div>
  </header>
  <main>
    <div id="canvas-container">
      <svg id="diagram-svg"></svg>
    </div>
    <aside>
      <div class="aside-header">Model Parameters</div>
      <div id="aside-content" class="aside-content"></div>
    </aside>
  </main>
  <div id="waveform-panel"></div>
  <script src="${waveformScriptUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function resampleTo(target: number[], t: number[], v: number[]): number[] {
  if (t.length === target.length && t.every((x, i) => x === target[i])) return v;
  const out: number[] = [];
  let j = 0;
  for (const x of target) {
    while (j < t.length - 2 && t[j + 1] < x) j++;
    const t0 = t[j], t1 = t[j + 1] ?? t0;
    const f = t1 > t0 ? Math.min(1, Math.max(0, (x - t0) / (t1 - t0))) : 0;
    out.push(v[j] + f * ((v[j + 1] ?? v[j]) - v[j]));
  }
  return out;
}
