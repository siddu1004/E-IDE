// Custom Readonly Editor Provider for Simulink models (*.slx).
// Handles fast offline model visualization, bridge edits, disk-watch diff highlights,
// and simulation runs with race-free abort controller.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activeSimulationWebviews, registerEditorWebview, undoAgentChange } from '../agent/tools';
import { MatlabBridge, BridgeStatus } from '../matlab/matlabBridge';
import { TestHook } from '../testHook';
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

    let isDisposed = false;
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

    const testHookHandle = TestHook.register(
      SlxEditorProvider.viewType,
      document.uri,
      webview,
      async (msg) => {
        await handleMessage(msg);
      }
    );

    const safePostMessage = (msg: any) => {
      if (isDisposed) return;
      testHookHandle?.recordPostMessage(msg);
      try {
        return webview.postMessage(msg);
      } catch {}
    };

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
    const webviewReg = registerEditorWebview(fsPath, webview);
    panel.onDidDispose(() => {
      isDisposed = true;
      webviewReg.dispose();
      if (SlxEditorProvider.activeEditor === editorController) {
        SlxEditorProvider.activeEditor = undefined;
      }
      if (autoSimTimer) clearTimeout(autoSimTimer);
      if (abortController) abortController.abort();
      testHookHandle?.dispose();
    });

    // Subscribe to bridge status updates
    const unbindStatus = this.bridge.onStatusChange((status: BridgeStatus) => {
      safePostMessage({ type: 'bridgeStatus', status });
    });
    panel.onDidDispose(unbindStatus);

    const pushModel = (changesOverride?: any) => {
      if (isDisposed) return;
      try {
        if (!fs.existsSync(fsPath)) return;
        const modelName = path.basename(fsPath, '.slx');
        let buf = fs.readFileSync(fsPath);
        if (buf.length === 0) {
          throw new Error('File is empty (0 bytes)');
        }

        // Retry reading if file is being written by external process (e.g. MATLAB save_system)
        let nextModel: SlxModel | undefined;
        let lastErr: any;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            buf = fs.readFileSync(fsPath);
            nextModel = parseSlx(buf, modelName);
            if (nextModel.uuid || nextModel.rootSystem.blocks.length > 0 || Object.keys(nextModel.subsystems).length > 0) {
              lastErr = undefined;
              break;
            }
          } catch (e) {
            lastErr = e;
            const end = Date.now() + 100;
            while (Date.now() < end) {}
          }
        }

        if (lastErr) {
          throw lastErr;
        }

        if (!nextModel || (!nextModel.uuid && nextModel.rootSystem.blocks.length === 0 && Object.keys(nextModel.subsystems).length === 0)) {
          throw new Error('File is not a valid .slx archive or contains no model definition');
        }
        const changes = changesOverride || (lastModel ? diffSlxModels(lastModel, nextModel) : undefined);
        lastModel = nextModel;

        safePostMessage({
          type: 'update',
          model: nextModel,
          changes,
          fileName: path.basename(fsPath),
        });
      } catch (err: any) {
        safePostMessage({
          type: 'error',
          error: `Unable to open Simulink model: ${err.message}`,
          fileName: path.basename(fsPath),
        });
      }
    };

    const triggerSimulation = async (stopTime?: number) => {
      if (isDisposed) return;
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
          if (!isDisposed) {
            vscode.window.showErrorMessage(`Failed to start MATLAB: ${err.message}`);
          }
          return;
        }
      }

      if (abortController) abortController.abort();
      // Keep this run's own controller: abortController may point at a newer run by the time we resume.
      const controller = new AbortController();
      abortController = controller;

      try {
        const simRes = await this.bridge.simulate(fsPath, stopTime);
        if (isDisposed || controller.signal.aborted) return;

        if (simRes && simRes.signals.length > 0) {
          const firstSig = simRes.signals[0];
          const time = firstSig.time;
          const seriesObj: Record<string, number[]> = {};
          const variables = ['time'];

          for (const s of simRes.signals) {
            seriesObj[s.name] = s.values;
            variables.push(s.name);
          }

          const currentPlot = {
            plotName: 'Simulink Simulation',
            variables,
            x: time,
            series: seriesObj,
          };

          safePostMessage({
            type: 'simulationResult',
            current: currentPlot,
            previous: previousPlot,
            success: true,
          });

          previousPlot = currentPlot;
        } else {
          safePostMessage({
            type: 'simulationResult',
            current: { plotName: 'Simulink Simulation', variables: ['time'], x: [], series: {} },
            previous: previousPlot,
            success: false,
          });
          vscode.window.showWarningMessage('Simulation completed but no signals were logged. Click a signal line to enable logging.');
        }
      } catch (err: any) {
        if (!isDisposed && !controller.signal.aborted) {
          vscode.window.showErrorMessage(`Simulink simulation failed: ${err.message}`);
        }
      }
    };

    // Watch file on disk for external saves from Simulink or agent
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(fsPath), path.basename(fsPath))
    );
    let nodeFsWatcher: fs.FSWatcher | undefined;
    try {
      nodeFsWatcher = fs.watch(fsPath, () => onFileChanged());
    } catch {}

    const onFileChanged = () => {
      if (isDisposed) return;
      try {
        if (!fs.existsSync(fsPath)) return;
        const currentMtime = fs.statSync(fsPath).mtimeMs;
        if (currentMtime !== lastKnownMtime) {
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
    panel.onDidDispose(() => {
      watcher.dispose();
      try {
        nodeFsWatcher?.close();
      } catch {}
    });

    // Message handler from webview
    const handleMessage = async (msg: any) => {
      if (isDisposed) return;
      switch (msg?.type) {
        case 'ready':
          safePostMessage({ type: 'bridgeStatus', status: this.bridge.getStatus() });
          pushModel();
          break;

        case 'simulate':
          await triggerSimulation(msg.stopTime);
          break;

        case 'setParam':
          try {
            if (this.bridge.getStatus() === 'off') {
              await this.bridge.start();
            }
            await this.bridge.setParam(fsPath, msg.block, msg.param, msg.value);
            pushModel();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to set parameter: ${err.message}`);
          }
          break;

        case 'enableLogging':
          try {
            if (this.bridge.getStatus() === 'off') {
              await this.bridge.start();
            }
            // Enable signal logging on specified block port
            await this.bridge.enableLogging(fsPath, msg.line.srcBlock, msg.line.srcPort || 1);
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

        case 'openAsText':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;

        case 'undoAgent':
          await undoAgentChange(fsPath);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:;">
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
    <div id="banner"></div>
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
